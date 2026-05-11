const express = require('express');
const auth = require('../middlewares/auth');
const { me, dashboard } = require('../controllers/userController');

const router = express.Router();

router.get('/me', auth(), me);
router.get('/dashboard', auth(), dashboard);

module.exports = router;
