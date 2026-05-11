const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const specs = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'ZX Backend API', version: '1.0.0' },
  },
  apis: [],
});

function mountSwagger(app) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
}

module.exports = { mountSwagger };
