#!/usr/bin/env node

global.crypto = require('node:crypto').webcrypto;

const mongoose = require('mongoose');
const Withdrawal = require('../src/models/Withdrawal');
const User = require('../src/models/User');
const Cycle = require('../src/models/Cycle');
const IncomeLedger = require('../src/models/IncomeLedger');

function round8(value) {
  return Math.round((value + Number.EPSILON) * 100000000) / 100000000;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    sourceMonth: '2026-07',
    targetMonth: '2026-08',
    exclude: [],
  };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--source-month=')) args.sourceMonth = arg.slice('--source-month='.length);
    else if (arg.startsWith('--target-month=')) args.targetMonth = arg.slice('--target-month='.length);
    else if (arg.startsWith('--exclude=')) {
      args.exclude = arg
        .slice('--exclude='.length)
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const excludedWallets = new Set(args.exclude);

  await mongoose.connect(process.env.MONGODB_URI);

  const withdrawals = await Withdrawal.find({
    monthKey: args.sourceMonth,
    status: 'paid',
    incomeType: { $in: ['roi', 'override'] },
  }).lean();

  const userIds = [...new Set(withdrawals.map((item) => String(item.userId)))];
  const [users, cycles, earnedRows] = await Promise.all([
    User.find({ _id: { $in: userIds } }, { walletAddress: 1 }).lean(),
    Cycle.find({ userId: { $in: userIds } }).sort({ createdAt: -1 }).lean(),
    IncomeLedger.aggregate([
      { $match: { monthKey: args.sourceMonth, type: { $in: ['roi', 'override'] } } },
      { $group: { _id: { userId: '$beneficiaryUserId', type: '$type' }, total: { $sum: '$amount' } } },
    ]),
  ]);

  const walletByUserId = new Map(users.map((user) => [String(user._id), (user.walletAddress || '').toLowerCase()]));
  const latestCycleByUserId = new Map();
  for (const cycle of cycles) {
    const key = String(cycle.userId);
    if (!latestCycleByUserId.has(key)) latestCycleByUserId.set(key, cycle);
  }

  const earnedByUser = new Map();
  for (const row of earnedRows) {
    const uid = String(row._id.userId);
    if (!earnedByUser.has(uid)) earnedByUser.set(uid, { roi: 0, override: 0 });
    earnedByUser.get(uid)[row._id.type] = round8(row.total || 0);
  }

  const paidByUser = new Map();
  for (const withdrawal of withdrawals) {
    const uid = String(withdrawal.userId);
    const wallet = walletByUserId.get(uid) || '';
    if (excludedWallets.has(wallet)) continue;
    if (!paidByUser.has(uid)) {
      paidByUser.set(uid, { walletAddress: wallet, roi: 0, override: 0 });
    }
    paidByUser.get(uid)[withdrawal.incomeType] += withdrawal.approvedAmount || 0;
  }

  const adjustments = [];
  for (const [uid, paid] of paidByUser.entries()) {
    const earned = earnedByUser.get(uid) || { roi: 0, override: 0 };
    const cycle = latestCycleByUserId.get(uid);
    if (!cycle) continue;

    const roiExtra = round8(Math.max((paid.roi || 0) - (earned.roi || 0), 0));
    const overrideExtra = round8(Math.max((paid.override || 0) - (earned.override || 0), 0));

    if (roiExtra > 0) {
      adjustments.push({
        beneficiaryUserId: uid,
        sourceUserId: uid,
        cycleId: String(cycle._id),
        type: 'roi',
        level: 0,
        monthKey: args.targetMonth,
        amount: -roiExtra,
        walletAddress: paid.walletAddress,
        note: `Admin adjustment for overpaid ROI from ${args.sourceMonth}`,
      });
    }

    if (overrideExtra > 0) {
      adjustments.push({
        beneficiaryUserId: uid,
        sourceUserId: uid,
        cycleId: String(cycle._id),
        type: 'override',
        level: 0,
        monthKey: args.targetMonth,
        amount: -overrideExtra,
        walletAddress: paid.walletAddress,
        note: `Admin adjustment for overpaid level income from ${args.sourceMonth}`,
      });
    }
  }

  const summary = {
    apply: args.apply,
    sourceMonth: args.sourceMonth,
    targetMonth: args.targetMonth,
    excludedWallets: args.exclude,
    adjustmentCount: adjustments.length,
    adjustments,
    totals: {
      roi: round8(adjustments.filter((item) => item.type === 'roi').reduce((sum, item) => sum + item.amount, 0)),
      override: round8(adjustments.filter((item) => item.type === 'override').reduce((sum, item) => sum + item.amount, 0)),
      combined: round8(adjustments.reduce((sum, item) => sum + item.amount, 0)),
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
    for (const adjustment of adjustments) {
      await IncomeLedger.findOneAndUpdate(
        {
          beneficiaryUserId: adjustment.beneficiaryUserId,
          sourceUserId: adjustment.sourceUserId,
          cycleId: adjustment.cycleId,
          type: adjustment.type,
          level: adjustment.level,
          monthKey: adjustment.monthKey,
        },
        {
          $set: {
            amount: adjustment.amount,
            note: adjustment.note,
          },
        },
        {
          upsert: true,
          setDefaultsOnInsert: true,
          session,
        }
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
