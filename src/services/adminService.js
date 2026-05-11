const User = require('../models/User');
const Deposit = require('../models/Deposit');
const Withdrawal = require('../models/Withdrawal');
const Cycle = require('../models/Cycle');
const { getConfig, updateConfig } = require('./configService');

async function getKpis() {
  const [totalUsers, activeUsers, totalDeposits, totalWithdrawals, totalPayouts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Deposit.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Withdrawal.countDocuments(),
    Withdrawal.aggregate([{ $group: { _id: null, total: { $sum: '$approvedAmount' } } }]),
  ]);
  const inactiveUsers = totalUsers - activeUsers;
  const reTopUsers = await Cycle.countDocuments({ isActive: false });

  return {
    totalUsers,
    activeUsers,
    inactiveUsers,
    totalDeposits: totalDeposits[0]?.total || 0,
    totalWithdrawals,
    totalPayouts: totalPayouts[0]?.total || 0,
    reTopUsers,
  };
}

module.exports = { getKpis, getConfig, updateConfig };
