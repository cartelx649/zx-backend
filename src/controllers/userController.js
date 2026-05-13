const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');
const { getDashboard } = require('../services/dashboardService');

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  res.json({ ok: true, data: user });
});

const dashboard = asyncHandler(async (req, res) => {
  const data = await getDashboard(req.user.sub);
  res.json({ ok: true, data });
});

module.exports = { me, dashboard };
