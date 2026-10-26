'use strict';

// FR-002, FR-010, NFR-003: file-level rejection, the disappearance safety stop,
// and refusal of invalid sheet state.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  core, week2, week2Input, sheetState, makeBatch, stripMessages, tableValues, WEEK2_BATCH_ID,
} = require('./support/helpers.js');

const w = week2();
const lines = w.csvText.split('\n');

function withCsv(csvText, extra) {
  return core.processBatch(Object.assign(week2Input(), { csvText }, extra || {}));
}

function assertNothingButExceptions(plan) {
  assert.equal(plan.writes.catalog, null, 'Catalog not written');
  assert.equal(plan.writes.review, null, 'Review not written');
  assert.deepEqual(plan.writes.changes, [], 'Changes not written');
}

test('5 of 10 active SKUs absent halts with exactly one MASS_DISCONTINUE exception', () => {
  const plan = withCsv(lines.slice(0, 6).join('\n'));
  assert.equal(plan.status, 'HALTED_REVIEW');
  assertNothingButExceptions(plan);
  assert.deepEqual(stripMessages(plan.writes.exceptions), [{
    exception_id: `EX|${WEEK2_BATCH_ID}|0|MASS_DISCONTINUE`,
    batch_id: WEEK2_BATCH_ID,
    source_file: 'demo-supplier_2026-10-19.csv',
    source_row: 0,
    sku_raw: '',
    severity: 'REVIEW',
    code: 'MASS_DISCONTINUE',
    field: '',
    raw_value: '5/10',
    action: 'FILE_NOT_PROCESSED',
  }]);
  assert.match(plan.writes.exceptions[0].message, /5 of 10 active SKUs are absent \(50\.0%.*BTR-002, EGG-030, RCE-005, SPC-020, TEA-001$/);
  assert.deepEqual([plan.run_row.status, plan.run_row.error_code, plan.run_row.rows_read], ['HALTED_REVIEW', 'MASS_DISCONTINUE', 5]);
});

test('3 of 10 absent (exactly 30%) proceeds; 4 of 10 halts', () => {
  const three = lines.slice();
  three[17] = ',,,,';
  three[18] = ',,,,';
  const plan = withCsv(three.join('\n'));
  assert.equal(plan.status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(plan.writes.changes.filter((c) => c.change_type === 'DISCONTINUED').map((c) => c.sku), ['BTR-002', 'EGG-030', 'RCE-005']);

  const four = three.slice();
  four[9] = ',,,,';
  assert.equal(withCsv(four.join('\n')).status, 'HALTED_REVIEW');
});

test('an explicit override processes a halted batch', () => {
  const plan = withCsv(lines.slice(0, 6).join('\n'), { options: { confirm_mass_discontinue: true } });
  assert.equal(plan.status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(plan.writes.changes.filter((c) => c.change_type === 'DISCONTINUED').map((c) => c.sku),
    ['BTR-002', 'EGG-030', 'RCE-005', 'SPC-020', 'TEA-001']);
});

test('an empty catalog never trips the safety stop', () => {
  const plan = core.processBatch({ config: {}, batch: makeBatch(), csvText: 'sku,name,unit,unit_price\nA-1,Rice,kg,10\n', run: {}, sheet: sheetState() });
  assert.equal(plan.status, 'SUCCESS');
});

test('file-level problems reject the file and write only Exceptions and the run row', () => {
  const B = WEEK2_BATCH_ID;
  const cases = [
    ['missing column', 'Item Code,Description,UOM,Currency\nFLR-001,Teff flour,kg,ETB\n', {},
      [[`EX|${B}|0|MISSING_COLUMN|unit_price`, 'MISSING_COLUMN']]],
    ['two missing columns', 'sku,name\nA-1,Rice\n', {},
      [[`EX|${B}|0|MISSING_COLUMN|unit`, 'MISSING_COLUMN'], [`EX|${B}|0|MISSING_COLUMN|unit_price`, 'MISSING_COLUMN']]],
    ['ambiguous column', 'sku,name,unit,price,Unit Price\nA-1,Rice,kg,10,10\n', {},
      [[`EX|${B}|0|AMBIGUOUS_COLUMN|unit_price`, 'AMBIGUOUS_COLUMN']]],
    ['empty file', '', {}, [[`EX|${B}|0|FILE_EMPTY`, 'FILE_EMPTY']]],
    ['header only', 'sku,name,unit,unit_price\n', {}, [[`EX|${B}|0|FILE_EMPTY`, 'FILE_EMPTY']]],
    ['only blank rows', 'sku,name,unit,unit_price\n,,,\n\n', {}, [[`EX|${B}|0|FILE_EMPTY`, 'FILE_EMPTY']]],
    ['too large', w.csvText, { config: Object.assign({}, w.config, { max_file_bytes: 100 }) },
      [[`EX|${B}|0|FILE_TOO_LARGE`, 'FILE_TOO_LARGE']]],
    ['too many rows', w.csvText, { config: Object.assign({}, w.config, { max_data_rows: 10 }) },
      [[`EX|${B}|0|TOO_MANY_ROWS`, 'TOO_MANY_ROWS']]],
  ];
  for (const [label, csvText, extra, expected] of cases) {
    const plan = withCsv(csvText, extra);
    assert.equal(plan.status, 'REJECTED_FILE', label);
    assertNothingButExceptions(plan);
    assert.deepEqual(plan.writes.exceptions.map((e) => [e.exception_id, e.code]), expected, label);
    assert.ok(plan.writes.exceptions.every((e) => e.action === 'FILE_NOT_PROCESSED' && e.source_row === 0), label);
    assert.equal(plan.run_row.error_code, expected[0][1], label);
  }
});

test('a pre-download rejection plan writes one exception and the run row', () => {
  const batch = makeBatch({ id: 'drv-bad', name: 'prices.xlsx' });
  const plan = core.planFileRejection({
    config: {}, batch, run: { run_id: 'r9' }, sheet: sheetState(), code: 'BAD_FILENAME', message: 'bad name',
  });
  assertNothingButExceptions(plan);
  assert.deepEqual(plan.writes.exceptions.map((e) => [e.code, e.raw_value, e.source_row]), [['BAD_FILENAME', 'prices.xlsx', 0]]);
  assert.deepEqual([plan.run_row.status, plan.run_row.error_code, plan.run_row.effective_date], ['REJECTED_FILE', 'BAD_FILENAME', '']);
});

test('invalid sheet state is refused before anything is planned', () => {
  const expectCode = (code, sheet) => assert.throws(
    () => core.processBatch(Object.assign(week2Input(), { sheet })),
    (err) => err instanceof core.SheetOpsError && err.code === code,
    code,
  );
  const dup = w.catalogBefore.concat([w.catalogBefore[0]]);
  expectCode('CATALOG_INVALID', sheetState({ catalog: dup }));
  expectCode('CATALOG_INVALID', sheetState({ catalog: [Object.assign({}, w.catalogBefore[0], { unit_price: '12,5' })] }));
  expectCode('CATALOG_INVALID', sheetState({ catalog: [Object.assign({}, w.catalogBefore[0], { first_seen: 45000 })] }));
  expectCode('REVIEW_INVALID', sheetState({ catalog: w.catalogBefore, review: [Object.assign({}, w.expected.review[0], { review_id: 'RV|XYZ|nope' })] }));

  const extraColumn = sheetState({ catalog: w.catalogBefore });
  extraColumn.catalog[0] = extraColumn.catalog[0].concat(['notes']);
  expectCode('OUTPUT_SCHEMA_MISMATCH', extraColumn);

  const strayValue = sheetState({ catalog: w.catalogBefore });
  strayValue.catalog[1] = strayValue.catalog[1].concat(['typed here']);
  expectCode('OUTPUT_SCHEMA_MISMATCH', strayValue);

  const noChangesHeader = sheetState({ catalog: w.catalogBefore });
  noChangesHeader.changes = { header: ['id'], ids: [] };
  expectCode('OUTPUT_SCHEMA_MISMATCH', noChangesHeader);
});

test('short rows from the Sheets API (trailing empty cells omitted) read the same as full rows', () => {
  const full = week2Input();
  const short = week2Input();
  short.sheet.catalog = short.sheet.catalog.map((row, i) => {
    if (i === 0) return row;
    const copy = row.slice();
    while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
    return copy;
  });
  short.sheet.catalog.splice(3, 0, []);
  assert.deepEqual(core.processBatch(short).writes, core.processBatch(full).writes);
});

test('the Review tab header must match exactly', () => {
  const sheet = sheetState({ catalog: w.catalogBefore });
  sheet.review = tableValues(core.REVIEW_COLUMNS.slice(0, -1), []);
  assert.throws(() => core.processBatch(Object.assign(week2Input(), { sheet })), (err) => err.code === 'OUTPUT_SCHEMA_MISMATCH');
});
