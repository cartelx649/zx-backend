const mongoose = require('mongoose');
const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const IncomeLedger = require('../models/IncomeLedger');
const ApiError = require('../utils/ApiError');
const { INCOME_TYPES, WITHDRAWAL_STATUS } = require('../config/constants');
const { getActiveCycle } = require('./cycleService');
const { getConfig } = require('./configService');
const { transferPayout, withdrawFromDepositContract } = require('./blockchainService');
const { logAudit } = require('./auditService');

// Both padded ("2026-05") and legacy non-padded ("2026-5") month keys exist in older rows.
function monthKeyVariants(monthKey) {
  const [year, month] = monthKey.split('-');
  const padded = `${year}-${String(Number(month)).padStart(2, '0')}`;
  const nonPadded = `${year}-${Number(month)}`;
  return Array.from(new Set([monthKey, padded, nonPadded]));
}

function isWithdrawalWindowOpen(windowConfig) {
  if (!windowConfig?.isOpen) return false;
  const now = new Date();
  return now.getUTCDate() === windowConfig.dayOfMonth;
}

function assertWithdrawNotPaused(config, type) {
  if (type === INCOME_TYPES.ROI && config?.roiWithdrawPaused) {
    throw new ApiError(423, 'ROI withdrawals are paused by admin', 'ROI_WITHDRAW_PAUSED');
  }
  if ((type === INCOME_TYPES.DIRECT || type === INCOME_TYPES.OVERRIDE) && config?.incomeWithdrawPaused) {
    throw new ApiError(423, 'Income withdrawals are paused by admin', 'INCOME_WITHDRAW_PAUSED');
  }
}

async function requestWithdrawal(userId, requestedAmount) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new ApiError(400, 'User not active', 'USER_INACTIVE');
  const cycle = await getActiveCycle(user._id);
  if (!cycle) throw new ApiError(400, 'No active cycle', 'NO_ACTIVE_CYCLE');
  const config = await getConfig();
  assertWithdrawNotPaused(config, INCOME_TYPES.ROI);
  if (!isWithdrawalWindowOpen(config.withdrawalWindow)) {
    throw new ApiError(400, 'Withdrawal window is closed', 'WITHDRAWAL_WINDOW_CLOSED');
  }
  const remainingCap = Math.max(cycle.incomeCap - cycle.totalEarned, 0);
  const amount = Math.min(requestedAmount, remainingCap);
  if (amount <= 0) throw new ApiError(400, 'Cap reached. Re-topup required.', 'CAP_REACHED');

  return Withdrawal.create({
    userId: user._id,
    cycleId: cycle._id,
    requestedAmount,
    approvedAmount: amount,
    status: 'approved',
  });
}

async function withdrawRoiForMonth(userId, monthKey) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new ApiError(400, 'User not active', 'USER_INACTIVE');
  const cycle = await getActiveCycle(user._id);
  if (!cycle) throw new ApiError(400, 'No active cycle', 'NO_ACTIVE_CYCLE');
  const config = await getConfig();
  assertWithdrawNotPaused(config, INCOME_TYPES.ROI);
  if (!isWithdrawalWindowOpen(config.withdrawalWindow)) {
    throw new ApiError(400, 'Withdrawal window is closed', 'WITHDRAWAL_WINDOW_CLOSED');
  }

  const variants = monthKeyVariants(monthKey);
  const ledgerMatch = {
    beneficiaryUserId: user._id,
    type: INCOME_TYPES.ROI,
    monthKey: { $in: variants },
  };
  const [agg, entries] = await Promise.all([
    IncomeLedger.aggregate([
      { $match: ledgerMatch },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    IncomeLedger.find(ledgerMatch).lean(),
  ]);
  const roiTotal = agg[0]?.total || 0;
  if (roiTotal <= 0) throw new ApiError(400, 'No ROI for this month', 'NO_ROI_FOR_MONTH');

  const existing = await Withdrawal.findOne({
    userId: user._id,
    incomeType: INCOME_TYPES.ROI,
    monthKey,
    status: { $ne: WITHDRAWAL_STATUS.REJECTED },
  });
  if (existing) {
    throw new ApiError(409, 'ROI for this month already withdrawn', 'ROI_MONTH_ALREADY_WITHDRAWN');
  }

  const remainingCap = Math.max(cycle.incomeCap - cycle.totalEarned, 0);
  const amount = Math.min(roiTotal, remainingCap);
  if (amount <= 0) throw new ApiError(400, 'Cap reached. Re-topup required.', 'CAP_REACHED');

  const withdrawal = await Withdrawal.create({
    userId: user._id,
    cycleId: cycle._id,
    requestedAmount: roiTotal,
    approvedAmount: amount,
    status: WITHDRAWAL_STATUS.APPROVED,
    incomeType: INCOME_TYPES.ROI,
    monthKey,
  });

  return { monthKey, roiTotal, withdrawnAmount: amount, entries, withdrawal };
}

async function withdrawViaContract(userId, { walletAddress, amount, type, monthKey }) {
  const SUPPORTED = [INCOME_TYPES.ROI, INCOME_TYPES.DIRECT, INCOME_TYPES.OVERRIDE];
  if (!SUPPORTED.includes(type)) {
    throw new ApiError(400, 'Unsupported income type', 'INVALID_INCOME_TYPE');
  }

  // Admin fee: ROI is charged 5%; direct/override are fee-exempt (user gets the full amount).
  const noFee = type === INCOME_TYPES.DIRECT || type === INCOME_TYPES.OVERRIDE;
  const adminFee = noFee ? 0 : Number(((amount * 5) / 100).toFixed(8));
  const payoutAmountFinal = Number((amount - adminFee).toFixed(8));

  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new ApiError(400, 'User not active', 'USER_INACTIVE');
  if (walletAddress.toLowerCase() !== user.walletAddress) {
    throw new ApiError(403, 'Wallet address does not match authenticated user', 'WALLET_MISMATCH');
  }

  const cycle = await getActiveCycle(user._id);
  if (!cycle) throw new ApiError(400, 'No active cycle', 'NO_ACTIVE_CYCLE');
  const config = await getConfig();
  assertWithdrawNotPaused(config, type);
  // Note: the day-of-month withdrawal window is intentionally not enforced for the
  // contract-based withdrawal endpoint; it can be called any day.

  const existing = await Withdrawal.findOne({
    userId: user._id,
    incomeType: type,
    monthKey,
    status: { $ne: WITHDRAWAL_STATUS.REJECTED },
  });
  if (existing) {
    throw new ApiError(409, `${type} for this month already withdrawn`, 'INCOME_MONTH_ALREADY_WITHDRAWN');
  }

  const variants = monthKeyVariants(monthKey);
  const agg = await IncomeLedger.aggregate([
    { $match: { beneficiaryUserId: user._id, type, monthKey: { $in: variants } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const incomeTotal = agg[0]?.total || 0;
  if (incomeTotal <= 0) throw new ApiError(400, `No ${type} income for this month`, 'NO_INCOME_FOR_MONTH');
  if (amount > incomeTotal) {
    throw new ApiError(400, 'Requested amount exceeds available income', 'AMOUNT_EXCEEDS_INCOME');
  }

  const remainingCap = Math.max(cycle.incomeCap - cycle.totalEarned, 0);
  if (amount > remainingCap) throw new ApiError(400, 'Cap reached. Re-topup required.', 'CAP_REACHED');

  // Create the record first to reserve the month and avoid a double-withdraw race.
  const withdrawal = await Withdrawal.create({
    userId: user._id,
    cycleId: cycle._id,
    requestedAmount: payoutAmountFinal,
    approvedAmount: payoutAmountFinal,
    status: WITHDRAWAL_STATUS.APPROVED,
    incomeType: type,
    monthKey,
  });

  let payout;
  try {
    payout = await withdrawFromDepositContract({ to: user.walletAddress,amount: payoutAmountFinal });
  } catch (err) {
    withdrawal.status = WITHDRAWAL_STATUS.REJECTED;
    withdrawal.rejectionReason = err.message;
    withdrawal.processedAt = new Date();
    await withdrawal.save();
    throw err;
  }

  withdrawal.status = WITHDRAWAL_STATUS.PAID;
  withdrawal.payoutTxHash = payout.txHash;
  withdrawal.processedAt = new Date();
  await withdrawal.save();
  await logAudit({
    actorUserId: user._id,
    action: 'withdrawal.contract_paid',
    entity: 'Withdrawal',
    entityId: String(withdrawal._id),
    meta: { txHash: payout.txHash, monthKey, type, payoutAmountFinal },
  });

  return { monthKey, type, incomeTotal, withdrawnAmount: payoutAmountFinal, txHash: payout.txHash, withdrawal };
}

async function payWithdrawal(withdrawalId, actorUserId) {
  const withdrawal = await Withdrawal.findById(withdrawalId).populate('userId');
  if (!withdrawal) throw new ApiError(404, 'Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if (withdrawal.status !== 'approved') {
    throw new ApiError(400, 'Only approved withdrawals can be paid', 'WITHDRAWAL_STATUS_INVALID');
  }
  const payout = await transferPayout({
    to: withdrawal.userId.walletAddress,
    amount: withdrawal.approvedAmount,
  });
  withdrawal.status = 'paid';
  withdrawal.payoutTxHash = payout.txHash;
  withdrawal.processedAt = new Date();
  await withdrawal.save();
  await logAudit({
    actorUserId,
    action: 'withdrawal.paid',
    entity: 'Withdrawal',
    entityId: String(withdrawal._id),
    meta: { txHash: payout.txHash },
  });
  return withdrawal;
}

function formatLedgerEntry(w) {
  return {
    id: w._id,
    requestedAmount: w.requestedAmount,
    approvedAmount: w.approvedAmount,
    status: w.status,
    incomeType: w.incomeType,
    monthKey: w.monthKey,
    payoutTxHash: w.payoutTxHash,
    rejectionReason: w.rejectionReason,
    requestedAt: w.createdAt,
    processedAt: w.processedAt,
  };
}

async function getWithdrawalHistory(userId, { limit, offset, status, type }) {
  const query = { userId };
  if (status) query.status = status;
  if (type) query.incomeType = type;

  const [items, total, summaryAgg] = await Promise.all([
    Withdrawal.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    Withdrawal.countDocuments(query),
    // Summary is over ALL of the user's withdrawals, independent of the list filters.
    Withdrawal.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: '$status', amount: { $sum: '$approvedAmount' }, count: { $sum: 1 } } },
    ]),
  ]);

  const summary = { totalWithdrawn: 0, pendingAmount: 0, approvedAmount: 0, rejectedCount: 0, totalCount: 0 };
  for (const row of summaryAgg) {
    summary.totalCount += row.count;
    if (row._id === WITHDRAWAL_STATUS.PAID) summary.totalWithdrawn += row.amount;
    if (row._id === WITHDRAWAL_STATUS.PENDING) summary.pendingAmount += row.amount;
    if (row._id === WITHDRAWAL_STATUS.APPROVED) summary.approvedAmount += row.amount;
    if (row._id === WITHDRAWAL_STATUS.REJECTED) summary.rejectedCount += row.count;
  }

  return {
    items: items.map(formatLedgerEntry),
    summary,
    pagination: { total, limit, offset, hasMore: offset + items.length < total },
  };
}

module.exports = {
  requestWithdrawal,
  withdrawRoiForMonth,
  withdrawViaContract,
  payWithdrawal,
  getWithdrawalHistory,
};
