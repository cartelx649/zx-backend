const express = require('express');
const { getNonce, login } = require('../controllers/authController');

const router = express.Router();

router.post('/nonce', getNonce);
router.post('/login', login);

module.exports = router;
