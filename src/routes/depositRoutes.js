const express = require('express');
const auth = require('../middlewares/auth');
const idempotency = require('../middlewares/idempotency');
const { verifyDeposit, createVirtualDeposit } = require('../controllers/depositController');

const router = express.Router();

router.post('/verify', auth('user'), idempotency(), verifyDeposit);
router.post('/virtual', idempotency(), createVirtualDeposit);

module.exports = router;
