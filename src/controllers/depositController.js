const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAndRecordDeposit } = require('../services/depositService');

const depositSchema = Joi.object({
  txHash: Joi.string().required(),
  amount: Joi.number().positive().required(),
});

const verifyDeposit = asyncHandler(async (req, res) => {
  const payload = await depositSchema.validateAsync(req.body);
  const data = await verifyAndRecordDeposit({ userId: req.user.sub, ...payload });
  res.status(201).json({ ok: true, data });
});

module.exports = { verifyDeposit };
