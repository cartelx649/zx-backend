const User = require('../models/User');
const { getConfig } = require('./configService');
const { getActiveCycle, withMongoTransaction } = require('./cycleService');
const { creditIncome, creditOverrideOnRoi } = require('./incomeService');
const { INCOME_TYPES } = require('../config/constants');

async function runMonthlyRoiAccrual() {
  console.log('[roiJob] Starting monthly ROI accrual');
  const config = await getConfig();
  const activeUsers = await User.find({ isActive: true });
  console.log(`[roiJob] Found ${activeUsers.length} active users`);
  let processed = 0;
  let credited = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of activeUsers) {
    processed += 1;
    try {
      // Sequential monthly credit keeps cap checks deterministic.
      await withMongoTransaction(async (session) => {
        const cycle = await getActiveCycle(user._id);
        if (!cycle) {
          console.log(`[roiJob] User ${user._id} skipped: no active cycle`);
          skipped += 1;
          return;
        }
        const slab = config.roiSlabs.find(
          (item) =>
            cycle.packageAmount >= item.min && (item.max === null || cycle.packageAmount <= item.max)
        );
        if (!slab) {
          console.log(`[roiJob] User ${user._id} skipped: no matching ROI slab for package ${cycle.packageAmount}`);
          skipped += 1;
          return;
        }
        const monthlyRoiAmount = (cycle.packageAmount * slab.monthlyPercent) / 100;
        const availableForRoi = Math.min(
          Math.max(cycle.roiTarget - cycle.earnedRoi, 0),
          Math.max(cycle.incomeCap - cycle.totalEarned, 0)
        );
        const roiAmount = Math.min(monthlyRoiAmount, availableForRoi);
        if (roiAmount <= 0) {
          console.log(
            `[roiJob] User ${user._id} skipped: cap reached ` +
              `(roi ${cycle.earnedRoi}/${cycle.roiTarget}, total ${cycle.totalEarned}/${cycle.incomeCap})`
          );
          skipped += 1;
          return;
        }
        console.log(`[roiJob] Crediting ROI ${roiAmount} to user ${user._id} (cycle ${cycle._id})`);
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
        credited += 1;
        console.log(`[roiJob] User ${user._id} credited successfully`);
      });
    } catch (error) {
      failed += 1;
      console.error(`[roiJob] User ${user._id} failed:`, error.message);
    }
  }
  console.log(`[roiJob] Completed. processed=${processed} credited=${credited} skipped=${skipped} failed=${failed}`);
}

module.exports = { runMonthlyRoiAccrual };
