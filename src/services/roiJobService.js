const User = require('../models/User');
const { getConfig } = require('./configService');
const { getActiveCycle, withMongoTransaction } = require('./cycleService');
const { creditIncome, creditOverrideOnRoi } = require('./incomeService');
const { INCOME_TYPES } = require('../config/constants');

async function runMonthlyRoiAccrual() {
  const config = await getConfig();
  const activeUsers = await User.find({ isActive: true });
  for (const user of activeUsers) {
    // Sequential monthly credit keeps cap checks deterministic.
    await withMongoTransaction(async (session) => {
      const cycle = await getActiveCycle(user._id);
      if (!cycle) return;
      const slab = config.roiSlabs.find(
        (item) =>
          cycle.packageAmount >= item.min && (item.max === null || cycle.packageAmount <= item.max)
      );
      if (!slab) return;
      const monthlyRoiAmount = (cycle.packageAmount * slab.monthlyPercent) / 100;
      const availableRoi = Math.max(cycle.roiTarget - cycle.earnedRoi, 0);
      const roiAmount = Math.min(monthlyRoiAmount, availableRoi);
      if (roiAmount <= 0) return;
      await creditIncome({
        beneficiaryUserId: user._id,
        sourceUserId: user._id,
        cycleId: cycle._id,
        type: INCOME_TYPES.ROI,
        amount: roiAmount,
        note: 'Monthly ROI accrual',
        session,
      });
      await creditOverrideOnRoi({ roiBeneficiaryUser: user, roiAmount, session });
    });
  }
}

module.exports = { runMonthlyRoiAccrual };
