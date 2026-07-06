#!/usr/bin/env node

global.crypto = require('node:crypto').webcrypto;

const mongoose = require('mongoose');
const Cycle = require('../src/models/Cycle');
const User = require('../src/models/User');
const IncomeLedger = require('../src/models/IncomeLedger');
const {
  ROI_MULTIPLIER,
  CAP_MULTIPLIER,
} = require('../src/config/constants');

function round8(value) {
  return Math.round((value + Number.EPSILON) * 100000000) / 100000000;
}

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);

  const [cycles, totals] = await Promise.all([
    Cycle.find({}).lean(),
    IncomeLedger.aggregate([
      { $group: { _id: { cycleId: '$cycleId', type: '$type' }, total: { $sum: '$amount' } } },
    ]),
  ]);

  const byCycle = new Map();
  for (const row of totals) {
    const cycleId = String(row._id.cycleId);
    if (!byCycle.has(cycleId)) byCycle.set(cycleId, { roi: 0, direct: 0, override: 0 });
    byCycle.get(cycleId)[row._id.type] = round8(row.total || 0);
  }

  const updates = [];
  const userTotals = new Map();
  const userActive = new Map();

  for (const cycle of cycles) {
    const sums = byCycle.get(String(cycle._id)) || { roi: 0, direct: 0, override: 0 };
    const totalEarned = round8(sums.roi + sums.direct + sums.override);
    const roiTarget = cycle.roiTarget || cycle.packageAmount * ROI_MULTIPLIER;
    const incomeCap = cycle.incomeCap || cycle.packageAmount * CAP_MULTIPLIER;
    const isActive = !(
      sums.roi >= roiTarget ||
      totalEarned >= incomeCap
    );

    userTotals.set(String(cycle.userId), round8((userTotals.get(String(cycle.userId)) || 0) + totalEarned));
    userActive.set(String(cycle.userId), (userActive.get(String(cycle.userId)) || false) || isActive);

    const diffRoi = Math.abs((cycle.earnedRoi || 0) - sums.roi);
    const diffDirect = Math.abs((cycle.earnedDirect || 0) - sums.direct);
    const diffOverride = Math.abs((cycle.earnedOverride || 0) - sums.override);
    const diffTotal = Math.abs((cycle.totalEarned || 0) - totalEarned);
    const activeChanged = Boolean(cycle.isActive) !== isActive;

    if (diffRoi > 0.00000001 || diffDirect > 0.00000001 || diffOverride > 0.00000001 || diffTotal > 0.00000001 || activeChanged) {
      updates.push({
        cycleId: String(cycle._id),
        userId: String(cycle.userId),
        before: {
          earnedRoi: cycle.earnedRoi || 0,
          earnedDirect: cycle.earnedDirect || 0,
          earnedOverride: cycle.earnedOverride || 0,
          totalEarned: cycle.totalEarned || 0,
          isActive: Boolean(cycle.isActive),
        },
        after: {
          earnedRoi: sums.roi,
          earnedDirect: sums.direct,
          earnedOverride: sums.override,
          totalEarned,
          isActive,
        },
      });
    }
  }

  const summary = {
    apply: args.apply,
    cycleCount: cycles.length,
    updateCount: updates.length,
    updates,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) {
    await mongoose.disconnect();
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    for (const update of updates) {
      await Cycle.updateOne(
        { _id: update.cycleId },
        {
          $set: {
            earnedRoi: update.after.earnedRoi,
            earnedDirect: update.after.earnedDirect,
            earnedOverride: update.after.earnedOverride,
            totalEarned: update.after.totalEarned,
            isActive: update.after.isActive,
            closedAt: update.after.isActive ? null : new Date(),
          },
        },
        { session }
      );
    }

    for (const [userId, totalEarned] of userTotals.entries()) {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            totalEarned,
            isActive: Boolean(userActive.get(userId)),
          },
        },
        { session }
      );
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
