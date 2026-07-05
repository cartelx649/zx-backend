#!/usr/bin/env node

global.crypto = require('node:crypto').webcrypto;

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Cycle = require('../src/models/Cycle');
const Deposit = require('../src/models/Deposit');
const IncomeLedger = require('../src/models/IncomeLedger');
const { getConfig } = require('../src/services/configService');
const {
  calculateProratedMonthlyRoi,
  previousCalendarMonthPeriod,
} = require('../src/services/roiJobService');

const OVERRIDE_NOTE = 'Level override from ROI credit';

function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round8(value) {
  return Math.round((value + Number.EPSILON) * 100000000) / 100000000;
}

function cycleCaps(cycle) {
  return {
    roiRemaining: Math.max(cycle.roiTarget - cycle.earnedRoi, 0),
    directLevelRemaining: Math.max(cycle.packageAmount - (cycle.earnedDirect + cycle.earnedOverride), 0),
    totalRemaining: Math.max(cycle.incomeCap - cycle.totalEarned, 0),
  };
}

function applyToState(state, type, amount) {
  if (!state.isActive || amount <= 0) return 0;
  const caps = cycleCaps(state);
  let remainingType = caps.totalRemaining;
  if (type === 'roi') remainingType = caps.roiRemaining;
  if (type === 'override') remainingType = caps.directLevelRemaining;
  const credited = Math.max(0, Math.min(amount, caps.totalRemaining, remainingType));
  if (credited <= 0) return 0;
  if (type === 'roi') state.earnedRoi += credited;
  if (type === 'override') state.earnedOverride += credited;
  state.totalEarned = state.earnedRoi + state.earnedDirect + state.earnedOverride;
  const nextCaps = cycleCaps(state);
  state.isActive = nextCaps.roiRemaining > 0 && nextCaps.directLevelRemaining > 0 && nextCaps.totalRemaining > 0;
  return round8(credited);
}

function uniqueKey({ beneficiaryUserId, sourceUserId, type, monthKey, level, cycleId }) {
  return [
    String(beneficiaryUserId),
    String(sourceUserId),
    type,
    monthKey,
    String(level || 0),
    String(cycleId),
  ].join('|');
}

function parseArgs(argv) {
  const args = { apply: false, now: new Date() };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--now=')) args.now = new Date(arg.slice('--now='.length));
    else if (arg.startsWith('--target-month=')) args.targetMonthKey = arg.slice('--target-month='.length);
  }
  if (Number.isNaN(args.now.getTime())) {
    throw new Error('Invalid --now value');
  }
  args.targetMonthKey = args.targetMonthKey || currentMonthKey(args.now);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const period = previousCalendarMonthPeriod(args.now);
  const targetMonthKey = args.targetMonthKey;

  await mongoose.connect(process.env.MONGODB_URI);
  const config = await getConfig();

  const [users, cycles, deposits, currentMonthLedger] = await Promise.all([
    User.find({}).lean(),
    Cycle.find({}).lean(),
    Deposit.find({ status: 'verified' }).lean(),
    IncomeLedger.find({
      monthKey: targetMonthKey,
      type: { $in: ['roi', 'override'] },
    }).lean(),
  ]);

  const userById = new Map(users.map((user) => [String(user._id), user]));
  const walletToUser = new Map(users.map((user) => [user.walletAddress, user]));
  const depositsByCycle = new Map();
  for (const deposit of deposits) {
    const key = String(deposit.cycleId);
    if (!depositsByCycle.has(key)) depositsByCycle.set(key, []);
    depositsByCycle.get(key).push(deposit);
  }

  const currentLedgerByCycle = new Map();
  for (const entry of currentMonthLedger) {
    const key = String(entry.cycleId);
    if (!currentLedgerByCycle.has(key)) {
      currentLedgerByCycle.set(key, { roi: 0, override: 0 });
    }
    currentLedgerByCycle.get(key)[entry.type] += entry.amount || 0;
  }

  const simByUserId = new Map();
  for (const cycle of cycles) {
    const current = currentLedgerByCycle.get(String(cycle._id)) || { roi: 0, override: 0 };
    const earnedRoi = Math.max((cycle.earnedRoi || 0) - current.roi, 0);
    const earnedOverride = Math.max((cycle.earnedOverride || 0) - current.override, 0);
    const earnedDirect = cycle.earnedDirect || 0;
    const totalEarned = earnedRoi + earnedDirect + earnedOverride;
    const state = {
      cycleId: String(cycle._id),
      userId: String(cycle.userId),
      packageAmount: cycle.packageAmount,
      roiTarget: cycle.roiTarget,
      incomeCap: cycle.incomeCap,
      earnedRoi,
      earnedDirect,
      earnedOverride,
      totalEarned,
      isActive:
        earnedRoi < cycle.roiTarget &&
        earnedDirect + earnedOverride < cycle.packageAmount &&
        totalEarned < cycle.incomeCap,
    };
    simByUserId.set(state.userId, state);
  }

  const newEntries = new Map();
  const addEntry = (entry) => newEntries.set(uniqueKey(entry), entry);

  const sortedUsers = users
    .map((user) => String(user._id))
    .sort((a, b) => a.localeCompare(b));

  for (const userId of sortedUsers) {
    const state = simByUserId.get(userId);
    if (!state || !state.isActive) continue;
    const user = userById.get(userId);
    const rawRoi = calculateProratedMonthlyRoi({
      cycle: state,
      deposits: depositsByCycle.get(state.cycleId) || [],
      roiSlabs: config.roiSlabs,
      period,
    });
    const creditedRoi = applyToState(state, 'roi', rawRoi);
    if (creditedRoi <= 0) continue;

    addEntry({
      beneficiaryUserId: state.userId,
      sourceUserId: state.userId,
      cycleId: state.cycleId,
      type: 'roi',
      level: 0,
      monthKey: targetMonthKey,
      amount: creditedRoi,
      note: `Monthly ROI accrual for ${period.monthKey}`,
    });

    const visited = new Set([user.walletAddress]);
    let sponsorWallet = user.sponsorWalletAddress;
    for (let level = 1; level <= 20 && sponsorWallet; level += 1) {
      if (visited.has(sponsorWallet)) break;
      visited.add(sponsorWallet);
      const sponsor = walletToUser.get(sponsorWallet);
      if (!sponsor) break;
      const sponsorState = simByUserId.get(String(sponsor._id));
      const percent = config.overridePercentages.find((row) => row.level === level)?.percent || 0;
      if (sponsorState && sponsorState.isActive && percent > 0) {
        const rawOverride = (creditedRoi * percent) / 100;
        const creditedOverride = applyToState(sponsorState, 'override', rawOverride);
        if (creditedOverride > 0) {
          addEntry({
            beneficiaryUserId: String(sponsor._id),
            sourceUserId: state.userId,
            cycleId: sponsorState.cycleId,
            type: 'override',
            level,
            monthKey: targetMonthKey,
            amount: creditedOverride,
            note: OVERRIDE_NOTE,
          });
        }
      }
      sponsorWallet = sponsor.sponsorWalletAddress;
    }
  }

  const existingKeys = new Set(currentMonthLedger.map((entry) => uniqueKey(entry)));
  const newKeys = new Set(newEntries.keys());
  const toDelete = currentMonthLedger.filter((entry) => !newKeys.has(uniqueKey(entry)));
  const toUpsert = Array.from(newEntries.values());

  const summary = {
    apply: args.apply,
    periodMonth: period.monthKey,
    targetMonthKey,
    existing: {
      roi: currentMonthLedger.filter((entry) => entry.type === 'roi').reduce((sum, entry) => sum + entry.amount, 0),
      override: currentMonthLedger
        .filter((entry) => entry.type === 'override')
        .reduce((sum, entry) => sum + entry.amount, 0),
      count: currentMonthLedger.length,
    },
    recomputed: {
      roi: toUpsert.filter((entry) => entry.type === 'roi').reduce((sum, entry) => sum + entry.amount, 0),
      override: toUpsert.filter((entry) => entry.type === 'override').reduce((sum, entry) => sum + entry.amount, 0),
      count: toUpsert.length,
    },
    delta: {
      roi:
        toUpsert.filter((entry) => entry.type === 'roi').reduce((sum, entry) => sum + entry.amount, 0) -
        currentMonthLedger.filter((entry) => entry.type === 'roi').reduce((sum, entry) => sum + entry.amount, 0),
      override:
        toUpsert.filter((entry) => entry.type === 'override').reduce((sum, entry) => sum + entry.amount, 0) -
        currentMonthLedger.filter((entry) => entry.type === 'override').reduce((sum, entry) => sum + entry.amount, 0),
      deleteCount: toDelete.length,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) {
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (toDelete.length > 0) {
      await IncomeLedger.deleteMany({ _id: { $in: toDelete.map((entry) => entry._id) } }, { session });
    }

    for (const entry of toUpsert) {
      await IncomeLedger.findOneAndUpdate(
        {
          beneficiaryUserId: entry.beneficiaryUserId,
          sourceUserId: entry.sourceUserId,
          type: entry.type,
          monthKey: entry.monthKey,
          level: entry.level,
          cycleId: entry.cycleId,
        },
        {
          $set: {
            amount: entry.amount,
            note: entry.note,
          },
        },
        {
          upsert: true,
          session,
          setDefaultsOnInsert: true,
        }
      );
    }

    for (const state of simByUserId.values()) {
      const directLevelCapReached = state.earnedDirect + state.earnedOverride >= state.packageAmount;
      const roiCapReached = state.earnedRoi >= state.roiTarget;
      const totalCapReached = state.totalEarned >= state.incomeCap;
      const isActive = !(directLevelCapReached || roiCapReached || totalCapReached);
      await Cycle.updateOne(
        { _id: state.cycleId },
        {
          $set: {
            earnedRoi: round8(state.earnedRoi),
            earnedOverride: round8(state.earnedOverride),
            totalEarned: round8(state.totalEarned),
            isActive,
            closedAt: isActive ? null : new Date(),
          },
        },
        { session }
      );
      await User.updateOne({ _id: state.userId }, { $set: { isActive } }, { session });
    }

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
