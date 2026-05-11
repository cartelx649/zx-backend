const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const User = require('../models/User');
const AuthNonce = require('../models/AuthNonce');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

function generateReferralId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function createNonce(walletAddress) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await AuthNonce.findOneAndUpdate(
    { walletAddress: walletAddress.toLowerCase() },
    { nonce, expiresAt },
    { upsert: true }
  );
  return { nonce, expiresAt };
}

async function verifySignatureAndLogin({ walletAddress, signature, sponsorWalletAddress }) {
  const normalizedWallet = walletAddress.toLowerCase();
  const nonceRecord = await AuthNonce.findOne({ walletAddress: normalizedWallet });
  if (!nonceRecord || nonceRecord.expiresAt < new Date()) {
    throw new ApiError(400, 'Nonce expired. Request a new nonce.', 'NONCE_EXPIRED');
  }
  const message = `ZX Login Nonce: ${nonceRecord.nonce}`;
  const signer = ethers.verifyMessage(message, signature).toLowerCase();
  if (signer !== normalizedWallet) {
    throw new ApiError(401, 'Invalid signature', 'INVALID_SIGNATURE');
  }
  let user = await User.findOne({ walletAddress: normalizedWallet });
  if (!user) {
    user = await User.create({
      walletAddress: normalizedWallet,
      sponsorWalletAddress: sponsorWalletAddress?.toLowerCase() || null,
      referralId: generateReferralId(),
      role: normalizedWallet === env.adminWallet ? 'admin' : 'user',
    });
  }
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, walletAddress: user.walletAddress },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
  await AuthNonce.deleteOne({ walletAddress: normalizedWallet });
  return { token, user };
}

module.exports = { createNonce, verifySignatureAndLogin };
