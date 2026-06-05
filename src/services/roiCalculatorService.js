const ApiError = require('../utils/ApiError');
const { getConfig } = require('./configService');
const { resolveRoiSlab } = require('./depositService');
const {
  ROI_MULTIPLIER,
  CAP_MULTIPLIER,
  DIRECT_LEVEL_MULTIPLIER,
  DIRECT_COMMISSION_PERCENT,
} = require('../config/constants');

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function slabLabel(slab) {
  if (!slab) return null;
  if (slab.max === null || slab.max === undefined) return `${slab.min}+ USDT slab`;
  return `${slab.min}-${slab.max} USDT slab`;
}

/**
 * Project the earnings a single deposit of `amount` generates, broken into:
 *  - roi:    the depositor's own monthly ROI (slab %), capped at 2x (roiTarget).
 *  - direct: one-time 5% commission paid to the direct sponsor on deposit.
 *  - level:  per-level override percentages applied to each monthly ROI credit
 *            and paid up the 20-level sponsor chain.
 * Pure calculation — no DB writes — so it doubles as a pre-deposit calculator.
 */
function calculateProjection(amount, config) {
  const slab = resolveRoiSlab(amount, config.roiSlabs);
  if (!slab) {
    throw new ApiError(400, 'Amount does not match any ROI slab', 'INVALID_PACKAGE');
  }

  const monthlyRoi = (amount * slab.monthlyPercent) / 100;
  const roiTarget = amount * ROI_MULTIPLIER;
  const incomeCap = amount * CAP_MULTIPLIER;
  const monthsToCompleteRoi = monthlyRoi > 0 ? Math.ceil(roiTarget / monthlyRoi) : null;

  const directCommission = (amount * DIRECT_COMMISSION_PERCENT) / 100;
  const directLevelCap = amount * DIRECT_LEVEL_MULTIPLIER;

  // Override paid to each upline level per monthly ROI credit of this deposit.
  const levels = config.overridePercentages
    .slice()
    .sort((a, b) => a.level - b.level)
    .map((entry) => ({
      level: entry.level,
      percent: entry.percent,
      monthlyAmount: round2((monthlyRoi * entry.percent) / 100),
    }));

  const totalMonthlyLevelIncome = round2(
    levels.reduce((sum, lvl) => sum + lvl.monthlyAmount, 0)
  );

  return {
    input: { amount, slab: { name: slab.name, monthlyPercent: slab.monthlyPercent, label: slabLabel(slab) } },
    roi: {
      monthlyPercent: slab.monthlyPercent,
      monthlyRoi: round2(monthlyRoi),
      roiTarget: round2(roiTarget),
      incomeCap: round2(incomeCap),
      monthsToCompleteRoi,
    },
    direct: {
      commissionPercent: DIRECT_COMMISSION_PERCENT,
      commissionAmount: round2(directCommission),
      note: 'One-time commission paid to the direct sponsor when this deposit is made',
    },
    level: {
      directLevelCap: round2(directLevelCap),
      totalMonthlyLevelIncome,
      breakdown: levels,
      note: 'Override income each upline level earns per monthly ROI credit of this deposit (capped 1x with direct)',
    },
  };
}

async function getRoiProjection(amount) {
  const config = await getConfig();
  return calculateProjection(amount, config);
}

module.exports = { getRoiProjection, calculateProjection };
