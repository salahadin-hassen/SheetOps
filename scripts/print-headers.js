'use strict';

// Prints the header row of each SheetOps tab as tab-separated text. Paste a
// line into cell A1 of the matching tab and Google Sheets splits it across the
// columns. With --demo-catalog it also prints the week-2 starting catalog
// (fixtures/week2/catalog_before.json) for pasting into Catalog!A2.
//
// Usage: node scripts/print-headers.js [--demo-catalog]

const core = require('../src/sheetops-core.js');
const catalogBefore = require('../fixtures/week2/catalog_before.json');

const tabs = [
  [core.TABS.catalog, core.CATALOG_COLUMNS],
  [core.TABS.review, core.REVIEW_COLUMNS],
  [core.TABS.changes, core.CHANGES_COLUMNS],
  [core.TABS.exceptions, core.EXCEPTIONS_COLUMNS],
  [core.TABS.runLog, core.RUNLOG_COLUMNS],
];

for (const [tab, columns] of tabs) {
  console.log(`${tab} (A1):`);
  console.log(columns.join('\t'));
  console.log('');
}

if (process.argv.includes('--demo-catalog')) {
  console.log('Catalog (A2), week-2 starting state:');
  for (const row of catalogBefore) console.log(core.rowToValues(core.CATALOG_COLUMNS, row).join('\t'));
}
