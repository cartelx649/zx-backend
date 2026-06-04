const mongoose = require('mongoose');

const syncBatchSchema = new mongoose.Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    source: { type: String, required: true },
    status: { type: String, enum: ['applied', 'reverted'], default: 'applied', index: true },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },
    insertedIds: {
      users: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      cycles: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      deposits: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      ledger: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    },
    revertedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SyncBatch', syncBatchSchema);
