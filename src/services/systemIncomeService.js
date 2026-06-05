const IncomeLedger = require('../models/IncomeLedger');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const ApiError = require('../utils/ApiError');
const { getConfig } = require('./configService');
const { resolveRoiSlab } = require('./depositService');
const {
  DIRECT_LEVEL_MULTIPLIER,
  MAX_OVERRIDE_LEVELS,
  INCOME_TYPES,
  WITHDRAWAL_STATUS,
} = require('../config/constants');

const SYNTHETIC_MONTH_KEY = 'sync-historical';

const MONTH_NAMES = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9,
  sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function emptyByType() {
  return { roi: 0, direct: 0, override: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Historical aggregation (system-wide, by month + type)
// ---------------------------------------------------------------------------

async function getHistoricalIncome() {
  const [byMonthType, overrideByLevelRows, syntheticOverrideRows] = await Promise.all([
    IncomeLedger.aggregate([
      {
        $group: {
          _id: { monthKey: '$monthKey', type: '$type' },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.monthKey': 1, '_id.type': 1 } },
    ]),
    IncomeLedger.aggregate([
      { $match: { type: INCOME_TYPES.OVERRIDE, monthKey: { $ne: SYNTHETIC_MONTH_KEY } } },
      { $group: { _id: '$level', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    IncomeLedger.aggregate([
      { $match: { type: INCOME_TYPES.OVERRIDE, monthKey: SYNTHETIC_MONTH_KEY } },
      { $group: { _id: '$level', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const monthsMap = new Map();
  const syntheticByType = emptyByType();
  const grandTotals = emptyByType();
  const grandTotalsIncludingSynthetic = emptyByType();

  for (const row of byMonthType) {
    const { monthKey, type } = row._id;
    const amount = row.amount || 0;

    grandTotalsIncludingSynthetic[type] = (grandTotalsIncludingSynthetic[type] || 0) + amount;
    grandTotalsIncludingSynthetic.total += amount;

    if (monthKey === SYNTHETIC_MONTH_KEY) {
      syntheticByType[type] = (syntheticByType[type] || 0) + amount;
      syntheticByType.total += amount;
      continue;
    }

    if (!monthsMap.has(monthKey)) {
      monthsMap.set(monthKey, { monthKey, roi: 0, direct: 0, override: 0, total: 0 });
    }
    const bucket = monthsMap.get(monthKey);
    bucket[type] = (bucket[type] || 0) + amount;
    bucket.total += amount;

    grandTotals[type] = (grandTotals[type] || 0) + amount;
    grandTotals.total += amount;
  }

  const months = Array.from(monthsMap.values())
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    .map((m) => ({
      monthKey: m.monthKey,
      roi: round2(m.roi),
      direct: round2(m.direct),
      override: round2(m.override),
      total: round2(m.total),
    }));

  const mapLevels = (rows) =>
    rows.map((r) => ({ level: r._id || 0, amount: round2(r.amount || 0), count: r.count }));

  const roundTotals = (t) => ({
    roi: round2(t.roi),
    direct: round2(t.direct),
    override: round2(t.override),
    total: round2(t.total),
  });

  return {
    months,
    overrideByLevel: mapLevels(overrideByLevelRows),
    grandTotals: roundTotals(grandTotals),
    syntheticHistorical: {
      byType: roundTotals(syntheticByType),
      overrideByLevel: mapLevels(syntheticOverrideRows),
    },
    grandTotalsIncludingSynthetic: roundTotals(grandTotalsIncludingSynthetic),
  };
}

// ---------------------------------------------------------------------------
// Forward simulation core (shared by system-wide and per-user projections)
// ---------------------------------------------------------------------------

function futureMonthKey(base, offset) {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Clamp + apply an income credit to a simulated cycle, mirroring
 * cycleService.applyIncomeToCycle (caps + saturation/closure) exactly.
 */
function applyCapToSim(sim, type, amount) {
  if (!sim.isActive) return 0;
  const remainingTotal = Math.max(sim.incomeCap - sim.totalEarned, 0);
  const directLevelCap = sim.packageAmount * DIRECT_LEVEL_MULTIPLIER;
  let remainingType = remainingTotal;
  if (type === INCOME_TYPES.ROI) {
    remainingType = Math.max(sim.roiTarget - sim.earnedRoi, 0);
  } else if (type === INCOME_TYPES.DIRECT || type === INCOME_TYPES.OVERRIDE) {
    remainingType = Math.max(directLevelCap - (sim.earnedDirect + sim.earnedOverride), 0);
  }
  const remainingCap = Math.min(remainingTotal, remainingType);
  const credited = Math.max(0, Math.min(amount, remainingCap));
  if (credited <= 0) return 0;

  if (type === INCOME_TYPES.ROI) sim.earnedRoi += credited;
  if (type === INCOME_TYPES.DIRECT) sim.earnedDirect += credited;
  if (type === INCOME_TYPES.OVERRIDE) sim.earnedOverride += credited;
  sim.totalEarned = sim.earnedRoi + sim.earnedDirect + sim.earnedOverride;

  const roiSaturated = sim.earnedRoi >= sim.roiTarget;
  const directLevelSaturated = sim.earnedDirect + sim.earnedOverride >= directLevelCap;
  const totalSaturated = sim.totalEarned >= sim.incomeCap;
  if (roiSaturated || directLevelSaturated || totalSaturated) sim.isActive = false;
  return credited;
}

function buildSimState(activeCycles, users, config) {
  const walletToUser = new Map();
  const userById = new Map();
  for (const u of users) {
    if (u.walletAddress) walletToUser.set(u.walletAddress, u);
    userById.set(String(u._id), u);
  }
  const simByUserId = new Map();
  const warnings = { slabNotFound: [] };
  for (const c of activeCycles) {
    const slab = resolveRoiSlab(c.packageAmount, config.roiSlabs);
    const monthlyRoi = slab ? (c.packageAmount * slab.monthlyPercent) / 100 : 0;
    if (!slab) warnings.slabNotFound.push(String(c.userId));
    simByUserId.set(String(c.userId), {
      userId: String(c.userId),
      packageAmount: c.packageAmount,
      roiTarget: c.roiTarget,
      incomeCap: c.incomeCap,
      earnedRoi: c.earnedRoi || 0,
      earnedDirect: c.earnedDirect || 0,
      earnedOverride: c.earnedOverride || 0,
      totalEarned: c.totalEarned || 0,
      isActive: true,
      monthlyRoi,
    });
  }
  return { walletToUser, userById, simByUserId, warnings };
}

/**
 * Advance the simulation one month, mutating sim state. Returns the credits
 * created this month as system totals, per-level overrides, and per-user
 * breakdown (mirrors creditIncome + creditOverrideOnRoi ordering).
 */
function runOneMonth(state, config) {
  const totals = { roi: 0, override: 0, direct: 0 };
  const perLevel = new Map();
  const perUser = new Map();
  const ensureUser = (uid) => {
    if (!perUser.has(uid)) perUser.set(uid, { roi: 0, override: 0, overrideByLevel: new Map() });
    return perUser.get(uid);
  };

  for (const sim of state.simByUserId.values()) {
    if (!sim.isActive || sim.monthlyRoi <= 0) continue;
    const roiCredited = applyCapToSim(sim, INCOME_TYPES.ROI, sim.monthlyRoi);
    if (roiCredited <= 0) continue;
    totals.roi += roiCredited;
    ensureUser(sim.userId).roi += roiCredited;

    const beneficiary = state.userById.get(sim.userId);
    if (!beneficiary) continue;
    const visited = new Set([beneficiary.walletAddress]);
    let wallet = beneficiary.sponsorWalletAddress;
    for (let level = 1; level <= MAX_OVERRIDE_LEVELS && wallet; level += 1) {
      if (visited.has(wallet)) break;
      visited.add(wallet);
      const sponsor = state.walletToUser.get(wallet);
      if (!sponsor) break;
      const percent = config.overridePercentages.find((x) => x.level === level)?.percent || 0;
      if (percent > 0) {
        const sponsorSim = state.simByUserId.get(String(sponsor._id));
        if (sponsorSim && sponsorSim.isActive) {
          const credited = applyCapToSim(sponsorSim, INCOME_TYPES.OVERRIDE, (roiCredited * percent) / 100);
          if (credited > 0) {
            totals.override += credited;
            perLevel.set(level, (perLevel.get(level) || 0) + credited);
            const rec = ensureUser(String(sponsor._id));
            rec.override += credited;
            rec.overrideByLevel.set(level, (rec.overrideByLevel.get(level) || 0) + credited);
          }
        }
      }
      wallet = sponsor.sponsorWalletAddress;
    }
  }
  return { totals, perLevel, perUser };
}

function projectionNotes() {
  return [
    'Direct commission is one-time at deposit; existing cycles accrue no future direct income, so projected direct is 0.',
    'Projection respects ROI cap (2x), per-cycle direct+override cap (1x package), and total cap (3x).',
  ];
}

function roundEmpty(t) {
  return { roi: round2(t.roi), direct: round2(t.direct), override: round2(t.override), total: round2(t.total) };
}

/**
 * Pure, DB-free month-by-month forward simulation of system income.
 * Direct commission is one-time at deposit, so projected direct is always 0.
 */
function simulateForwardIncome(months, activeCycles, users, config, base = new Date()) {
  const grandTotals = emptyByType();
  const warnings = { slabNotFound: [] };
  const result = { months: [], grandTotals, notes: projectionNotes(), warnings };

  if (!months || months <= 0) {
    result.grandTotals = roundEmpty(grandTotals);
    return result;
  }

  const state = buildSimState(activeCycles, users, config);
  result.warnings = state.warnings;

  for (let m = 1; m <= months; m += 1) {
    const { totals, perLevel } = runOneMonth(state, config);
    grandTotals.roi += totals.roi;
    grandTotals.override += totals.override;
    grandTotals.total += totals.roi + totals.override;

    result.months.push({
      monthOffset: m,
      monthKey: futureMonthKey(base, m),
      roi: round2(totals.roi),
      direct: 0,
      override: round2(totals.override),
      overrideByLevel: Array.from(perLevel.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([level, amount]) => ({ level, amount: round2(amount) })),
      total: round2(totals.roi + totals.override),
    });
  }

  result.grandTotals = roundEmpty(grandTotals);
  return result;
}

/**
 * Pure, DB-free per-user projection of the income released in a single target
 * month (the `targetOffset`-th month forward). Returns a Map of userId ->
 * { roi, override, overrideByLevel: Map } for that month only.
 */
function simulatePerUserForMonth(targetOffset, activeCycles, users, config) {
  const state = buildSimState(activeCycles, users, config);
  if (!targetOffset || targetOffset <= 0) {
    return { perUser: new Map(), warnings: state.warnings };
  }
  let last = { perUser: new Map() };
  for (let m = 1; m <= targetOffset; m += 1) {
    last = runOneMonth(state, config);
  }
  return { perUser: last.perUser, warnings: state.warnings };
}

async function getIncomeOverview({ months }) {
  const config = await getConfig();
  const [historical, activeCycles, users] = await Promise.all([
    getHistoricalIncome(),
    Cycle.find({ isActive: true }).lean(),
    User.find({}, { walletAddress: 1, sponsorWalletAddress: 1 }).lean(),
  ]);
  const projection = simulateForwardIncome(months, activeCycles, users, config);
  return { generatedAt: new Date().toISOString(), params: { months }, historical, projection };
}

// ---------------------------------------------------------------------------
// Per-user, month-targeted report (actual for past/current, projected future)
// ---------------------------------------------------------------------------

/**
 * Parse a month param into a normalized padded monthKey.
 * Accepts "2026-05", "2026-5" (non-padded) and "May 2026" / "may 2026".
 */
function parseMonthParam(input) {
  if (!input || typeof input !== 'string') {
    throw new ApiError(400, 'Month is required', 'INVALID_MONTH');
  }
  const s = input.trim();

  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const year = Number(m[1]);
    const monthNum = Number(m[2]);
    if (monthNum < 1 || monthNum > 12) {
      throw new ApiError(400, `Invalid month: ${input}`, 'INVALID_MONTH');
    }
    return { monthKey: `${year}-${String(monthNum).padStart(2, '0')}`, year, monthIndex: monthNum - 1 };
  }

  m = s.match(/^([A-Za-z]+)\s*,?\s*(\d{4})$/);
  if (m) {
    const monthNum = MONTH_NAMES[m[1].toLowerCase()];
    if (!monthNum) throw new ApiError(400, `Invalid month name: ${input}`, 'INVALID_MONTH');
    const year = Number(m[2]);
    return { monthKey: `${year}-${String(monthNum).padStart(2, '0')}`, year, monthIndex: monthNum - 1 };
  }

  throw new ApiError(400, `Unparseable month: ${input}`, 'INVALID_MONTH');
}

/**
 * Given a padded "YYYY-MM" key, return [padded, nonPadded] so that ledger rows
 * written with a non-padded month (e.g. "2026-5") are not missed on read.
 */
function monthKeyVariants(paddedKey) {
  const m = paddedKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return [paddedKey];
  const nonPadded = `${m[1]}-${Number(m[2])}`;
  return nonPadded === paddedKey ? [paddedKey] : [paddedKey, nonPadded];
}

async function getActualsForMonth(variants) {
  const rows = await IncomeLedger.aggregate([
    { $match: { monthKey: { $in: variants } } },
    {
      $group: {
        _id: { user: '$beneficiaryUserId', type: '$type', level: '$level' },
        amount: { $sum: '$amount' },
      },
    },
  ]);
  const map = new Map();
  for (const r of rows) {
    const uid = String(r._id.user);
    if (!map.has(uid)) map.set(uid, { roi: 0, direct: 0, level: 0, overrideByLevel: new Map() });
    const rec = map.get(uid);
    const amt = r.amount || 0;
    if (r._id.type === INCOME_TYPES.ROI) rec.roi += amt;
    else if (r._id.type === INCOME_TYPES.DIRECT) rec.direct += amt;
    else if (r._id.type === INCOME_TYPES.OVERRIDE) {
      rec.level += amt;
      rec.overrideByLevel.set(r._id.level, (rec.overrideByLevel.get(r._id.level) || 0) + amt);
    }
  }
  return map;
}

/**
 * Running-balance claimable per type from all-time earned (incl. synthetic)
 * minus claimed (PAID withdrawals). Pure split for unit testing.
 */
function computeClaimable({ earnedRoi = 0, earnedDirect = 0, earnedOverride = 0, claimed = 0 }) {
  const totalEarned = earnedRoi + earnedDirect + earnedOverride;
  let claimableRoi = earnedRoi;
  let claimableDirect = earnedDirect;
  let claimableLevel = earnedOverride;
  if (totalEarned > 0 && claimed > 0) {
    // Withdrawals are not typed; allocate claimed proportionally to earned share.
    claimableRoi = Math.max(earnedRoi - claimed * (earnedRoi / totalEarned), 0);
    claimableDirect = Math.max(earnedDirect - claimed * (earnedDirect / totalEarned), 0);
    claimableLevel = Math.max(earnedOverride - claimed * (earnedOverride / totalEarned), 0);
  }
  return {
    claimableRoi: round2(claimableRoi),
    claimableDirect: round2(claimableDirect),
    claimableLevel: round2(claimableLevel),
    totalClaimable: round2(Math.max(totalEarned - claimed, 0)),
    earnedAllTime: { roi: round2(earnedRoi), direct: round2(earnedDirect), level: round2(earnedOverride) },
    claimed: round2(claimed),
  };
}

async function getClaimableBalances() {
  const [earnedRows, claimedRows] = await Promise.all([
    IncomeLedger.aggregate([
      { $group: { _id: { user: '$beneficiaryUserId', type: '$type' }, amount: { $sum: '$amount' } } },
    ]),
    Withdrawal.aggregate([
      { $match: { status: WITHDRAWAL_STATUS.PAID } },
      { $group: { _id: '$userId', total: { $sum: '$approvedAmount' } } },
    ]),
  ]);

  const raw = new Map();
  const ensure = (uid) => {
    if (!raw.has(uid)) raw.set(uid, { earnedRoi: 0, earnedDirect: 0, earnedOverride: 0, claimed: 0 });
    return raw.get(uid);
  };
  for (const r of earnedRows) {
    const rec = ensure(String(r._id.user));
    const amt = r.amount || 0;
    if (r._id.type === INCOME_TYPES.ROI) rec.earnedRoi += amt;
    else if (r._id.type === INCOME_TYPES.DIRECT) rec.earnedDirect += amt;
    else if (r._id.type === INCOME_TYPES.OVERRIDE) rec.earnedOverride += amt;
  }
  for (const r of claimedRows) ensure(String(r._id)).claimed += r.total || 0;

  const result = new Map();
  for (const [uid, rec] of raw) result.set(uid, computeClaimable(rec));
  return result;
}

async function getMonthlyUserIncome({ month }) {
  const { monthKey, year, monthIndex } = parseMonthParam(month);
  const now = new Date();
  const currentKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const isFuture = monthKey > currentKey; // lexicographic works for padded YYYY-MM

  const [claimableMap, users, activeCycles] = await Promise.all([
    getClaimableBalances(),
    User.find({}, { walletAddress: 1, sponsorWalletAddress: 1 }).lean(),
    Cycle.find({ isActive: true }).lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const activeCycleByUser = new Map(activeCycles.map((c) => [String(c.userId), c]));

  let monthMap = new Map();
  let warnings = { slabNotFound: [] };
  const source = isFuture ? 'projected' : 'actual';

  if (isFuture) {
    const config = await getConfig();
    const targetOffset = (year - now.getUTCFullYear()) * 12 + (monthIndex - now.getUTCMonth());
    const sim = simulatePerUserForMonth(targetOffset, activeCycles, users, config, now);
    warnings = sim.warnings;
    for (const [uid, rec] of sim.perUser) {
      monthMap.set(uid, { roi: rec.roi, direct: 0, level: rec.override, overrideByLevel: rec.overrideByLevel });
    }
  } else {
    monthMap = await getActualsForMonth(monthKeyVariants(monthKey));
  }

  const uids = new Set([...monthMap.keys(), ...claimableMap.keys(), ...activeCycleByUser.keys()]);
  const usersOut = [];
  const systemTotals = { roi: 0, direct: 0, level: 0, totalClaimable: 0 };

  for (const uid of uids) {
    const u = userById.get(uid);
    const mrec = monthMap.get(uid) || { roi: 0, direct: 0, level: 0, overrideByLevel: new Map() };
    const claimable = claimableMap.get(uid) || computeClaimable({});
    const cycle = activeCycleByUser.get(uid);
    const overrideByLevel = Array.from(mrec.overrideByLevel.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([level, amount]) => ({ level, amount: round2(amount) }));

    systemTotals.roi += mrec.roi;
    systemTotals.direct += mrec.direct;
    systemTotals.level += mrec.level;
    systemTotals.totalClaimable += claimable.totalClaimable;

    usersOut.push({
      userId: uid,
      walletAddress: u ? u.walletAddress : null,
      packageAmount: cycle ? cycle.packageAmount : null,
      month: {
        monthKey,
        source,
        roi: round2(mrec.roi),
        direct: round2(mrec.direct),
        level: round2(mrec.level),
        overrideByLevel,
      },
      claimable,
    });
  }

  usersOut.sort((a, b) => b.month.roi - a.month.roi);

  return {
    meta: { month: monthKey, source, generatedAt: now.toISOString() },
    users: usersOut,
    systemTotals: {
      roi: round2(systemTotals.roi),
      direct: round2(systemTotals.direct),
      level: round2(systemTotals.level),
      totalClaimable: round2(systemTotals.totalClaimable),
    },
    warnings,
  };
}

module.exports = {
  getIncomeOverview,
  getHistoricalIncome,
  simulateForwardIncome,
  getMonthlyUserIncome,
  parseMonthParam,
  monthKeyVariants,
  simulatePerUserForMonth,
  getClaimableBalances,
  computeClaimable,
};
