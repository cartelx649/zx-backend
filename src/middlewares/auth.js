const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

function auth(requiredRole) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return next(new ApiError(401, 'Authentication required', 'UNAUTHORIZED'));
    }
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      if (requiredRole && decoded.role !== requiredRole) {
        throw new ApiError(403, 'Insufficient permissions', 'FORBIDDEN');
      }
      req.user = decoded;
      return next();
    } catch (error) {
      return next(error.statusCode ? error : new ApiError(401, 'Invalid token', 'INVALID_TOKEN'));
    }
  };
}

module.exports = auth;
