const express = require('express');
const { getNonce, login, backendLoginHandler } = require('../controllers/authController');

const router = express.Router();

router.post('/nonce', getNonce);
router.post('/login', login);
router.post('/backend-login', backendLoginHandler);

module.exports = router;
