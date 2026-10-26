'use strict';

// FR-003: RFC 4180 parsing and logical record numbering.

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, read, readJson, sheetState, makeBatch, stripMessages } = require('./support/helpers.js');

test('parses the quoting fixture into the hand-written records', () => {
  assert.deepEqual(core.parseCsv(read('fixtures/parser/quoting.csv')), readJson('fixtures/parser/quoting.expected.json'));
});

test('accepts CRLF, LF and lone CR record endings; no extra record after a final line break', () => {
  const expected = [
    { record: 1, line: 1, fields: ['a', 'b'] },
    { record: 2, line: 2, fields: ['1', '2'] },
  ];
  assert.deepEqual(core.parseCsv('a,b\r\n1,2\r\n'), expected);
  assert.deepEqual(core.parseCsv('a,b\n1,2\n'), expected);
  assert.deepEqual(core.parseCsv('a,b\r1,2'), expected);
  assert.deepEqual(core.parseCsv('a,b\n1,2'), expected);
});

test('removes a UTF-8 byte-order mark', () => {
  assert.deepEqual(core.parseCsv('﻿sku,name\n')[0].fields, ['sku', 'name']);
});

test('an empty line is a record with one empty field; empty input has no records', () => {
  assert.deepEqual(core.parseCsv('a\n\nb\n').map((r) => r.fields), [['a'], [''], ['b']]);
  assert.deepEqual(core.parseCsv(''), []);
});

test('a quoted CRLF counts as one physical line', () => {
  const records = core.parseCsv('a,"x\r\ny"\nb,c\n');
  assert.deepEqual(records[0].fields, ['a', 'x\r\ny']);
  assert.deepEqual([records[1].record, records[1].line], [2, 3]);
});

test('empty quoted fields and quoted quotes', () => {
  assert.deepEqual(core.parseCsv('"",""""\n')[0].fields, ['', '"']);
});

test('malformed quoting raises CsvParseError with the physical line', () => {
  const cases = [
    ['"abc', 'unterminated quoted field', 1],
    ['h\nok\n"bad', 'unterminated quoted field', 3],
    ['a,"b"c\n', 'unexpected character after a closing quote', 1],
    ['a\nx,b"c\n', 'quote inside an unquoted field', 2],
  ];
  for (const [text, reason, line] of cases) {
    assert.throws(() => core.parseCsv(text), (err) => err instanceof core.CsvParseError && err.reason === reason && err.line === line, text);
  }
});

test('the quoting fixture processes with quotes, commas and line breaks intact', () => {
  const batch = makeBatch();
  const plan = core.processBatch({
    config: {},
    batch,
    csvText: read('fixtures/parser/quoting.csv'),
    run: { run_id: 'r1', mode: 'test' },
    sheet: sheetState(),
  });
  assert.deepEqual(plan.row_outcomes.map((o) => [o.row, o.outcome]), [
    [2, 'ACCEPTED'], [3, 'ACCEPTED'], [4, 'ACCEPTED'], [5, 'ACCEPTED'], [6, 'REJECTED'],
  ]);
  assert.deepEqual(plan.writes.catalog.map((r) => [r.sku, r.name, r.unit, r.unit_price, r.currency]), [
    ['JAM-001', 'Strawberry jam (glass jar)', 'each', 1250.5, 'ETB'],
    ['OIL-010', 'Sunflower oil, refined 5L', 'each', 1520, 'ETB'],
    ['SPC-021', 'Pepper, black, "fine"', 'kg', 12500, 'ETB'],
    ['TEA-002', 'Tea "Gold" 100 bags', 'pack', 95, 'ETB'],
  ]);
  assert.deepEqual(stripMessages(plan.writes.exceptions), [{
    exception_id: `EX|${batch.batch_id}|6|FIELD_COUNT_MISMATCH`,
    batch_id: batch.batch_id,
    source_file: 'demo-supplier_2026-10-26.csv',
    source_row: 6,
    sku_raw: 'OIL-012',
    severity: 'ERROR',
    code: 'FIELD_COUNT_MISMATCH',
    field: '',
    raw_value: '5',
    action: 'NOT_ADDED',
  }]);
});

test('a CSV parse error rejects the whole file and leaves Catalog and Review unwritten', () => {
  const batch = makeBatch();
  const plan = core.processBatch({
    config: {},
    batch,
    csvText: 'sku,name,unit,unit_price\nA-1,"Oil,each,10\n',
    run: { run_id: 'r1' },
    sheet: sheetState(),
  });
  assert.equal(plan.status, 'REJECTED_FILE');
  assert.equal(plan.writes.catalog, null);
  assert.equal(plan.writes.review, null);
  assert.deepEqual(plan.writes.exceptions.map((e) => [e.code, e.raw_value, e.source_row]), [['CSV_PARSE_ERROR', 'line 2', 0]]);
});
