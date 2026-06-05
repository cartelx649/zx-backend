const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const Withdrawal = require('../models/Withdrawal');
const { requestWithdrawal, withdrawRoiForMonth, payWithdrawal } = require('../services/withdrawalService');

const requestSchema = Joi.object({
  amount: Joi.number().positive().required(),
});

const monthSchema = Joi.object({
  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required(),
});

const request = asyncHandler(async (req, res) => {
  const { amount } = await requestSchema.validateAsync(req.body);
  const data = await requestWithdrawal(req.user.sub, amount);
  res.status(201).json({ ok: true, data });
});

const withdrawRoi = asyncHandler(async (req, res) => {
  const { month } = await monthSchema.validateAsync(req.params);
  const data = await withdrawRoiForMonth(req.user.sub, month);
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

module.exports = { request, withdrawRoi, listMine, pay };
