const mongoose = require('mongoose');
const { INCOME_TYPES } = require('../config/constants');

const incomeLedgerSchema = new mongoose.Schema(
  {
    beneficiaryUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true, index: true },
    type: { type: String, enum: Object.values(INCOME_TYPES), required: true, index: true },
    level: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    monthKey: { type: String, required: true, index: true },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

incomeLedgerSchema.index(
  { beneficiaryUserId: 1, sourceUserId: 1, type: 1, monthKey: 1, level: 1, cycleId: 1 },
  { unique: true }
);

module.exports = mongoose.model('IncomeLedger', incomeLedgerSchema);
