class ApiError extends Error {
  constructor(statusCode, message, code = 'API_ERROR', meta = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.meta = meta;
  }
}

module.exports = ApiError;
