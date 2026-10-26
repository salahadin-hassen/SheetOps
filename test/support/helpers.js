'use strict';

// Shared fixture loading for the offline tests. Expected values always come
// from the hand-written files in fixtures/, never from the core's own output.

const fs = require('node:fs');
const path = require('node:path');
const core = require('../../src/sheetops-core.js');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function tableValues(columns, rows) {
  return [Array.from(columns)].concat(rows.map((row) => core.rowToValues(columns, row)));
}

function sheetState(state) {
  const s = state || {};
  return {
    catalog: tableValues(core.CATALOG_COLUMNS, s.catalog || []),
    review: tableValues(core.REVIEW_COLUMNS, s.review || []),
    changes: { header: Array.from(core.CHANGES_COLUMNS), ids: s.changeIds || [] },
    exceptions: { header: Array.from(core.EXCEPTIONS_COLUMNS), ids: s.exceptionIds || [] },
  };
}

function runLogValues(rows) {
  return tableValues(core.RUNLOG_COLUMNS, rows.map((row) => {
    const full = {};
    for (const column of core.RUNLOG_COLUMNS) full[column] = '';
    return Object.assign(full, row);
  }));
}

function stripMessages(rows) {
  return rows.map((row) => {
    const copy = Object.assign({}, row);
    delete copy.message;
    return copy;
  });
}

function makeBatch(fileOverrides, config) {
  const file = Object.assign({
    id: 'drv-test',
    name: 'demo-supplier_2026-10-26.csv',
    modifiedTime: '2026-10-26T06:00:00.000Z',
    createdTime: '2026-10-26T05:00:00.000Z',
  }, fileOverrides || {});
  return core.describeSourceFile(file, config);
}

const WEEK2_BATCH_ID = 'drv-week2@2026-10-19T06:00:00.000Z';

function week2() {
  const input = readJson('fixtures/week2/input.json');
  return {
    config: input.config,
    file: input.file,
    run: input.run,
    batch: core.describeSourceFile(input.file, input.config),
    csvText: read('fixtures/week2/demo-supplier_2026-10-19.csv'),
    catalogBefore: readJson('fixtures/week2/catalog_before.json'),
    expected: {
      rowOutcomes: readJson('fixtures/week2/expected/row_outcomes.json'),
      catalog: readJson('fixtures/week2/expected/catalog_after.json'),
      review: readJson('fixtures/week2/expected/review_after.json'),
      changes: readJson('fixtures/week2/expected/changes_new.json'),
      exceptions: readJson('fixtures/week2/expected/exceptions_new.json'),
      runRow: readJson('fixtures/week2/expected/run_row.json'),
    },
  };
}

// The processBatch input for the week-2 run against catalog_before.
function week2Input() {
  const w = week2();
  return {
    config: w.config,
    batch: w.batch,
    csvText: w.csvText,
    run: w.run,
    sheet: sheetState({ catalog: w.catalogBefore }),
  };
}

// Sheet state after a successful week-2 publish, built from the expected files.
// `reviewEdits` maps a SKU to fields the operator changed (decision, note, ...).
function afterWeek2State(reviewEdits) {
  const w = week2();
  const edits = reviewEdits || {};
  return sheetState({
    catalog: w.expected.catalog,
    review: w.expected.review.map((item) => Object.assign({}, item, edits[item.sku] || {})),
    changeIds: w.expected.changes.map((c) => c.event_id),
    exceptionIds: w.expected.exceptions.map((e) => e.exception_id),
  });
}

module.exports = {
  core,
  read,
  readJson,
  tableValues,
  sheetState,
  runLogValues,
  stripMessages,
  makeBatch,
  week2,
  week2Input,
  afterWeek2State,
  WEEK2_BATCH_ID,
};
