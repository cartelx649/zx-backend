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

function toPercent(current, target) {
  if (!target) return 0;
  return Number(Math.min((current / target) * 100, 100).toFixed(2));
}

function classifyCycleStatus(cycle) {
  if (cycle.capReached) return 'cap_reached';
  if (cycle.roiReached) return 'roi_reached';
  if (cycle.isActive) return 'active';
  return 'inactive';
}

async function listUserCycleProgress({ limit = 100, offset = 0, status = 'all' }) {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const safeOffset = Math.max(offset, 0);

  const latestCycles = await Cycle.aggregate([
    { $sort: { userId: 1, cycleNumber: -1, updatedAt: -1 } },
    { $group: { _id: '$userId', cycle: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$cycle' } },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  ]);

  const rows = latestCycles
    .map((cycle) => {
      const roiReached = cycle.roiTarget > 0 && cycle.earnedRoi >= cycle.roiTarget;
      const capReached = cycle.incomeCap > 0 && cycle.totalEarned >= cycle.incomeCap;
      const row = {
        cycleId: cycle._id,
        userId: cycle.userId,
        walletAddress: cycle.user?.walletAddress || null,
        referralId: cycle.user?.referralId || null,
        cycleNumber: cycle.cycleNumber,
        packageAmount: cycle.packageAmount,
        earnedRoi: cycle.earnedRoi,
        roiTarget: cycle.roiTarget,
        totalEarned: cycle.totalEarned,
        incomeCap: cycle.incomeCap,
        earnedDirect: cycle.earnedDirect,
        earnedOverride: cycle.earnedOverride,
        isActive: cycle.isActive,
        startedAt: cycle.startedAt,
        closedAt: cycle.closedAt,
        roiProgressPercent: toPercent(cycle.earnedRoi, cycle.roiTarget),
        capProgressPercent: toPercent(cycle.totalEarned, cycle.incomeCap),
        remainingToRoiTarget: Math.max(cycle.roiTarget - cycle.earnedRoi, 0),
        remainingToIncomeCap: Math.max(cycle.incomeCap - cycle.totalEarned, 0),
        roiReached,
        capReached,
      };
      return { ...row, status: classifyCycleStatus(row) };
    })
    .sort((a, b) => {
      const priority = { cap_reached: 0, roi_reached: 1, active: 2, inactive: 3 };
      const byStatus = priority[a.status] - priority[b.status];
      if (byStatus !== 0) return byStatus;
      if (b.capProgressPercent !== a.capProgressPercent) {
        return b.capProgressPercent - a.capProgressPercent;
      }
      return b.cycleNumber - a.cycleNumber;
    });

  const filtered = rows.filter((row) => {
    if (!status || status === 'all') return true;
    if (status === 'attention') return row.roiReached || row.capReached;
    return row.status === status;
  });

  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const summary = {
    totalUsers: rows.length,
    activeUsers: rows.filter((row) => row.status === 'active').length,
    roiReachedUsers: rows.filter((row) => row.roiReached).length,
    capReachedUsers: rows.filter((row) => row.capReached).length,
    attentionUsers: rows.filter((row) => row.roiReached || row.capReached).length,
  };

  return {
    meta: {
      total: rows.length,
      filteredTotal: filtered.length,
      limit: safeLimit,
      offset: safeOffset,
      count: page.length,
      status,
    },
    summary,
    cycles: page,
  };
}

module.exports = {
  getKpis,
  getConfig,
  updateConfig,
  listCapReachedCycles,
  listUserCycleProgress,
};
