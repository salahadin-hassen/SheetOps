'use strict';

// FR-005, FR-007, FR-008, FR-009: review holds, approvals, superseding and
// preservation of the operator's decision and note.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  core, week2, week2Input, afterWeek2State, sheetState, makeBatch, tableValues, WEEK2_BATCH_ID,
} = require('./support/helpers.js');

const w = week2();
const rid = (sku) => `RV|${sku}|${WEEK2_BATCH_ID}`;

function catRow(sku, name, unit, price, extra) {
  return Object.assign({
    sku, name, unit, unit_price: price, currency: 'ETB', status: 'ACTIVE', previous_price: '',
    first_seen: '2026-10-05', last_seen: '2026-10-12', last_changed: '2026-10-05', pending_review: '', last_issue: '',
  }, extra || {});
}

function processSmall(csv, catalog) {
  return core.processBatch({
    config: {}, batch: makeBatch(), csvText: `sku,name,unit,unit_price\n${csv}\n`, run: { run_id: 'r1' }, sheet: sheetState({ catalog }),
  });
}

// Week-2 rows as lines, so a later batch can change single rows. Row n is lines[n - 1].
function week3Csv(edits) {
  const lines = w.csvText.split('\n');
  for (const [row, text] of Object.entries(edits)) lines[Number(row) - 1] = text;
  return lines.join('\n');
}

const WEEK3 = core.describeSourceFile({
  id: 'drv-week3', name: 'demo-supplier_2026-10-26.csv',
  modifiedTime: '2026-10-26T06:00:00.000Z', createdTime: '2026-10-26T05:58:00.000Z',
}, w.config);

function processWeek3(csvText, reviewEdits) {
  return core.processBatch({ config: w.config, batch: WEEK3, csvText, run: w.run, sheet: afterWeek2State(reviewEdits) });
}

test('a price change of exactly 25.00% is held; the catalog keeps the old price', () => {
  const plan = processSmall('P-1,Tray,each,375.00', [catRow('P-1', 'Tray', 'each', 300)]);
  assert.equal(plan.row_outcomes[0].outcome, 'HELD_REVIEW');
  assert.equal(plan.writes.catalog[0].unit_price, 300);
  assert.deepEqual([plan.writes.review[0].reasons, plan.writes.review[0].change_pct], ['LARGE_PRICE_CHANGE', 25]);
  assert.deepEqual(plan.writes.changes.map((c) => [c.change_type, c.disposition, c.old_value, c.new_value, c.change_pct]),
    [['PRICE_CHANGED', 'HELD_FOR_REVIEW', '300.00', '375.00', 25]]);
});

test('a price change of 24.99% is applied automatically (displayed as 25.0)', () => {
  const plan = processSmall('P-1,Tray,each,374.99', [catRow('P-1', 'Tray', 'each', 300)]);
  assert.equal(plan.row_outcomes[0].outcome, 'ACCEPTED');
  assert.deepEqual([plan.writes.catalog[0].unit_price, plan.writes.catalog[0].previous_price], [374.99, 300]);
  assert.deepEqual(plan.writes.review, []);
  assert.deepEqual(plan.writes.changes.map((c) => [c.change_type, c.disposition, c.change_pct]), [['PRICE_CHANGED', 'APPLIED', 25]]);
});

test('a price decrease of 25% is held too', () => {
  const plan = processSmall('P-1,Tray,each,225.00', [catRow('P-1', 'Tray', 'each', 300)]);
  assert.equal(plan.row_outcomes[0].outcome, 'HELD_REVIEW');
  assert.equal(plan.writes.review[0].change_pct, -25);
});

test('a unit change is held, and no percentage is computed when the price also moves', () => {
  const plan = processSmall('T-1,Tea,box,400.00', [catRow('T-1', 'Tea', 'pack', 210)]);
  assert.equal(plan.row_outcomes[0].outcome, 'HELD_REVIEW');
  assert.deepEqual([plan.writes.catalog[0].unit, plan.writes.catalog[0].unit_price], ['pack', 210]);
  assert.deepEqual([plan.writes.review[0].reasons, plan.writes.review[0].change_pct], ['UNIT_CHANGED', '']);
  assert.deepEqual(plan.writes.changes.map((c) => [c.change_type, c.change_pct]), [['PRICE_CHANGED', ''], ['UNIT_CHANGED', '']]);
});

test('a name change holds the whole row, including a small price change', () => {
  const plan = processSmall('B-2,Margarine,kg,530.00', [catRow('B-2', 'Butter', 'kg', 520)]);
  assert.equal(plan.row_outcomes[0].outcome, 'HELD_REVIEW');
  assert.deepEqual([plan.writes.catalog[0].name, plan.writes.catalog[0].unit_price], ['Butter', 520]);
  assert.equal(plan.writes.review[0].reasons, 'NAME_CHANGED');
  assert.deepEqual(plan.writes.changes.map((c) => c.change_type), ['PRICE_CHANGED', 'NAME_CHANGED']);
  assert.ok(plan.writes.changes.every((c) => c.disposition === 'HELD_FOR_REVIEW'));
});

test('a valid row sharing its SKU with a rejected row is held, for known and new SKUs', () => {
  const plan = processSmall('P-1,Rice,kg,105.00\nP-1,Rice,kg,abc\nN-1,Salt,kg,20\nN-1,Salt,,20',
    [catRow('P-1', 'Rice', 'kg', 100)]);
  assert.deepEqual(plan.row_outcomes.map((o) => o.outcome), ['HELD_CONFLICT', 'REJECTED', 'HELD_CONFLICT', 'REJECTED']);
  assert.deepEqual(plan.writes.catalog.map((r) => [r.sku, r.unit_price, r.status, r.last_issue]),
    [['P-1', 100, 'ACTIVE', 'SIBLING_ROW_INVALID (row 2); INVALID_PRICE (row 3)']]);
  assert.deepEqual(plan.writes.exceptions.map((e) => [e.source_row, e.code, e.action]), [
    [2, 'SIBLING_ROW_INVALID', 'KEPT_PREVIOUS'], [3, 'INVALID_PRICE', 'KEPT_PREVIOUS'],
    [4, 'SIBLING_ROW_INVALID', 'NOT_ADDED'], [5, 'MISSING_UNIT', 'NOT_ADDED'],
  ]);
});

test('conflicting rows are held; an identical copy within the group collapses first', () => {
  const plan = processSmall('P-1,Rice,kg,105.00\nP-1, Rice ,KG,105\nP-1,Rice,kg,110.00', [catRow('P-1', 'Rice', 'kg', 100)]);
  assert.deepEqual(plan.row_outcomes.map((o) => o.outcome), ['HELD_CONFLICT', 'COLLAPSED', 'HELD_CONFLICT']);
  assert.equal(plan.writes.catalog[0].unit_price, 100);
  assert.deepEqual(plan.writes.exceptions.map((e) => [e.source_row, e.code, e.severity]),
    [[2, 'CONFLICTING_DUPLICATE', 'REVIEW'], [3, 'DUPLICATE_COLLAPSED', 'INFO'], [4, 'CONFLICTING_DUPLICATE', 'REVIEW']]);
});

test('APPROVE applies a held change on reprocessing and copies the note into Changes', () => {
  const note = 'Supplier confirmed box of 100 bags';
  const plan = core.processBatch(Object.assign(week2Input(), {
    sheet: afterWeek2State({ 'TEA-001': { decision: 'APPROVE', note } }),
  }));
  const tea = plan.writes.catalog.find((r) => r.sku === 'TEA-001');
  assert.deepEqual(tea, Object.assign({}, w.expected.catalog.find((r) => r.sku === 'TEA-001'), {
    unit: 'box', last_changed: '2026-10-19', pending_review: '',
  }));
  assert.deepEqual(plan.writes.catalog.filter((r) => r.sku !== 'TEA-001'), w.expected.catalog.filter((r) => r.sku !== 'TEA-001'));
  assert.deepEqual(plan.writes.changes, [{
    event_id: `${rid('TEA-001')}|UNIT_CHANGED|APPLIED`,
    batch_id: WEEK2_BATCH_ID,
    effective_date: '2026-10-19',
    sku: 'TEA-001',
    change_type: 'UNIT_CHANGED',
    disposition: 'APPLIED_AFTER_REVIEW',
    old_value: 'pack',
    new_value: 'box',
    change_pct: '',
    review_id: rid('TEA-001'),
    note,
  }]);
  assert.deepEqual(plan.writes.review.map((r) => r.sku), ['BTR-002', 'EGG-030']);
  assert.deepEqual(plan.writes.exceptions, []);
  const r = plan.run_row;
  assert.deepEqual([r.accepted, r.held_review, r.changes_applied, r.reviews_opened, r.reviews_pending], [7, 2, 1, 0, 2]);
});

test('normal reprocessing preserves every note exactly', () => {
  const edits = {
    'BTR-002': { note: 'Called supplier, waiting' },
    'EGG-030': { note: 'Price looks high' },
    'TEA-001': { note: 'Box = 100 bags?' },
  };
  const plan = core.processBatch(Object.assign(week2Input(), { sheet: afterWeek2State(edits) }));
  assert.deepEqual(plan.writes.review, w.expected.review.map((item) => Object.assign({}, item, edits[item.sku])));
});

test('an approval survives a run that cannot apply it; an invalid decision is kept verbatim and never applied', () => {
  const plan = processWeek3(week3Csv({ 18: 'EGG-030,Eggs (tray of 30),each,4 20.00,ETB' }), {
    'EGG-030': { decision: 'APPROVE', note: 'ok to apply' },
    'BTR-002': { decision: 'approved ' },
  });
  const egg = plan.writes.review.find((r) => r.sku === 'EGG-030');
  assert.deepEqual(egg, Object.assign({}, w.expected.review.find((r) => r.sku === 'EGG-030'), {
    status: 'APPROVED', decision: 'APPROVE', note: 'ok to apply',
  }));
  const btr = plan.writes.review.find((r) => r.sku === 'BTR-002');
  assert.deepEqual([btr.status, btr.decision, btr.last_seen], ['INVALID_DECISION', 'approved ', '2026-10-26']);
  assert.deepEqual(plan.summary.warnings, [`INVALID_DECISION ${rid('BTR-002')}`]);

  const bySku = new Map(plan.writes.catalog.map((r) => [r.sku, r]));
  assert.deepEqual([bySku.get('EGG-030').unit_price, bySku.get('EGG-030').pending_review, bySku.get('EGG-030').last_issue],
    [300, rid('EGG-030'), 'INVALID_PRICE (row 18)']);
  assert.equal(bySku.get('BTR-002').name, 'Butter');
  assert.ok(plan.writes.changes.every((c) => c.disposition !== 'APPLIED_AFTER_REVIEW'));
});

test('a changed proposal supersedes the open item and opens a new one', () => {
  const plan = processWeek3(week3Csv({ 18: 'EGG-030,Eggs (tray of 30),each,400.00,ETB' }));
  const newId = `RV|EGG-030|${WEEK3.batch_id}`;
  assert.deepEqual(plan.writes.changes.map((c) => [c.event_id, c.change_type, c.disposition, c.old_value, c.new_value, c.change_pct]), [
    [`${rid('EGG-030')}|REVIEW_SUPERSEDED`, 'REVIEW_SUPERSEDED', 'NOT_APPLIED', 'Eggs (tray of 30) | each | 420.00', '', ''],
    [`${newId}|PRICE_CHANGED|HELD`, 'PRICE_CHANGED', 'HELD_FOR_REVIEW', '300.00', '400.00', 33.3],
  ]);
  const egg = plan.writes.review.find((r) => r.sku === 'EGG-030');
  assert.deepEqual([egg.review_id, egg.proposed_price, egg.first_seen, egg.decision], [newId, 400, '2026-10-26', '']);
});

test('an open item whose SKU disappears is superseded, and the SKU is discontinued', () => {
  const plan = processWeek3(week3Csv({ 19: ',,,,' }));
  assert.deepEqual(plan.writes.changes.map((c) => [c.sku, c.change_type, c.disposition]), [
    ['BTR-002', 'REVIEW_SUPERSEDED', 'NOT_APPLIED'],
    ['BTR-002', 'DISCONTINUED', 'APPLIED'],
  ]);
  assert.deepEqual(plan.writes.review.map((r) => r.sku), ['EGG-030', 'TEA-001']);
  const btr = plan.writes.catalog.find((r) => r.sku === 'BTR-002');
  assert.deepEqual([btr.status, btr.name, btr.pending_review], ['DISCONTINUED', 'Butter', '']);
});

test('a hand-edited proposal from the same batch is refused as REVIEW_INVALID', () => {
  assert.throws(
    () => core.processBatch(Object.assign(week2Input(), { sheet: afterWeek2State({ 'EGG-030': { proposed_price: 999 } }) })),
    (err) => err instanceof core.SheetOpsError && err.code === 'REVIEW_INVALID',
  );
});

test('detectReviewEdits finds edited, added and removed rows, and ignores sorting', () => {
  const initial = tableValues(core.REVIEW_COLUMNS, w.expected.review);
  const same = tableValues(core.REVIEW_COLUMNS, w.expected.review.slice().reverse());
  assert.deepEqual(core.detectReviewEdits(initial, same), { edited: false, items: [] });

  const decided = tableValues(core.REVIEW_COLUMNS, w.expected.review.map((r) => (r.sku === 'TEA-001' ? Object.assign({}, r, { decision: 'APPROVE' }) : r)));
  assert.deepEqual(core.detectReviewEdits(initial, decided), { edited: true, items: [{ review_id: rid('TEA-001'), change: 'EDITED' }] });

  const removed = tableValues(core.REVIEW_COLUMNS, w.expected.review.filter((r) => r.sku !== 'BTR-002'));
  assert.deepEqual(core.detectReviewEdits(initial, removed).items, [{ review_id: rid('BTR-002'), change: 'REMOVED' }]);
  assert.deepEqual(core.detectReviewEdits(removed, initial).items, [{ review_id: rid('BTR-002'), change: 'ADDED' }]);
});
