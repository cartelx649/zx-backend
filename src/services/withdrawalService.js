const Withdrawal = require('../models/Withdrawal');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const { getActiveCycle } = require('./cycleService');
const { getConfig } = require('./configService');
const { transferPayout } = require('./blockchainService');
const { logAudit } = require('./auditService');

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

module.exports = { requestWithdrawal, payWithdrawal };
