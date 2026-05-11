const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const { createNonce, verifySignatureAndLogin } = require('../services/authService');

const nonceSchema = Joi.object({
  walletAddress: Joi.string().required(),
});

const loginSchema = Joi.object({
  walletAddress: Joi.string().required(),
  signature: Joi.string().required(),
  sponsorWalletAddress: Joi.string().allow(null, ''),
});

const getNonce = asyncHandler(async (req, res) => {
  const { walletAddress } = await nonceSchema.validateAsync(req.body);
  const data = await createNonce(walletAddress);
  res.json({ ok: true, data });
});

const login = asyncHandler(async (req, res) => {
  const payload = await loginSchema.validateAsync(req.body);
  const data = await verifySignatureAndLogin(payload);
  res.json({ ok: true, data });
});

module.exports = { getNonce, login };
