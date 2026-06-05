/**
 * One-off migration: normalize IncomeLedger.monthKey to padded "YYYY-MM".
 *
 * Background: most ledger rows are padded ("2026-05") from incomeService.monthKey(),
 * but an earlier ad-hoc script wrote some non-padded keys ("2026-5"). The synthetic
 * "sync-historical" key is left untouched.
 *
 * Usage:
 *   node scripts/fix-ledger-monthkeys.js --dry   # report only, no writes
 *   node scripts/fix-ledger-monthkeys.js         # apply the fix
 *
 * The actual logic lives in syncService.fixLedgerMonthKeys so the CLI and the
 * POST /api/v1/admin/fix-ledger-monthkeys endpoint stay in sync.
 */
const mongoose = require('mongoose');
const { connectDatabase } = require('../src/config/db');
const { fixLedgerMonthKeys } = require('../src/services/syncService');

async function main() {
  const dry = process.argv.includes('--dry');
  await connectDatabase();
  try {
    const result = await fixLedgerMonthKeys({ dry, sampleLimit: Infinity });
    for (const c of result.changes) {
      if (c.action === 'merge') {
        console.log(`merge  ${c.id} (${c.from} -> ${c.to}, +${c.amount}) into ${c.into}`);
      } else {
        console.log(`update ${c.id} (${c.from} -> ${c.to})`);
      }
    }
    console.log(
      `\n${dry ? '[DRY RUN] ' : ''}Done. scanned=${result.scanned} updated=${result.updated} merged=${result.merged} skipped=${result.skipped}`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('monthKey fix failed:', err.message || err);
  process.exit(1);
});
