'use strict';

// FR-014: rerun and recovery properties R1–R4 and R6 (R5 is in queue.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, week2, week2Input, afterWeek2State, WEEK2_BATCH_ID } = require('./support/helpers.js');

const w = week2();

test('R1: the same inputs give a byte-identical plan', () => {
  assert.equal(JSON.stringify(core.processBatch(week2Input())), JSON.stringify(core.processBatch(week2Input())));
});

test('R1: run information changes only the Run Log row', () => {
  const other = week2Input();
  other.run = Object.assign({}, other.run, {
    run_id: '2002', mode: 'manual', started_at: '2026-10-20T07:00:00.000Z', finished_at: '2026-10-20T07:00:09.000Z',
  });
  const a = core.processBatch(week2Input());
  const b = core.processBatch(other);
  assert.deepEqual(Object.assign({}, a, { run_row: null }), Object.assign({}, b, { run_row: null }));
  assert.notDeepEqual(a.run_row, b.run_row);
});

test('R2/R3: rerunning week 2 against its own published state adds no rows and changes nothing', () => {
  const plan = core.processBatch(Object.assign(week2Input(), { sheet: afterWeek2State() }));
  assert.deepEqual(plan.writes.changes, []);
  assert.deepEqual(plan.writes.exceptions, []);
  assert.deepEqual(plan.writes.catalog, w.expected.catalog);
  assert.deepEqual(plan.writes.review, w.expected.review);
  assert.equal(plan.summary.changes_detected, 0, 'applied changes are not detected again');
  // The source still disagrees with the trusted catalog, so outcomes repeat.
  assert.deepEqual(plan.row_outcomes, w.expected.rowOutcomes);
  assert.equal(plan.status, 'SUCCESS_WITH_EXCEPTIONS');
  const r = plan.run_row;
  assert.deepEqual(
    [r.accepted, r.held_review, r.changes_applied, r.reviews_opened, r.reviews_pending, r.exceptions, r.exceptions_new],
    [6, 3, 0, 0, 3, 9, 0],
  );
});

test('R4: the same proposals in a later batch keep the same review items and add no HELD rows', () => {
  const batch = core.describeSourceFile({
    id: 'drv-week3', name: 'demo-supplier_2026-10-26.csv',
    modifiedTime: '2026-10-26T06:00:00.000Z', createdTime: '2026-10-26T05:58:00.000Z',
  }, w.config);
  const plan = core.processBatch({ config: w.config, batch, csvText: w.csvText, run: w.run, sheet: afterWeek2State() });

  assert.deepEqual(plan.writes.changes, []);
  assert.deepEqual(plan.writes.review, w.expected.review.map((item) => Object.assign({}, item, { last_seen: '2026-10-26' })));
  assert.deepEqual(plan.writes.catalog, w.expected.catalog.map((row) => Object.assign({}, row, {
    last_seen: row.sku === 'RCE-005' ? row.last_seen : '2026-10-26',
  })));
  // A new source version with the same problems is reported again, under new IDs.
  assert.deepEqual(
    plan.writes.exceptions.map((e) => e.exception_id),
    w.expected.exceptions.map((e) => e.exception_id.replace(WEEK2_BATCH_ID, batch.batch_id)),
  );
});

test('R6: a publish that never applied is rebuilt identically; the stale run is carried for marking', () => {
  const first = core.processBatch(week2Input());
  const stale = [{ row_number: 2, run_id: '1001', batch_id: WEEK2_BATCH_ID }];
  const retry = core.processBatch(Object.assign(week2Input(), {
    run: Object.assign({}, w.run, { run_id: '1002', started_at: '2026-10-19T07:30:00.000Z', finished_at: '2026-10-19T07:30:04.000Z' }),
    stale_runs: stale,
  }));
  assert.deepEqual(retry.writes, first.writes);
  assert.deepEqual(retry.stale_runs, stale);
});

test('R6: if IDs from an applied attempt already exist, a retry never repeats them', () => {
  const first = core.processBatch(week2Input());
  const sheet = week2Input().sheet;
  sheet.changes.ids = first.writes.changes.map((c) => c.event_id);
  sheet.exceptions.ids = first.writes.exceptions.map((e) => e.exception_id);
  const retry = core.processBatch(Object.assign(week2Input(), { sheet }));
  assert.deepEqual(retry.writes.changes, []);
  assert.deepEqual(retry.writes.exceptions, []);
});
