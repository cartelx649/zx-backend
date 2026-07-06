const mongoose = require('mongoose');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const { CAP_MULTIPLIER, ROI_MULTIPLIER } = require('../config/constants');

async function getActiveCycle(userId) {
  return Cycle.findOne({ userId, isActive: true });
}

async function createCycleForDeposit(user, packageAmount, session) {
  const active = await getActiveCycle(user._id);
  if (active) {
    // Same-cycle re-top-up: grow package + caps cumulatively, keep earned progress.
    // Monthly ROI is computed from the deposit history, so top-ups keep their own slab timing.
    active.packageAmount += packageAmount;
    active.roiTarget = active.packageAmount * ROI_MULTIPLIER;
    active.incomeCap = active.packageAmount * CAP_MULTIPLIER;
    await active.save({ session });
    user.totalDeposited += packageAmount;
    await user.save({ session });
    return { cycle: active, isTopup: true };
  }
  const nextCycleNumber = user.currentCycleNumber + 1;
  const cycle = await Cycle.create(
    [
      {
        userId: user._id,
        cycleNumber: nextCycleNumber,
        packageAmount,
        roiTarget: packageAmount * ROI_MULTIPLIER,
        incomeCap: packageAmount * CAP_MULTIPLIER,
      },
    ],
    { session }
  );
  user.currentCycleNumber = nextCycleNumber;
  user.isActive = true;
  user.totalDeposited += packageAmount;
  await user.save({ session });
  return { cycle: cycle[0], isTopup: false };
}

async function applyIncomeToCycle(cycleId, incomeType, amount, session = null) {
  const cycle = await Cycle.findById(cycleId).session(session);
  if (!cycle || !cycle.isActive) return { cycle: null, creditedAmount: 0 };

  const remainingTotal = Math.max(cycle.incomeCap - cycle.totalEarned, 0);
  let remainingType = remainingTotal;
  if (incomeType === 'roi') {
    remainingType = Math.max(cycle.roiTarget - cycle.earnedRoi, 0);
  }
  const remainingCap = Math.min(remainingTotal, remainingType);
  const creditedAmount = Math.max(0, Math.min(amount, remainingCap));
  if (creditedAmount <= 0) return { cycle, creditedAmount: 0 };

  if (incomeType === 'roi') cycle.earnedRoi += creditedAmount;
  if (incomeType === 'direct') cycle.earnedDirect += creditedAmount;
  if (incomeType === 'override') cycle.earnedOverride += creditedAmount;
  cycle.totalEarned = cycle.earnedRoi + cycle.earnedDirect + cycle.earnedOverride;

  const roiSaturated = cycle.earnedRoi >= cycle.roiTarget;
  const totalSaturated = cycle.totalEarned >= cycle.incomeCap;
  if (roiSaturated || totalSaturated) {
    cycle.isActive = false;
    cycle.closedAt = new Date();
    await User.findByIdAndUpdate(cycle.userId, { isActive: false }, { session });
  }
  await cycle.save({ session });
  return { cycle, creditedAmount };
}

async function withMongoTransaction(work) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

module.exports = { getActiveCycle, createCycleForDeposit, applyIncomeToCycle, withMongoTransaction };
