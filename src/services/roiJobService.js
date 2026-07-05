const User = require('../models/User');
const Deposit = require('../models/Deposit');
const { getConfig } = require('./configService');
const { getActiveCycle, withMongoTransaction } = require('./cycleService');
const { creditIncome, creditOverrideOnRoi } = require('./incomeService');
const { INCOME_TYPES } = require('../config/constants');

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function inclusiveUtcDayCount(start, end) {
  return Math.floor((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / DAY_MS) + 1;
}

function previousCalendarMonthPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  return {
    start,
    end,
    daysInMonth: inclusiveUtcDayCount(start, end),
    monthKey: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
  };
}

function resolveRoiSlab(packageAmount, roiSlabs) {
  return roiSlabs.find(
    (item) => packageAmount >= item.min && (item.max === null || packageAmount <= item.max)
  );
}

function round8(value) {
  return Math.round((value + Number.EPSILON) * 100000000) / 100000000;
}

function calculateProratedMonthlyRoi({ cycle, deposits, roiSlabs, period }) {
  const relevantDeposits = deposits
    .filter((deposit) => deposit?.createdAt && deposit.status === 'verified' && deposit.createdAt <= period.end)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let packageAtPeriodStart = 0;
  const eventAmountsByDay = new Map();

  for (const deposit of relevantDeposits) {
    const depositDay = startOfUtcDay(new Date(deposit.createdAt));
    if (depositDay < period.start) {
      packageAtPeriodStart += deposit.amount || 0;
      continue;
    }
    if (depositDay > period.end) continue;
    const key = depositDay.toISOString();
    eventAmountsByDay.set(key, (eventAmountsByDay.get(key) || 0) + (deposit.amount || 0));
  }

  const eventDays = Array.from(eventAmountsByDay.keys())
    .map((iso) => new Date(iso))
    .sort((a, b) => a.getTime() - b.getTime());

  let currentPackage = packageAtPeriodStart;
  let cursor = period.start;
  let totalRoi = 0;

  for (const eventDay of eventDays) {
    const segmentEnd = addUtcDays(eventDay, -1);
    if (currentPackage > 0 && cursor <= segmentEnd) {
      const slab = resolveRoiSlab(currentPackage, roiSlabs);
      if (slab) {
        const daysActive = inclusiveUtcDayCount(cursor, segmentEnd);
        totalRoi += ((currentPackage * slab.monthlyPercent) / 100) * (daysActive / period.daysInMonth);
      }
    }

    currentPackage += eventAmountsByDay.get(eventDay.toISOString()) || 0;
    cursor = eventDay;
  }

  if (currentPackage > 0 && cursor <= period.end) {
    const slab = resolveRoiSlab(currentPackage, roiSlabs);
    if (slab) {
      const daysActive = inclusiveUtcDayCount(cursor, period.end);
      totalRoi += ((currentPackage * slab.monthlyPercent) / 100) * (daysActive / period.daysInMonth);
    }
  }

  return round8(totalRoi);
}

async function runMonthlyRoiAccrual(now = new Date()) {
  console.log('[roiJob] Starting monthly ROI accrual');
  const config = await getConfig();
  const period = previousCalendarMonthPeriod(now);
  const activeUsers = await User.find({ isActive: true });
  console.log(`[roiJob] Found ${activeUsers.length} active users`);
  let processed = 0;
  let credited = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of activeUsers) {
    processed += 1;
    try {
      // Sequential monthly credit keeps cap checks deterministic.
      await withMongoTransaction(async (session) => {
        const cycle = await getActiveCycle(user._id);
        if (!cycle) {
          console.log(`[roiJob] User ${user._id} skipped: no active cycle`);
          skipped += 1;
          return;
        }
        const slab = resolveRoiSlab(cycle.packageAmount, config.roiSlabs);
        if (!slab) {
          console.log(`[roiJob] User ${user._id} skipped: no matching ROI slab for package ${cycle.packageAmount}`);
          skipped += 1;
          return;
        }
        const deposits = await Deposit.find({ cycleId: cycle._id, status: 'verified' })
          .select('amount createdAt status')
          .session(session)
          .lean();
        const monthlyRoiAmount = calculateProratedMonthlyRoi({
          cycle,
          deposits,
          roiSlabs: config.roiSlabs,
          period,
        });
        const availableForRoi = Math.min(
          Math.max(cycle.roiTarget - cycle.earnedRoi, 0),
          Math.max(cycle.incomeCap - cycle.totalEarned, 0)
        );
        const roiAmount = Math.min(monthlyRoiAmount, availableForRoi);
        if (roiAmount <= 0) {
          console.log(
            `[roiJob] User ${user._id} skipped: cap reached ` +
              `(roi ${cycle.earnedRoi}/${cycle.roiTarget}, total ${cycle.totalEarned}/${cycle.incomeCap})`
          );
          skipped += 1;
          return;
        }
        console.log(`[roiJob] Crediting ROI ${roiAmount} to user ${user._id} (cycle ${cycle._id})`);
        await creditIncome({
          beneficiaryUserId: user._id,
          sourceUserId: user._id,
          cycleId: cycle._id,
          type: INCOME_TYPES.ROI,
          amount: roiAmount,
          note: `Monthly ROI accrual for ${period.monthKey}`,
          session,
        });
        await creditOverrideOnRoi({ roiBeneficiaryUser: user, roiAmount, session });
        credited += 1;
        console.log(`[roiJob] User ${user._id} credited successfully`);
      });
    } catch (error) {
      failed += 1;
      console.error(`[roiJob] User ${user._id} failed:`, error.message);
    }
  }
  console.log(`[roiJob] Completed. processed=${processed} credited=${credited} skipped=${skipped} failed=${failed}`);
}

module.exports = {
  runMonthlyRoiAccrual,
  calculateProratedMonthlyRoi,
  previousCalendarMonthPeriod,
};
