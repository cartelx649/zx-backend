const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');
const Cycle = require('../models/Cycle');
const IncomeLedger = require('../models/IncomeLedger');
const Withdrawal = require('../models/Withdrawal');

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  res.json({ ok: true, data: user });
});

const dashboard = asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const [cycle, incomes, withdrawals] = await Promise.all([
    Cycle.findOne({ userId, isActive: true }).lean(),
    IncomeLedger.aggregate([
      { $match: { beneficiaryUserId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
    Withdrawal.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  res.json({ ok: true, data: { cycle, incomes, withdrawals } });
});

module.exports = { me, dashboard };
