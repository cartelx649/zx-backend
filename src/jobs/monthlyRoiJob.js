const cron = require('node-cron');
const { runMonthlyRoiAccrual } = require('../services/roiJobService');

function startMonthlyRoiJob() {
  cron.schedule('36 10 5 6 *', async () => {
    try {
      await runMonthlyRoiAccrual();
      console.log('Monthly ROI job completed.');
    } catch (error) {
      console.error('Monthly ROI job failed:', error.message);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
}

module.exports = { startMonthlyRoiJob };
