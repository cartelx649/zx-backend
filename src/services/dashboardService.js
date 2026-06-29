const User = require('../models/User');
const IncomeLedger = require('../models/IncomeLedger');
const Withdrawal = require('../models/Withdrawal');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { INCOME_TYPES, WITHDRAWAL_STATUS, DIRECT_LEVEL_MULTIPLIER } = require('../config/constants');
const { getActiveCycle } = require('./cycleService');
const { getConfig } = require('./configService');
const { resolveRoiSlab } = require('./depositService');

function slabLabel(slab) {
  if (!slab) return null;
  if (slab.max === null || slab.max === undefined) return `${slab.min}+ USDT slab`;
  return `${slab.min}–${slab.max} USDT slab`;
}

function isWindowOpenNow(windowConfig) {
  if (!windowConfig?.isOpen) return false;
  return new Date().getUTCDate() === windowConfig.dayOfMonth;
}

function emptyActiveCycle() {
  return {
    exists: false,
    cycleNumber: 0,
    packageAmount: 0,
    roiTarget: 0,
    earnedRoi: 0,
    incomeCap: 0,
    totalEarned: 0,
    accountActive: false,
    retopUpRequired: true,
    slab: null,
    roiProgress: { current: 0, target: 0 },
    capProgress: { current: 0, target: 0 },
    directLevelProgress: { current: 0, target: 0 },
  };
}

async function getDashboard(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');

  const [cycle, incomeAgg, withdrawalAgg, config] = await Promise.all([
    getActiveCycle(user._id),
    IncomeLedger.aggregate([
      { $match: { beneficiaryUserId: user._id } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
    Withdrawal.aggregate([
      { $match: { userId: user._id, status: WITHDRAWAL_STATUS.PAID } },
      { $group: { _id: null, total: { $sum: '$approvedAmount' } } },
    ]),
    getConfig(),
  ]);

  const incomeTotals = { roi: 0, direct: 0, override: 0 };
  for (const row of incomeAgg) {
    if (row._id === INCOME_TYPES.ROI) incomeTotals.roi = row.total;
    if (row._id === INCOME_TYPES.DIRECT) incomeTotals.direct = row.total;
    if (row._id === INCOME_TYPES.OVERRIDE) incomeTotals.override = row.total;
  }
  const totalIncomeEarned = incomeTotals.roi + incomeTotals.direct + incomeTotals.override;
  const totalIncomeClaimed = withdrawalAgg[0]?.total || 0;
  const toBeClaimed = Math.max(totalIncomeEarned - totalIncomeClaimed, 0);

  let activeCycle = emptyActiveCycle();
  let remainingRoi = 0;
  if (cycle) {
    const slab = resolveRoiSlab(cycle.packageAmount, config.roiSlabs) || null;
    remainingRoi = Math.max(cycle.roiTarget - cycle.earnedRoi, 0);
    activeCycle = {
      exists: true,
      cycleNumber: cycle.cycleNumber,
      packageAmount: cycle.packageAmount,
      roiTarget: cycle.roiTarget,
      earnedRoi: cycle.earnedRoi,
      incomeCap: cycle.incomeCap,
      totalEarned: cycle.totalEarned,
      accountActive: user.isActive,
      retopUpRequired: false,
      slab: slab
        ? {
            name: slab.name,
            min: slab.min,
            max: slab.max,
            monthlyPercent: slab.monthlyPercent,
            label: slabLabel(slab),
          }
        : null,
      roiProgress: { current: cycle.earnedRoi, target: cycle.roiTarget },
      capProgress: { current: cycle.totalEarned, target: cycle.incomeCap },
      directLevelProgress: {
        current: cycle.earnedDirect + cycle.earnedOverride,
        target: cycle.packageAmount * DIRECT_LEVEL_MULTIPLIER,
      },
    };
  }

  return {
    investments: {
      totalInvestedValue: user.totalDeposited,
      roiEarnedToDate: incomeTotals.roi,
      claimedRoi: totalIncomeClaimed,
      remainingRoi,
    },
    income: {
      directIncome: incomeTotals.direct,
      levelIncome: incomeTotals.override,
      totalIncomeEarned,
      totalIncomeClaimed,
      toBeClaimed,
    },
    activeCycle,
    referral: {
      referralId: user.referralId,
      referralLink: `${env.frontendUrl}/?ref=${user.referralId}`,
      walletAddress: user.walletAddress,
      sponsorWalletAddress: user.sponsorWalletAddress,
      joinedAt: user.createdAt,
    },
    withdrawalWindow: {
      dayOfMonth: config.withdrawalWindow.dayOfMonth,
      isOpen: config.withdrawalWindow.isOpen,
      isOpenNow: isWindowOpenNow(config.withdrawalWindow),
    },
    withdrawalControls: {
      roiPaused: Boolean(config.roiWithdrawPaused),
      incomePaused: Boolean(config.incomeWithdrawPaused),
    },
  };
}

module.exports = { getDashboard };
