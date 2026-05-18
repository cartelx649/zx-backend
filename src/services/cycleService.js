const mongoose = require('mongoose');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const { CAP_MULTIPLIER, ROI_MULTIPLIER, DIRECT_LEVEL_MULTIPLIER } = require('../config/constants');
const ApiError = require('../utils/ApiError');

async function getActiveCycle(userId) {
  return Cycle.findOne({ userId, isActive: true });
}

async function createCycleForDeposit(user, packageAmount, session) {
  const active = await getActiveCycle(user._id);
  if (active) {
    throw new ApiError(400, 'Active cycle already exists', 'ACTIVE_CYCLE_EXISTS');
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
  return cycle[0];
}

async function applyIncomeToCycle(cycleId, incomeType, amount, session = null) {
  const cycle = await Cycle.findById(cycleId).session(session);
  if (!cycle || !cycle.isActive) return { cycle: null, creditedAmount: 0 };

  const remainingTotal = Math.max(cycle.incomeCap - cycle.totalEarned, 0);
  let remainingType = remainingTotal;
  if (incomeType === 'roi') {
    remainingType = Math.max(cycle.roiTarget - cycle.earnedRoi, 0);
  } else if (incomeType === 'direct' || incomeType === 'override') {
    const directLevelCap = cycle.packageAmount * DIRECT_LEVEL_MULTIPLIER;
    remainingType = Math.max(directLevelCap - (cycle.earnedDirect + cycle.earnedOverride), 0);
  }
  const remainingCap = Math.min(remainingTotal, remainingType);
  const creditedAmount = Math.max(0, Math.min(amount, remainingCap));
  if (creditedAmount <= 0) return { cycle, creditedAmount: 0 };

  if (incomeType === 'roi') cycle.earnedRoi += creditedAmount;
  if (incomeType === 'direct') cycle.earnedDirect += creditedAmount;
  if (incomeType === 'override') cycle.earnedOverride += creditedAmount;
  cycle.totalEarned = cycle.earnedRoi + cycle.earnedDirect + cycle.earnedOverride;

  const directLevelCap = cycle.packageAmount * DIRECT_LEVEL_MULTIPLIER;
  const roiSaturated = cycle.earnedRoi >= cycle.roiTarget;
  const directLevelSaturated = cycle.earnedDirect + cycle.earnedOverride >= directLevelCap;
  const totalSaturated = cycle.totalEarned >= cycle.incomeCap;
  if (roiSaturated || directLevelSaturated || totalSaturated) {
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
