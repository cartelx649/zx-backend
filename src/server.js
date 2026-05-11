const env = require('./config/env');
const { createApp } = require('./app');
const { connectDatabase } = require('./config/db');
const { startMonthlyRoiJob } = require('./jobs/monthlyRoiJob');

async function bootstrap() {
  await connectDatabase();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`ZX backend running on port ${env.port}`);
  });
  startMonthlyRoiJob();
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap app:', error);
  process.exit(1);
});
