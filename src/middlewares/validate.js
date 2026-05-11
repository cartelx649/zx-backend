const ApiError = require('../utils/ApiError');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) {
      return next(
        new ApiError(
          400,
          'Validation failed',
          'VALIDATION_ERROR',
          error.details.map((detail) => detail.message)
        )
      );
    }
    req[source] = value;
    return next();
  };
}

module.exports = validate;
