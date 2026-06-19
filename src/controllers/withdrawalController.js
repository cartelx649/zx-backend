const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const Withdrawal = require('../models/Withdrawal');
const { WITHDRAWAL_STATUS } = require('../config/constants');
const {
  requestWithdrawal,
  withdrawRoiForMonth,
  withdrawViaContract,
  payWithdrawal,
  getWithdrawalHistory,
} = require('../services/withdrawalService');

const requestSchema = Joi.object({
  amount: Joi.number().positive().required(),
});

const monthSchema = Joi.object({
  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required(),
});

const contractSchema = Joi.object({
  walletAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  amount: Joi.number().positive().required(),
  type: Joi.string().valid('roi', 'direct', 'override').required(),
  monthKey: Joi.string()
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

const withdrawContract = asyncHandler(async (req, res) => {
  const body = await contractSchema.validateAsync(req.body);
  const data = await withdrawViaContract(req.user.sub, body);
  res.status(201).json({ ok: true, data });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await Withdrawal.find({ userId: req.user.sub }).sort({ createdAt: -1 }).lean();
  res.json({ ok: true, data });
});

const historySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
  status: Joi.string().valid(...Object.values(WITHDRAWAL_STATUS)),
  type: Joi.string().valid('roi', 'direct', 'override'),
});

const history = asyncHandler(async (req, res) => {
  const { limit, offset, status, type } = await historySchema.validateAsync(req.query);
  const data = await getWithdrawalHistory(req.user.sub, { limit, offset, status, type });
  res.json({ ok: true, data });
});

const pay = asyncHandler(async (req, res) => {
  const data = await payWithdrawal(req.params.withdrawalId, req.user.sub);
  res.json({ ok: true, data });
});

module.exports = { request, withdrawRoi, withdrawContract, listMine, history, pay };
