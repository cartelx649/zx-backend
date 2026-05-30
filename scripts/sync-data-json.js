const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { connectDatabase } = require('../src/config/db');
const { syncFromDataJson } = require('../src/services/syncService');

async function run() {
  const filePath = process.argv[2] || path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  await connectDatabase();
  const stats = await syncFromDataJson(data);
  console.log('Sync complete:', JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
