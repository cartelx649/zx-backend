const express = require('express');
const auth = require('../middlewares/auth');
const idempotency = require('../middlewares/idempotency');
const { request, listMine, pay } = require('../controllers/withdrawalController');

const router = express.Router();

router.post('/', auth('user'), idempotency(), request);
router.get('/mine', auth(), listMine);
router.post('/:withdrawalId/pay', auth('admin'), pay);

module.exports = router;
