const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { verifyAndRecordDeposit, recordVirtualDeposit } = require('../services/depositService');

const depositSchema = Joi.object({
  txHash: Joi.string().required(),
  amount: Joi.number().positive().required(),
  sponsorWalletAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
});

const virtualDepositSchema = Joi.object({
  password: Joi.string().required(),
  userId: Joi.string()
    .pattern(/^[a-fA-F0-9]{24}$/)
    .required(),
  amount: Joi.number().positive().required(),
  sponsorWalletAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
});

const verifyDeposit = asyncHandler(async (req, res) => {
  const payload = await depositSchema.validateAsync(req.body);
  const data = await verifyAndRecordDeposit({ userId: req.user.sub, ...payload });
  res.status(201).json({ ok: true, data });
});

const createVirtualDeposit = asyncHandler(async (req, res) => {
  const payload = await virtualDepositSchema.validateAsync(req.body);
  if (payload.password !== env.virtualDepositPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_VIRTUAL_PASSWORD');
  }
  const data = await recordVirtualDeposit({
    userId: payload.userId,
    amount: payload.amount,
    sponsorWalletAddress: payload.sponsorWalletAddress,
  });
  res.status(201).json({ ok: true, data });
});

module.exports = { verifyDeposit, createVirtualDeposit };
