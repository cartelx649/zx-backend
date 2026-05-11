const User = require('../models/User');
const IncomeLedger = require('../models/IncomeLedger');
const { INCOME_TYPES, DIRECT_COMMISSION_PERCENT, MAX_OVERRIDE_LEVELS } = require('../config/constants');
const { getConfig } = require('./configService');
const { applyIncomeToCycle } = require('./cycleService');

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
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
  const ledger = await IncomeLedger.create(
    [{ beneficiaryUserId, sourceUserId, cycleId, type, amount, level, note, monthKey: monthKey() }],
    { session }
  );
  await applyIncomeToCycle(cycleId, type, amount, session);
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
  let currentSponsorWallet = roiBeneficiaryUser.sponsorWalletAddress;
  for (let level = 1; level <= MAX_OVERRIDE_LEVELS && currentSponsorWallet; level += 1) {
    const percent = config.overridePercentages.find((x) => x.level === level)?.percent || 0;
    if (percent <= 0) continue;
    const sponsor = await User.findOne({ walletAddress: currentSponsorWallet }).session(session);
    if (!sponsor) break;
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
    currentSponsorWallet = sponsor.sponsorWalletAddress;
  }
}

module.exports = { creditIncome, creditDirectCommission, creditOverrideOnRoi, monthKey };
