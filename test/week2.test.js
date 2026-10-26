'use strict';

// Acceptance test: week-2 file against catalog_before, compared field by field
// with the hand-calculated files in fixtures/week2/expected/.

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, week2, week2Input, stripMessages } = require('./support/helpers.js');

const w = week2();
const plan = core.processBatch(week2Input());

test('week 2: every row gets the hand-calculated outcome', () => {
  assert.deepEqual(plan.row_outcomes, w.expected.rowOutcomes);
});

test('week 2: row accounting holds (19 = 6 + 1 + 5 + 3 + 3 + 1)', () => {
  const s = plan.summary;
  assert.equal(s.rows_read, 19);
  assert.equal(s.accepted + s.collapsed + s.rejected + s.held_conflict + s.held_review + s.blank, s.rows_read);
  assert.deepEqual(
    [s.accepted, s.collapsed, s.rejected, s.held_conflict, s.held_review, s.blank],
    [6, 1, 5, 3, 3, 1],
  );
});

test('week 2: catalog matches catalog_after.json', () => {
  assert.deepEqual(plan.writes.catalog, w.expected.catalog);
});

test('week 2: review tab matches review_after.json', () => {
  assert.deepEqual(plan.writes.review, w.expected.review);
});

test('week 2: new Changes rows match changes_new.json', () => {
  assert.deepEqual(plan.writes.changes, w.expected.changes);
});

test('week 2: new Exceptions rows match exceptions_new.json (messages checked separately)', () => {
  assert.deepEqual(stripMessages(plan.writes.exceptions), w.expected.exceptions);
  for (const e of plan.writes.exceptions) assert.ok(e.message.length > 0, `${e.exception_id} has a message`);
});

test('week 2: run row matches run_row.json', () => {
  assert.equal(plan.status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(plan.run_row, w.expected.runRow);
});

test('week 2: held and rejected SKUs keep their trusted values and are not discontinued', () => {
  const bySku = new Map(plan.writes.catalog.map((row) => [row.sku, row]));
  assert.deepEqual(
    ['SUG-001', 'SPC-020', 'TEA-001', 'EGG-030', 'BTR-002'].map((sku) => [sku, bySku.get(sku).status, bySku.get(sku).unit_price]),
    [['SUG-001', 'ACTIVE', 110], ['SPC-020', 'ACTIVE', 600], ['TEA-001', 'ACTIVE', 210], ['EGG-030', 'ACTIVE', 300], ['BTR-002', 'ACTIVE', 520]],
  );
  assert.equal(bySku.get('TEA-001').unit, 'pack');
  assert.equal(bySku.get('BTR-002').name, 'Butter');
  assert.equal(bySku.get('RCE-005').status, 'DISCONTINUED');
});

test('week 2: rejected SKUs that were never in the catalog are not added', () => {
  const skus = plan.writes.catalog.map((row) => row.sku);
  for (const sku of ['OIL-011', 'MLK-001']) assert.ok(!skus.includes(sku), `${sku} must not be added`);
});
