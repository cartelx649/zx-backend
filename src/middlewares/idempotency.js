const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const memoryStore = new Map();

function idempotency(ttlMs = 5 * 60 * 1000) {
  return (req, res, next) => {
    const key =
      req.headers['idempotency-key'] ||
      crypto.createHash('sha256').update(`${req.method}:${req.originalUrl}:${JSON.stringify(req.body)}`).digest('hex');
    const now = Date.now();
    const existing = memoryStore.get(key);
    if (existing && now - existing < ttlMs) {
      return next(new ApiError(409, 'Duplicate request detected', 'DUPLICATE_REQUEST'));
    }
    memoryStore.set(key, now);
    return next();
  };
}

module.exports = idempotency;
