const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const IncomeLedger = require('../models/IncomeLedger');
const ApiError = require('../utils/ApiError');
const { INCOME_TYPES, WITHDRAWAL_STATUS } = require('../config/constants');
const { getActiveCycle } = require('./cycleService');
const { getConfig } = require('./configService');
const { transferPayout } = require('./blockchainService');
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

async function requestWithdrawal(userId, requestedAmount) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) throw new ApiError(400, 'User not active', 'USER_INACTIVE');
  const cycle = await getActiveCycle(user._id);
  if (!cycle) throw new ApiError(400, 'No active cycle', 'NO_ACTIVE_CYCLE');
  const config = await getConfig();
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

module.exports = { requestWithdrawal, withdrawRoiForMonth, payWithdrawal };
