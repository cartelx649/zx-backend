const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, unique: true, lowercase: true, index: true },
    sponsorWalletAddress: { type: String, lowercase: true, index: true, default: null },
    referralId: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isActive: { type: Boolean, default: true },
    totalDeposited: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
    directTeamCount: { type: Number, default: 0 },
    currentCycleNumber: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
