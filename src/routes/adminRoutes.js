const express = require('express');
const auth = require('../middlewares/auth');
const {
  kpis,
  config,
  update,
  syncDataJson,
  syncRoiReport,
  unsyncRoiReport,
  listSyncBatches,
  incomeOverview,
  monthlyUserIncome,
  adminWithdrawableIncome,
  adminAllUsersWithdrawableIncome,
  fixLedgerMonthKeysHandler,
} = require('../controllers/adminController');

const router = express.Router();

router.get('/kpis', auth('admin'), kpis);
router.get('/config', auth('admin'), config);
router.patch('/config', auth('admin'), update);
router.post('/sync-data-json', syncDataJson);
router.post('/sync-roi-report', syncRoiReport);
router.post('/unsync-roi-report', unsyncRoiReport);
router.get('/sync-batches', listSyncBatches);
router.get('/income-overview', incomeOverview);
router.get('/monthly-user-income', monthlyUserIncome);
router.get('/income/withdrawable', adminAllUsersWithdrawableIncome);
router.get('/users/:userId/income/withdrawable', adminWithdrawableIncome);
router.post('/fix-ledger-monthkeys', fixLedgerMonthKeysHandler);

module.exports = router;
