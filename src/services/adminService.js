const User = require('../models/User');
const Deposit = require('../models/Deposit');
const Withdrawal = require('../models/Withdrawal');
const Cycle = require('../models/Cycle');
const { getConfig, updateConfig } = require('./configService');

async function getKpis() {
  const [totalUsers, activeUsers, totalDeposits, totalWithdrawals, totalPayouts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Deposit.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Withdrawal.countDocuments(),
    Withdrawal.aggregate([{ $group: { _id: null, total: { $sum: '$approvedAmount' } } }]),
  ]);
  const inactiveUsers = totalUsers - activeUsers;
  const reTopUsers = await Cycle.countDocuments({ isActive: false });

  return {
    totalUsers,
    activeUsers,
    inactiveUsers,
    totalDeposits: totalDeposits[0]?.total || 0,
    totalWithdrawals,
    totalPayouts: totalPayouts[0]?.total || 0,
    reTopUsers,
  };
}

// List cycles that have achieved 3x income (totalEarned >= incomeCap), one row per
// cycle, joined with the user for the wallet address. Note: a cycle can close on the
// 2x ROI cap or 1x direct+override cap without reaching 3x, so we filter strictly on
// totalEarned >= incomeCap rather than on isActive.
async function listCapReachedCycles({ limit, offset }) {
  const match = { $expr: { $gte: ['$totalEarned', '$incomeCap'] } };
  const [cycles, total] = await Promise.all([
    Cycle.aggregate([
      { $match: match },
      { $sort: { closedAt: -1, updatedAt: -1 } },
      { $skip: offset },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          cycleId: '$_id',
          userId: 1,
          walletAddress: '$user.walletAddress',
          referralId: '$user.referralId',
          cycleNumber: 1,
          packageAmount: 1,
          incomeCap: 1,
          totalEarned: 1,
          breakdown: { roi: '$earnedRoi', direct: '$earnedDirect', override: '$earnedOverride' },
          isActive: 1,
          startedAt: 1,
          closedAt: 1,
        },
      },
    ]),
    Cycle.countDocuments(match),
  ]);
  return { meta: { total, limit, offset, count: cycles.length }, cycles };
}

module.exports = { getKpis, getConfig, updateConfig, listCapReachedCycles };
