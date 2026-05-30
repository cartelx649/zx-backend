const crypto = require('crypto');

function generateReferralId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

module.exports = { generateReferralId };
