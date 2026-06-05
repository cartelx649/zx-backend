const mongoose = require('mongoose');
const User = require('../models/User');
const IncomeLedger = require('../models/IncomeLedger');
const ApiError = require('../utils/ApiError');
const { INCOME_TYPES, DIRECT_COMMISSION_PERCENT, MAX_OVERRIDE_LEVELS } = require('../config/constants');
const { getConfig } = require('./configService');
const { applyIncomeToCycle } = require('./cycleService');

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Normalize a month input ("2026-05", "2026-5", "May 2026") to a padded "YYYY-MM" key.
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
    return `${year}-${String(monthNum).padStart(2, '0')}`;
  }

  m = s.match(/^([A-Za-z]+)\s*,?\s*(\d{4})$/);
  if (m) {
    const monthNum = MONTH_NAMES[m[1].toLowerCase()];
    if (!monthNum) throw new ApiError(400, `Invalid month name: ${input}`, 'INVALID_MONTH');
    return `${Number(m[2])}-${String(monthNum).padStart(2, '0')}`;
  }

  throw new ApiError(400, `Unparseable month: ${input}`, 'INVALID_MONTH');
}

// Given a padded "YYYY-MM" key, return [padded, nonPadded] so legacy non-padded
// ledger rows (e.g. "2026-5") are not missed on read.
function monthKeyVariants(paddedKey) {
  const m = paddedKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return [paddedKey];
  const nonPadded = `${m[1]}-${Number(m[2])}`;
  return nonPadded === paddedKey ? [paddedKey] : [paddedKey, nonPadded];
}

// Total ROI credited to a user for a given month, read from the income ledger.
async function getMonthlyRoi(userId, month) {
  const key = parseMonthParam(month);
  const variants = monthKeyVariants(key);
  const rows = await IncomeLedger.aggregate([
    {
      $match: {
        beneficiaryUserId: new mongoose.Types.ObjectId(userId),
        type: INCOME_TYPES.ROI,
        monthKey: { $in: variants },
      },
    },
    { $group: { _id: null, totalRoi: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return {
    monthKey: key,
    totalRoi: rows[0]?.totalRoi || 0,
    count: rows[0]?.count || 0,
  };
}

async function creditIncome({
  beneficiaryUserId,
  sourceUserId,
  cycleId,
  type,
  amount,
  level = 0,
  note = '',
  session = null,
}) {
  const { creditedAmount } = await applyIncomeToCycle(cycleId, type, amount, session);
  if (creditedAmount <= 0) return null;
  const ledger = await IncomeLedger.create(
    [
      {
        beneficiaryUserId,
        sourceUserId,
        cycleId,
        type,
        amount: creditedAmount,
        level,
        note,
        monthKey: monthKey(),
      },
    ],
    { session }
  );
  return ledger[0];
}

async function creditDirectCommission({ sourceUser, sponsorUser, sourceCycleId, depositAmount, session }) {
  if (!sponsorUser) return null;
  const amount = (depositAmount * DIRECT_COMMISSION_PERCENT) / 100;
  const sponsorCycle = await require('./cycleService').getActiveCycle(sponsorUser._id);
  if (!sponsorCycle) return null;
  return creditIncome({
    beneficiaryUserId: sponsorUser._id,
    sourceUserId: sourceUser._id,
    cycleId: sponsorCycle._id,
    type: INCOME_TYPES.DIRECT,
    amount,
    note: `Direct commission from cycle ${sourceCycleId}`,
    session,
  });
}

async function creditOverrideOnRoi({ roiBeneficiaryUser, roiAmount, session }) {
  const config = await getConfig();
  const visited = new Set([roiBeneficiaryUser.walletAddress]);
  let currentSponsorWallet = roiBeneficiaryUser.sponsorWalletAddress;
  for (let level = 1; level <= MAX_OVERRIDE_LEVELS && currentSponsorWallet; level += 1) {
    if (visited.has(currentSponsorWallet)) {
      console.warn(
        `[override] Cycle detected for user ${roiBeneficiaryUser._id} ` +
          `(wallet ${currentSponsorWallet}) — stopping chain at level ${level}`
      );
      break;
    }
    visited.add(currentSponsorWallet);
    const percent = config.overridePercentages.find((x) => x.level === level)?.percent || 0;
    const sponsor = await User.findOne({ walletAddress: currentSponsorWallet }).session(session);
    if (!sponsor) break;
    if (percent > 0) {
      const sponsorCycle = await require('./cycleService').getActiveCycle(sponsor._id);
      if (sponsorCycle) {
        const amount = (roiAmount * percent) / 100;
        await creditIncome({
          beneficiaryUserId: sponsor._id,
          sourceUserId: roiBeneficiaryUser._id,
          cycleId: sponsorCycle._id,
          type: INCOME_TYPES.OVERRIDE,
          amount,
          level,
          note: 'Level override from ROI credit',
          session,
        });
      }
    }
    currentSponsorWallet = sponsor.sponsorWalletAddress;
  }
}

module.exports = { creditIncome, creditDirectCommission, creditOverrideOnRoi, monthKey, getMonthlyRoi };
