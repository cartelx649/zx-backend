const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const Withdrawal = require('../models/Withdrawal');
const { requestWithdrawal, payWithdrawal } = require('../services/withdrawalService');

const requestSchema = Joi.object({
  amount: Joi.number().positive().required(),
});

const request = asyncHandler(async (req, res) => {
  const { amount } = await requestSchema.validateAsync(req.body);
  const data = await requestWithdrawal(req.user.sub, amount);
  res.status(201).json({ ok: true, data });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await Withdrawal.find({ userId: req.user.sub }).sort({ createdAt: -1 }).lean();
  res.json({ ok: true, data });
});

const pay = asyncHandler(async (req, res) => {
  const data = await payWithdrawal(req.params.withdrawalId, req.user.sub);
  res.json({ ok: true, data });
});

module.exports = { request, listMine, pay };
