const INCOME_TYPES = Object.freeze({
  ROI: 'roi',
  DIRECT: 'direct',
  OVERRIDE: 'override',
});

const WITHDRAWAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid',
});

module.exports = {
  INCOME_TYPES,
  WITHDRAWAL_STATUS,
  ROI_MULTIPLIER: 2,
  CAP_MULTIPLIER: 3,
  DIRECT_COMMISSION_PERCENT: 5,
  MAX_OVERRIDE_LEVELS: 20,
};
