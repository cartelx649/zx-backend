const express = require('express');
const auth = require('../middlewares/auth');
const { kpis, config, update, syncDataJson } = require('../controllers/adminController');

const router = express.Router();

router.get('/kpis', auth('admin'), kpis);
router.get('/config', auth('admin'), config);
router.patch('/config', auth('admin'), update);
router.post('/sync-data-json', syncDataJson);

module.exports = router;
