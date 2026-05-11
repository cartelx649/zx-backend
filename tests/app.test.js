const request = require('supertest');
const { createApp } = require('../src/app');

describe('App health', () => {
  test('GET /api/v1/health returns ok', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
