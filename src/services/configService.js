const AdminConfig = require('../models/AdminConfig');

const DEFAULT_CONFIG = {
  roiSlabs: [
    { name: 's1', min: 1, max: 500, monthlyPercent: 5 },
    { name: 's2', min: 501, max: 2000, monthlyPercent: 6 },
    { name: 's3', min: 2001, max: 5000, monthlyPercent: 7 },
    { name: 's4', min: 5001, max: null, monthlyPercent: 8 },
  ],
  overridePercentages: [
    { level: 1, percent: 10 },
    { level: 2, percent: 5 },
    { level: 3, percent: 3 },
    { level: 4, percent: 2 },
    { level: 5, percent: 0.5 },
    { level: 6, percent: 0.5 },
    { level: 7, percent: 0.5 },
    { level: 8, percent: 0.5 },
    { level: 9, percent: 0.5 },
    { level: 10, percent: 0.5 },
    { level: 11, percent: 0.25 },
    { level: 12, percent: 0.25 },
    { level: 13, percent: 0.25 },
    { level: 14, percent: 0.25 },
    { level: 15, percent: 0.25 },
    { level: 16, percent: 0.25 },
    { level: 17, percent: 0.25 },
    { level: 18, percent: 0.25 },
    { level: 19, percent: 0.25 },
    { level: 20, percent: 0.25 },
  ],
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
