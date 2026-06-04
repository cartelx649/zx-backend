/**
 * Production data-sync runner for the ROI Report.
 *
 * Sync (apply):
 *   node scripts/sync-roi-report.js [path/to/roi_report.json]
 *     - Reads the exported JSON (default <repo>/data/roi_report.json).
 *     - Upserts User/Cycle/Deposit/IncomeLedger and records a revertable SyncBatch.
 *     - Prints the generated batchId + stats. Keep the batchId to revert later.
 *
 * Unsync (revert):
 *   node scripts/sync-roi-report.js --revert <batchId>
 *     - Delete-only revert: removes ONLY the docs that batch inserted.
 *
 * Run `node scripts/export-roi-report-json.js` first to produce the JSON.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { connectDatabase } = require('../src/config/db');
const { syncFromDataJson, unsyncBatch } = require('../src/services/syncService');

const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'roi_report.json');

function makeBatchId() {
  // ISO timestamp is filesystem/url safe enough once ':' and '.' are stripped.
  return `roi-report-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

async function runSync() {
  const filePath = process.argv[2] || DEFAULT_INPUT;
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Input JSON not found: ${filePath}\nRun "node scripts/export-roi-report-json.js" first.`
    );
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const batchId = makeBatchId();
  const source = path.basename(filePath);

  const stats = await syncFromDataJson(data, { batchId, source });
  console.log('Sync complete.');
  console.log('Batch ID (use this to revert):', batchId);
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nTo revert: node scripts/sync-roi-report.js --revert ${batchId}`);
}

async function runRevert(batchId) {
  if (!batchId) {
    throw new Error('Usage: node scripts/sync-roi-report.js --revert <batchId>');
  }
  const result = await unsyncBatch(batchId);
  console.log('Unsync complete.');
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  await connectDatabase();
  try {
    if (process.argv[2] === '--revert') {
      await runRevert(process.argv[3]);
    } else {
      await runSync();
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('ROI report sync failed:', err.message || err);
  process.exit(1);
});
