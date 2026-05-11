const mongoose = require('mongoose');

const cycleSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    cycleNumber: { type: Number, required: true },
    packageAmount: { type: Number, required: true },
    roiTarget: { type: Number, required: true },
    incomeCap: { type: Number, required: true },
    earnedRoi: { type: Number, default: 0 },
    earnedDirect: { type: Number, default: 0 },
    earnedOverride: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    startedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

cycleSchema.index({ userId: 1, cycleNumber: 1 }, { unique: true });

module.exports = mongoose.model('Cycle', cycleSchema);
