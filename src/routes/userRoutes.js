const express = require('express');
const auth = require('../middlewares/auth');
const { me, dashboard, roiCalculator, monthlyRoi, withdrawableIncome } = require('../controllers/userController');

const router = express.Router();

router.get('/me', auth(), me);
router.get('/dashboard', auth(), dashboard);
router.get('/roi-calculator', roiCalculator);
router.get('/income/monthly-roi', auth(), monthlyRoi);
router.get('/income/withdrawable', auth(), withdrawableIncome);

module.exports = router;
