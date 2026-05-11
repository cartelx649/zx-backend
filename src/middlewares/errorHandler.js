function errorHandler(err, req, res) {
  const statusCode = err.statusCode || 500;
  const payload = {
    ok: false,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'Unexpected error',
      meta: err.meta || {},
    },
  };
  if (process.env.NODE_ENV !== 'production') {
    payload.error.stack = err.stack;
  }
  res.status(statusCode).json(payload);
}

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `Route not found: ${req.originalUrl}` },
  });
}

module.exports = { errorHandler, notFoundHandler };
