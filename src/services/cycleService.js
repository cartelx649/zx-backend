const mongoose = require('mongoose');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const { CAP_MULTIPLIER, ROI_MULTIPLIER } = require('../config/constants');
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
  if (!cycle || !cycle.isActive) {
    throw new ApiError(400, 'Active cycle not found', 'CYCLE_NOT_ACTIVE');
  }
  if (incomeType === 'roi') cycle.earnedRoi += amount;
  if (incomeType === 'direct') cycle.earnedDirect += amount;
  if (incomeType === 'override') cycle.earnedOverride += amount;
  cycle.totalEarned = cycle.earnedRoi + cycle.earnedDirect + cycle.earnedOverride;
  if (cycle.earnedRoi >= cycle.roiTarget || cycle.totalEarned >= cycle.incomeCap) {
    cycle.isActive = false;
    cycle.closedAt = new Date();
    await User.findByIdAndUpdate(cycle.userId, { isActive: false }, { session });
  }
  await cycle.save({ session });
  return cycle;
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
