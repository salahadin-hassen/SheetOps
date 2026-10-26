'use strict';

// FR-002 and FR-004: header aliases and field rules (contract §4, §5).

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, sheetState, makeBatch } = require('./support/helpers.js');

test('price parsing: accepted, ambiguous and invalid forms', () => {
  const cases = [
    ['1520', { cents: 152000 }],
    ['1520.5', { cents: 152050 }],
    ['1520.00', { cents: 152000 }],
    ['1,520.00', { cents: 152000 }],
    ['12,500', { cents: 1250000 }],
    [' 95.00 ', { cents: 9500 }],
    ['0.01', { cents: 1 }],
    ['10000000.00', { cents: 1000000000 }],
    ['12,5', { code: 'AMBIGUOUS_PRICE' }],
    ['12,50', { code: 'AMBIGUOUS_PRICE' }],
    ['1,52', { code: 'AMBIGUOUS_PRICE' }],
    ['1.520,00', { code: 'AMBIGUOUS_PRICE' }],
    ['', { code: 'MISSING_PRICE' }],
    ['   ', { code: 'MISSING_PRICE' }],
    ['-300.00', { code: 'INVALID_PRICE' }],
    ['0', { code: 'INVALID_PRICE' }],
    ['0.00', { code: 'INVALID_PRICE' }],
    ['10000000.01', { code: 'INVALID_PRICE' }],
    ['12.345', { code: 'INVALID_PRICE' }],
    ['ETB 12.00', { code: 'INVALID_PRICE' }],
    ['$12', { code: 'INVALID_PRICE' }],
    ['1,23,456', { code: 'INVALID_PRICE' }],
    ['.50', { code: 'INVALID_PRICE' }],
    ['4 20.00', { code: 'INVALID_PRICE' }],
  ];
  for (const [raw, expected] of cases) assert.deepEqual(core.parsePrice(raw), expected, `parsePrice(${JSON.stringify(raw)})`);
});

test('change percentages use integer rounding, half away from zero', () => {
  assert.equal(core.changePct(7000, 7550), 7.9);
  assert.equal(core.changePct(145000, 152000), 4.8);
  assert.equal(core.changePct(30000, 42000), 40);
  assert.equal(core.changePct(30000, 37499), 25);
  assert.equal(core.changePct(14000, 13500), -3.6);
  assert.equal(core.changePct(100000, 100001), 0);
});

test('field clean-ups and rejection codes', () => {
  const ok = (fields) => core.validateFields(Object.assign({ sku: 'A-1', name: 'Item', unit: 'kg', unit_price: '10' }, fields), {});
  assert.deepEqual(ok({ sku: '  ab-1 ' }).sku, 'AB-1');
  assert.equal(ok({ name: '  Tea \t bags\n(red) ' }).value.name, 'Tea bags (red)');
  for (const [raw, unit] of [['PCS', 'each'], ['pc', 'each'], ['Piece', 'each'], ['ea', 'each'], ['KGS', 'kg'], ['Ltr', 'l'], ['litre', 'l'], ['liter', 'l'], [' Box ', 'box']]) {
    assert.equal(ok({ unit: raw }).value.unit, unit, raw);
  }
  assert.equal(ok({}).value.currency, 'ETB', 'no currency column means ETB');
  assert.equal(ok({ currency: ' etb ' }).value.currency, 'ETB');

  const codes = (fields) => ok(fields).errors.map((e) => e.code);
  assert.deepEqual(codes({ sku: '' }), ['MISSING_SKU']);
  assert.deepEqual(codes({ sku: 'SLT-9!!' }), ['INVALID_SKU']);
  assert.deepEqual(codes({ sku: 'A' }), ['INVALID_SKU']);
  assert.deepEqual(codes({ sku: '-AB' }), ['INVALID_SKU']);
  assert.deepEqual(codes({ name: '  ' }), ['MISSING_NAME']);
  assert.deepEqual(codes({ name: 'x'.repeat(201) }), ['NAME_TOO_LONG']);
  assert.deepEqual(codes({ name: 'x'.repeat(200) }), []);
  assert.deepEqual(codes({ unit: '' }), ['MISSING_UNIT']);
  assert.deepEqual(codes({ unit: 'dozen' }), ['UNKNOWN_UNIT']);
  assert.deepEqual(codes({ currency: 'USD' }), ['CURRENCY_MISMATCH']);
  assert.deepEqual(codes({ currency: '' }), ['CURRENCY_MISMATCH']);
  assert.deepEqual(codes({ sku: '', name: '', unit: '', unit_price: '', currency: 'USD' }),
    ['MISSING_SKU', 'MISSING_NAME', 'MISSING_UNIT', 'MISSING_PRICE', 'CURRENCY_MISMATCH']);
});

test('header aliases are matched case- and space-insensitively; unknown headers are ignored and listed', () => {
  const plan = core.processBatch({
    config: {},
    batch: makeBatch(),
    csvText: ' SKU ,Item   Name,Unit of Measure,UNIT PRICE,Cur,Notes\nA-1,Rice,kg,10.00,ETB,ignore me\n',
    run: { run_id: 'r1' },
    sheet: sheetState(),
  });
  assert.equal(plan.status, 'SUCCESS');
  assert.deepEqual(plan.summary.ignored_columns, ['Notes']);
  assert.deepEqual(plan.writes.catalog.map((r) => [r.sku, r.name, r.unit, r.unit_price]), [['A-1', 'Rice', 'kg', 10]]);
});

test('a row with several problems gets one exception per problem but one outcome', () => {
  const batch = makeBatch();
  const plan = core.processBatch({
    config: {},
    batch,
    csvText: 'sku,name,unit,price\nA-1,,dozen,12,5\n',
    run: { run_id: 'r1' },
    sheet: sheetState(),
  });
  // "12,5" is unquoted here, so the row has 5 fields: the field count wins.
  assert.deepEqual(plan.row_outcomes.map((o) => o.outcome), ['REJECTED']);
  assert.deepEqual(plan.writes.exceptions.map((e) => e.code), ['FIELD_COUNT_MISMATCH']);

  const plan2 = core.processBatch({
    config: {},
    batch,
    csvText: 'sku,name,unit,price\nA-1,,dozen,"12,5"\n',
    run: { run_id: 'r1' },
    sheet: sheetState(),
  });
  assert.deepEqual(plan2.row_outcomes.map((o) => o.outcome), ['REJECTED']);
  assert.deepEqual(plan2.writes.exceptions.map((e) => e.code), ['MISSING_NAME', 'UNKNOWN_UNIT', 'AMBIGUOUS_PRICE']);
});
