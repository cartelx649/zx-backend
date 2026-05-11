const mongoose = require('mongoose');

const depositSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true, index: true },
    txHash: { type: String, required: true, unique: true, lowercase: true },
    amount: { type: Number, required: true },
    packageType: { type: String, required: true },
    roiSlabName: { type: String, required: true },
    receiverAddress: { type: String, required: true, lowercase: true },
    treasuryWallet: { type: String, required: false, lowercase: true, default: null },
    chainConfirmations: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'verified', 'failed'], default: 'pending', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Deposit', depositSchema);
