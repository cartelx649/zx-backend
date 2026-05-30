const User = require('../models/User');
const Cycle = require('../models/Cycle');
const Deposit = require('../models/Deposit');
const IncomeLedger = require('../models/IncomeLedger');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { generateReferralId } = require('../utils/referralId');
const { getConfig } = require('./configService');
const { resolveRoiSlab } = require('./depositService');
const {
  ROI_MULTIPLIER,
  CAP_MULTIPLIER,
  DIRECT_LEVEL_MULTIPLIER,
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

async function syncFromDataJson(data, opts = {}) {
  const logger = opts.logger || console;
  if (!data || !Array.isArray(data.rows)) {
    throw new ApiError(400, 'Invalid data.json shape: rows[] required', 'INVALID_SYNC_PAYLOAD');
  }

  const config = await getConfig();
  const stats = {
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
    await User.findOneAndUpdate(
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
      { upsert: true, new: true, setDefaultsOnInsert: true }
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

    const slab = resolveRoiSlab(row.deposited, config.roiSlabs) || {
      name: 'unknown',
      monthlyPercent: 0,
    };
    const packageAmount = row.deposited;
    const roiTarget = packageAmount * ROI_MULTIPLIER;
    const incomeCap = packageAmount * CAP_MULTIPLIER;
    const directLevelCap = packageAmount * DIRECT_LEVEL_MULTIPLIER;

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
    if (earnedDirect + earnedOverride > directLevelCap) {
      stats.overCapWarnings.push({
        address: row.address,
        kind: 'directLevel',
        expected: directLevelCap,
        actual: earnedDirect + earnedOverride,
      });
      logger.warn(
        `[sync] direct+level over-cap for ${row.address}: ${earnedDirect + earnedOverride} > ${directLevelCap}`
      );
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
    const directLevelSaturated = earnedDirect + earnedOverride >= directLevelCap;
    const totalSaturated = totalEarned >= incomeCap;
    const isActive = !(roiSaturated || directLevelSaturated || totalSaturated);

    await Cycle.findOneAndUpdate(
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
      { upsert: true, new: true, setDefaultsOnInsert: true }
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
    await Deposit.findOneAndUpdate(
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
      { upsert: true, new: true, setDefaultsOnInsert: true }
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
      await IncomeLedger.findOneAndUpdate(
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
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      stats.ledgerEntriesUpserted += 1;
    }
  }

  return stats;
}

module.exports = { syncFromDataJson, SYNTHETIC_MONTH_KEY };
