const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { getDashboard } = require('../services/dashboardService');
const { getRoiProjection } = require('../services/roiCalculatorService');

const roiCalculatorSchema = Joi.object({
  password: Joi.string().required(),
  amount: Joi.number().positive().required(),
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  res.json({ ok: true, data: user });
});

const dashboard = asyncHandler(async (req, res) => {
  const data = await getDashboard(req.user.sub);
  res.json({ ok: true, data });
});

const roiCalculator = asyncHandler(async (req, res) => {
  const { password, amount } = await roiCalculatorSchema.validateAsync(req.query);
  if (password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_PASSWORD');
  }
  const data = await getRoiProjection(amount);
  res.json({ ok: true, data });
});

module.exports = { me, dashboard, roiCalculator };
