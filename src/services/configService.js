const AdminConfig = require('../models/AdminConfig');

const DEFAULT_CONFIG = {
  roiSlabs: [
    { name: 'starter', min: 100, max: 499, monthlyPercent: 10 },
    { name: 'growth', min: 500, max: 999, monthlyPercent: 12 },
    { name: 'pro', min: 1000, max: null, monthlyPercent: 15 },
  ],
  overridePercentages: Array.from({ length: 20 }, (_, i) => ({ level: i + 1, percent: 1 })),
  withdrawalWindow: { dayOfMonth: 4, isOpen: true },
  emergencyPause: false,
};

async function getConfig() {
  let config = await AdminConfig.findOne({ key: 'global' });
  if (!config) {
    config = await AdminConfig.create({ key: 'global', value: DEFAULT_CONFIG });
  }
  return config.value;
}

async function updateConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  await AdminConfig.findOneAndUpdate({ key: 'global' }, { value: next }, { upsert: true });
  return next;
}

module.exports = { getConfig, updateConfig };
