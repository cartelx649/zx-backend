const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const User = require('../models/User');
const AuthNonce = require('../models/AuthNonce');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { generateReferralId } = require('../utils/referralId');

function desiredRoleForWallet(walletAddress) {
  return walletAddress === env.adminWallet ? 'admin' : 'user';
}

async function syncUserRoleForWallet(user, walletAddress) {
  const nextRole = desiredRoleForWallet(walletAddress);
  if (user.role !== nextRole) {
    user.role = nextRole;
    await user.save();
  }
  return user;
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
      role: desiredRoleForWallet(normalizedWallet),
    });
  } else {
    user = await syncUserRoleForWallet(user, normalizedWallet);
  }
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, walletAddress: user.walletAddress },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
  await AuthNonce.deleteOne({ walletAddress: normalizedWallet });
  return { token, user };
}

async function backendLogin({ walletAddress, sponsorWalletAddress }) {
  const normalizedWallet = walletAddress.toLowerCase();
  let user = await User.findOne({ walletAddress: normalizedWallet });
  if (!user) {
    user = await User.create({
      walletAddress: normalizedWallet,
      sponsorWalletAddress: sponsorWalletAddress?.toLowerCase() || null,
      referralId: generateReferralId(),
      role: desiredRoleForWallet(normalizedWallet),
    });
  } else {
    user = await syncUserRoleForWallet(user, normalizedWallet);
  }
  const token = jwt.sign(
    { sub: String(user._id), role: user.role, walletAddress: user.walletAddress },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
  return { token, user };
}

module.exports = { createNonce, verifySignatureAndLogin, backendLogin };
