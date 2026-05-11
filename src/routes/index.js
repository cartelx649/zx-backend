const express = require('express');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const depositRoutes = require('./depositRoutes');
const withdrawalRoutes = require('./withdrawalRoutes');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/deposits', depositRoutes);
router.use('/withdrawals', withdrawalRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
