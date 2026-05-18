const crypto = require('crypto');
const User = require('../models/User');
const Deposit = require('../models/Deposit');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { getConfig } = require('./configService');
const { verifyUsdtDeposit } = require('./blockchainService');
const { createCycleForDeposit, withMongoTransaction } = require('./cycleService');
const { creditDirectCommission } = require('./incomeService');
const Cycle = require('../models/Cycle');

function resolveRoiSlab(amount, roiSlabs) {
  return roiSlabs.find((slab) => amount >= slab.min && (slab.max === null || amount <= slab.max));
}

async function resolveSponsorAndValidate({ user, sponsorWalletAddress, amount }) {
  if (!user.sponsorWalletAddress) {
    if (!sponsorWalletAddress) {
      throw new ApiError(400, 'Sponsor wallet not registered', 'INVALID_SPONSOR');
    }
    const incomingSponsor = sponsorWalletAddress.toLowerCase();
    const sponsorUser = await User.findOne({ walletAddress: incomingSponsor });
    if (!sponsorUser) {
      throw new ApiError(400, 'Sponsor wallet not registered', 'INVALID_SPONSOR');
    }
    user.sponsorWalletAddress = incomingSponsor;
    await user.save();
  }

  const config = await getConfig();
  if (config.emergencyPause) {
    throw new ApiError(423, 'Platform is temporarily paused', 'EMERGENCY_PAUSE_ENABLED');
  }
  const slab = resolveRoiSlab(amount, config.roiSlabs);
  if (!slab) throw new ApiError(400, 'Package amount does not match any ROI slab', 'INVALID_PACKAGE');

  const previousCycle = await Cycle.findOne({ userId: user._id }).sort({ cycleNumber: -1 });
  if (previousCycle && !previousCycle.isActive && amount < previousCycle.packageAmount) {
    throw new ApiError(
      400,
      'Re-topup must be same or higher than previous package',
      'INVALID_RETOPUP_AMOUNT'
    );
  }
  return slab;
}

async function persistVerifiedDeposit({ user, amount, txHash, slab }) {
  return withMongoTransaction(async (session) => {
    const cycle = await createCycleForDeposit(user, amount, session);
    const deposit = await Deposit.create(
      [
        {
          userId: user._id,
          cycleId: cycle._id,
          txHash,
          amount,
          packageType: slab.name,
          roiSlabName: slab.name,
          receiverAddress: env.depositContractAddress,
          treasuryWallet: null,
          chainConfirmations: env.chainConfirmations,
          status: 'verified',
        },
      ],
      { session }
    );

    if (user.sponsorWalletAddress) {
      const sponsor = await User.findOne({ walletAddress: user.sponsorWalletAddress }).session(session);
      await creditDirectCommission({
        sourceUser: user,
        sponsorUser: sponsor,
        sourceCycleId: cycle._id,
        depositAmount: amount,
        session,
      });
    }
    return { cycle, deposit: deposit[0] };
  });
}

async function verifyAndRecordDeposit({ userId, txHash, amount, sponsorWalletAddress }) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');

  const slab = await resolveSponsorAndValidate({ user, sponsorWalletAddress, amount });

  await verifyUsdtDeposit({
    txHash: txHash.toLowerCase(),
    expectedFrom: user.walletAddress,
    expectedTo: env.depositContractAddress,
    expectedAmount: amount,
  });

  return persistVerifiedDeposit({ user, amount, txHash: txHash.toLowerCase(), slab });
}

async function recordVirtualDeposit({ userId, amount, sponsorWalletAddress }) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found', 'USER_NOT_FOUND');

  const slab = await resolveSponsorAndValidate({ user, sponsorWalletAddress, amount });
  const txHash = `virtual-${crypto.randomUUID()}`;

  return persistVerifiedDeposit({ user, amount, txHash, slab });
}

module.exports = { verifyAndRecordDeposit, recordVirtualDeposit, resolveRoiSlab };
