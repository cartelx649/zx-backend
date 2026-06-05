const express = require('express');
const auth = require('../middlewares/auth');
const { me, dashboard, roiCalculator } = require('../controllers/userController');

const router = express.Router();

router.get('/me', auth(), me);
router.get('/dashboard', auth(), dashboard);
router.get('/roi-calculator', roiCalculator);

module.exports = router;
