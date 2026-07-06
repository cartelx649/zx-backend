const User = require('../models/User');
const Cycle = require('../models/Cycle');
const Deposit = require('../models/Deposit');
const IncomeLedger = require('../models/IncomeLedger');
const SyncBatch = require('../models/SyncBatch');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { generateReferralId } = require('../utils/referralId');
const { getConfig } = require('./configService');
const { resolveRoiSlab } = require('./depositService');
const { withMongoTransaction } = require('./cycleService');
const {
  ROI_MULTIPLIER,
  CAP_MULTIPLIER,
  INCOME_TYPES,
} = require('../config/constants');

const SYNTHETIC_MONTH_KEY = 'sync-historical';

function normalizeWallet(value) {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
}

function parseRow(row) {
  const address = normalizeWallet(row.Address);
  if (!address) return null;
  return {
    address,
    referrer: normalizeWallet(row.Referrer),
    deposited: Number(row['Deposited (USD)']) || 0,
    roiAccrued: Number(row['ROI Accrued est. (USD)']) || 0,
    referralRewards: Number(row['Referral Rewards Claimed (USD)']) || 0,
  };
}

function emptyInsertedIds() {
  return { users: [], cycles: [], deposits: [], ledger: [] };
}

/**
 * Upsert a document and, when it was newly inserted (not matched), record its _id
 * into the given bucket so a later unsync can delete exactly what this batch created.
 */
async function upsertTracked(Model, filter, update, bucket, insertedIds) {
  const res = await Model.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
    includeResultMetadata: true,
  });
  const upsertedId = res.lastErrorObject && res.lastErrorObject.upserted;
  if (upsertedId && insertedIds) {
    insertedIds[bucket].push(upsertedId);
  }
  return res.value;
}

async function syncFromDataJson(data, opts = {}) {
  const logger = opts.logger || console;
  if (!data || !Array.isArray(data.rows)) {
    throw new ApiError(400, 'Invalid data.json shape: rows[] required', 'INVALID_SYNC_PAYLOAD');
  }

  const config = await getConfig();
  const insertedIds = emptyInsertedIds();
  const stats = {
    batchId: opts.batchId || null,
    rowsProcessed: 0,
    usersUpserted: 0,
    cyclesUpserted: 0,
    depositsUpserted: 0,
    ledgerEntriesUpserted: 0,
    overCapWarnings: [],
  };

  const parsed = data.rows.map(parseRow).filter(Boolean);

  // Pass 1: upsert User by walletAddress (no sponsor yet).
  for (const row of parsed) {
    const role = row.address === env.adminWallet ? 'admin' : 'user';
    await upsertTracked(
      User,
      { walletAddress: row.address },
      {
        $setOnInsert: {
          walletAddress: row.address,
          referralId: generateReferralId(),
          role,
          currentCycleNumber: 1,
        },
        $set: { totalDeposited: row.deposited },
      },
      'users',
      insertedIds
    );
    stats.usersUpserted += 1;
  }

  // Pass 2: attach sponsorWalletAddress only when the referrer exists as a User.
  for (const row of parsed) {
    if (!row.referrer) continue;
    const sponsor = await User.findOne({ walletAddress: row.referrer }).select({ _id: 1 });
    if (!sponsor) continue;
    await User.updateOne(
      { walletAddress: row.address },
      { $set: { sponsorWalletAddress: row.referrer } }
    );
  }

  // Resolve user IDs once for the next passes.
  const userByAddress = new Map();
  const userDocs = await User.find({ walletAddress: { $in: parsed.map((r) => r.address) } }).select({
    _id: 1,
    walletAddress: 1,
  });
  for (const u of userDocs) userByAddress.set(u.walletAddress, u._id);

  // Pass 3: upsert Cycle (cycleNumber=1).
  for (const row of parsed) {
    stats.rowsProcessed += 1;
    const userId = userByAddress.get(row.address);
    if (!userId) continue;

    const packageAmount = row.deposited;
    const roiTarget = packageAmount * ROI_MULTIPLIER;
    const incomeCap = packageAmount * CAP_MULTIPLIER;

    const earnedRoi = row.roiAccrued;
    const earnedDirect = row.referralRewards;
    const earnedOverride = 0;
    const totalEarned = earnedRoi + earnedDirect + earnedOverride;

    if (earnedRoi > roiTarget) {
      stats.overCapWarnings.push({
        address: row.address,
        kind: 'roi',
        expected: roiTarget,
        actual: earnedRoi,
      });
      logger.warn(`[sync] ROI over-cap for ${row.address}: ${earnedRoi} > ${roiTarget}`);
    }
    if (totalEarned > incomeCap) {
      stats.overCapWarnings.push({
        address: row.address,
        kind: 'total',
        expected: incomeCap,
        actual: totalEarned,
      });
      logger.warn(`[sync] total over-cap for ${row.address}: ${totalEarned} > ${incomeCap}`);
    }
    const roiSaturated = earnedRoi >= roiTarget;
    const totalSaturated = totalEarned >= incomeCap;
    const isActive = !(roiSaturated || totalSaturated);

    await upsertTracked(
      Cycle,
      { userId, cycleNumber: 1 },
      {
        $set: {
          packageAmount,
          roiTarget,
          incomeCap,
          earnedRoi,
          earnedDirect,
          earnedOverride,
          totalEarned,
          isActive,
          closedAt: isActive ? null : new Date(),
        },
        $setOnInsert: { userId, cycleNumber: 1, startedAt: new Date() },
      },
      'cycles',
      insertedIds
    );
    stats.cyclesUpserted += 1;
  }

  // Resolve cycle IDs.
  const cycleByUser = new Map();
  const cycleDocs = await Cycle.find({
    userId: { $in: Array.from(userByAddress.values()) },
    cycleNumber: 1,
  }).select({ _id: 1, userId: 1 });
  for (const c of cycleDocs) cycleByUser.set(String(c.userId), c._id);

  // Pass 4: upsert synthetic Deposit.
  for (const row of parsed) {
    const userId = userByAddress.get(row.address);
    const cycleId = userId && cycleByUser.get(String(userId));
    if (!userId || !cycleId) continue;
    const slab = resolveRoiSlab(row.deposited, config.roiSlabs) || {
      name: 'unknown',
      monthlyPercent: 0,
    };
    await upsertTracked(
      Deposit,
      { txHash: `synced-${row.address}` },
      {
        $set: {
          userId,
          cycleId,
          amount: row.deposited,
          packageType: slab.name,
          roiSlabName: slab.name,
          receiverAddress: env.depositContractAddress || row.address,
          treasuryWallet: null,
          chainConfirmations: 0,
          status: 'verified',
        },
        $setOnInsert: { txHash: `synced-${row.address}` },
      },
      'deposits',
      insertedIds
    );
    stats.depositsUpserted += 1;
  }

  // Pass 5: upsert synthetic IncomeLedger rows (one ROI, one direct) per row.
  for (const row of parsed) {
    const userId = userByAddress.get(row.address);
    const cycleId = userId && cycleByUser.get(String(userId));
    if (!userId || !cycleId) continue;

    const ledgerEntries = [
      { type: INCOME_TYPES.ROI, amount: row.roiAccrued, note: 'Imported ROI from data.json' },
      {
        type: INCOME_TYPES.DIRECT,
        amount: row.referralRewards,
        note: 'Imported direct+level rewards from data.json',
      },
    ];
    for (const entry of ledgerEntries) {
      if (entry.amount <= 0) continue;
      await upsertTracked(
        IncomeLedger,
        {
          beneficiaryUserId: userId,
          sourceUserId: userId,
          type: entry.type,
          monthKey: SYNTHETIC_MONTH_KEY,
          level: 0,
          cycleId,
        },
        {
          $set: { amount: entry.amount, note: entry.note },
        },
        'ledger',
        insertedIds
      );
      stats.ledgerEntriesUpserted += 1;
    }
  }

  stats.insertedCounts = {
    users: insertedIds.users.length,
    cycles: insertedIds.cycles.length,
    deposits: insertedIds.deposits.length,
    ledger: insertedIds.ledger.length,
  };

  // Persist a revertable batch record only when a batchId is supplied.
  // The legacy /sync-data-json route calls without one and keeps its pure-upsert behavior.
  if (opts.batchId) {
    await SyncBatch.create({
      batchId: opts.batchId,
      source: opts.source || 'data.json',
      status: 'applied',
      stats,
      insertedIds,
    });
  }

  return stats;
}

/**
 * Delete-only revert: removes ONLY the documents this batch newly inserted.
 * Documents that pre-existed and were merely field-updated are intentionally left
 * intact (accepted trade-off of the delete-only revert model).
 */
async function unsyncBatch(batchId) {
  if (!batchId) {
    throw new ApiError(400, 'batchId is required', 'INVALID_BATCH_ID');
  }
  const batch = await SyncBatch.findOne({ batchId });
  if (!batch) {
    throw new ApiError(404, `Sync batch not found: ${batchId}`, 'SYNC_BATCH_NOT_FOUND');
  }
  if (batch.status === 'reverted') {
    throw new ApiError(409, `Sync batch already reverted: ${batchId}`, 'SYNC_BATCH_ALREADY_REVERTED');
  }

  const deleted = await withMongoTransaction(async (session) => {
    const ledger = await IncomeLedger.deleteMany(
      { _id: { $in: batch.insertedIds.ledger } },
      { session }
    );
    const deposits = await Deposit.deleteMany(
      { _id: { $in: batch.insertedIds.deposits } },
      { session }
    );
    const cycles = await Cycle.deleteMany({ _id: { $in: batch.insertedIds.cycles } }, { session });
    const users = await User.deleteMany({ _id: { $in: batch.insertedIds.users } }, { session });

    batch.status = 'reverted';
    batch.revertedAt = new Date();
    await batch.save({ session });

    return {
      ledger: ledger.deletedCount,
      deposits: deposits.deletedCount,
      cycles: cycles.deletedCount,
      users: users.deletedCount,
    };
  });

  return { batchId, status: 'reverted', deleted };
}

// Single-digit month (e.g. "2026-5"); excludes padded keys and "sync-historical".
const NON_PADDED_MONTH_KEY = /^(\d{4})-(\d)$/;

function padMonthKey(nonPadded) {
  const m = nonPadded.match(NON_PADDED_MONTH_KEY);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

/**
 * Normalize IncomeLedger.monthKey from non-padded "YYYY-M" to padded "YYYY-MM".
 * On a unique-index collision (a padded twin already exists for the same
 * beneficiary/source/type/level/cycle), the non-padded row's amount is summed
 * into the twin and the non-padded row deleted; otherwise it is updated in place.
 *
 * @param {{ dry?: boolean, sampleLimit?: number }} opts
 */
async function fixLedgerMonthKeys({ dry = false, sampleLimit = 100 } = {}) {
  const candidates = await IncomeLedger.find({ monthKey: { $regex: NON_PADDED_MONTH_KEY } }).lean();
  const counts = { updated: 0, merged: 0, skipped: 0 };
  const changes = [];

  for (const doc of candidates) {
    const target = padMonthKey(doc.monthKey);
    if (!target) {
      counts.skipped += 1;
      continue;
    }

    const twin = await IncomeLedger.findOne({
      beneficiaryUserId: doc.beneficiaryUserId,
      sourceUserId: doc.sourceUserId,
      type: doc.type,
      monthKey: target,
      level: doc.level,
      cycleId: doc.cycleId,
      _id: { $ne: doc._id },
    }).lean();

    if (twin) {
      if (!dry) {
        await IncomeLedger.updateOne({ _id: twin._id }, { $inc: { amount: doc.amount } });
        await IncomeLedger.deleteOne({ _id: doc._id });
      }
      counts.merged += 1;
      if (changes.length < sampleLimit) {
        changes.push({ action: 'merge', id: String(doc._id), from: doc.monthKey, to: target, amount: doc.amount, into: String(twin._id) });
      }
    } else {
      if (!dry) {
        await IncomeLedger.updateOne({ _id: doc._id }, { $set: { monthKey: target } });
      }
      counts.updated += 1;
      if (changes.length < sampleLimit) {
        changes.push({ action: 'update', id: String(doc._id), from: doc.monthKey, to: target });
      }
    }
  }

  return {
    dry,
    scanned: candidates.length,
    ...counts,
    changes,
    changesTruncated: candidates.length > changes.length,
  };
}

module.exports = { syncFromDataJson, unsyncBatch, fixLedgerMonthKeys, SYNTHETIC_MONTH_KEY };
