const Joi = require('joi');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { createNonce, verifySignatureAndLogin, backendLogin } = require('../services/authService');

const nonceSchema = Joi.object({
  walletAddress: Joi.string().required(),
});

const loginSchema = Joi.object({
  walletAddress: Joi.string().required(),
  signature: Joi.string().required(),
  sponsorWalletAddress: Joi.string().allow(null, ''),
});

const backendLoginSchema = Joi.object({
  password: Joi.string().required(),
  walletAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  sponsorWalletAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
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

const backendLoginHandler = asyncHandler(async (req, res) => {
  const payload = await backendLoginSchema.validateAsync(req.body);
  if (payload.password !== env.backendLoginPassword) {
    throw new ApiError(401, 'Invalid password', 'INVALID_BACKEND_LOGIN_PASSWORD');
  }
  const data = await backendLogin({
    walletAddress: payload.walletAddress,
    sponsorWalletAddress: payload.sponsorWalletAddress,
  });
  res.json({ ok: true, data });
});

module.exports = { getNonce, login, backendLoginHandler };
