/**
 * Export the ROI Report CSV into a JSON payload consumable by the data sync.
 *
 * Usage:
 *   node scripts/export-roi-report-json.js [path/to/report.csv] [path/to/out.json]
 *
 * Defaults:
 *   input : <repo>/roi_report(ROI Report).csv
 *   output: <repo>/data/roi_report.json
 *
 * The output shape is { generatedAt, source, rows: [...] } where every row keeps
 * the EXACT CSV column keys (e.g. "Address", "Deposited (USD)", "levels"), so it
 * drops straight into syncFromDataJson() which reads row.Address, row['Deposited (USD)'], etc.
 *
 * NOTE: per project decision, only Address / Referrer / Deposited (USD) /
 * ROI Accrued est. (USD) / Referral Rewards Claimed (USD) are persisted by the sync.
 * Tier / levels / Monthly ROI % / # Investments / ROI Claimed / ROI Remaining /
 * First Invest / Last Invest are exported here for fidelity but NOT written to the DB.
 */
const path = require('path');
const fs = require('fs');

const DEFAULT_INPUT = path.join(__dirname, '..', 'roi_report(ROI Report).csv');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'roi_report.json');

/**
 * Minimal CSV parser. The ROI report has simple cells (no embedded commas,
 * quotes, or newlines), so a split-based parser is sufficient and dependency-free.
 */
function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split(',');
    const row = {};
    headers.forEach((header, idx) => {
      const value = cells[idx] !== undefined ? cells[idx].trim() : '';
      row[header] = value;
    });
    rows.push(row);
  }

  return rows;
}

function run() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input CSV not found: ${inputPath}`);
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCsv(text);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: path.basename(inputPath),
    rows,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  console.log(`Exported ${rows.length} rows from "${inputPath}"`);
  console.log(`Wrote JSON to "${outputPath}"`);
  console.log(
    'Note: only Address/Referrer/Deposited/ROI Accrued/Referral Rewards are persisted by the sync; ' +
      'other columns (Tier, levels, dates, etc.) are exported for fidelity only.'
  );
}

try {
  run();
} catch (err) {
  console.error('Export failed:', err.message);
  process.exit(1);
}
