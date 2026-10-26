'use strict';

// FR-012, FR-013, NFR-004: the single batchUpdate request, the Run Log commit
// marker, and what may be written after a publish error (contract §11–§12).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  core, week2, week2Input, sheetState, makeBatch, runLogValues, WEEK2_BATCH_ID,
} = require('./support/helpers.js');

const w = week2();
const META = {
  Catalog: { sheetId: 11, rowCount: 12, columnCount: 12 },
  Review: { sheetId: 12, rowCount: 1, columnCount: 16 },
  Changes: { sheetId: 13, rowCount: 1000, columnCount: 11 },
  Exceptions: { sheetId: 14, rowCount: 1000, columnCount: 11 },
  'Run Log': { sheetId: 15, rowCount: 3, columnCount: 26 },
};
const kinds = (body) => body.requests.map((r) => {
  const kind = Object.keys(r)[0];
  const inner = r[kind];
  return [kind, inner.sheetId !== undefined ? inner.sheetId : inner.range.sheetId];
});

test('the output column contract matches docs/data-contract.md §10', () => {
  assert.deepEqual(Array.from(core.CATALOG_COLUMNS), ['sku', 'name', 'unit', 'unit_price', 'currency', 'status', 'previous_price',
    'first_seen', 'last_seen', 'last_changed', 'pending_review', 'last_issue']);
  assert.deepEqual(Array.from(core.REVIEW_COLUMNS), ['review_id', 'sku', 'status', 'reasons', 'current_name', 'current_unit',
    'current_price', 'proposed_name', 'proposed_unit', 'proposed_price', 'change_pct', 'first_seen', 'last_seen', 'source_row',
    'decision', 'note']);
  assert.deepEqual(Array.from(core.CHANGES_COLUMNS), ['event_id', 'batch_id', 'effective_date', 'sku', 'change_type', 'disposition',
    'old_value', 'new_value', 'change_pct', 'review_id', 'note']);
  assert.deepEqual(Array.from(core.EXCEPTIONS_COLUMNS), ['exception_id', 'batch_id', 'source_file', 'source_row', 'sku_raw',
    'severity', 'code', 'field', 'raw_value', 'message', 'action']);
  assert.equal(core.RUNLOG_COLUMNS.length, 26);
});

test('week 2 publishes in one request, in contract order, with the run row last', () => {
  const plan = core.processBatch(week2Input());
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 3 });
  assert.deepEqual(kinds(body), [
    ['appendDimension', 11], ['updateCells', 11],
    ['appendDimension', 12], ['updateCells', 12],
    ['appendCells', 13], ['appendCells', 14],
    ['updateCells', 15],
  ]);
  assert.deepEqual(body.requests[0].appendDimension, { sheetId: 11, dimension: 'ROWS', length: 1 });
  assert.deepEqual(body.requests[1].updateCells.range, { sheetId: 11, startRowIndex: 1, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 12 });
  assert.equal(body.requests[1].updateCells.rows.length, 12);
  assert.equal(body.requests[1].updateCells.fields, 'userEnteredValue');
  assert.deepEqual(body.requests[2].appendDimension, { sheetId: 12, dimension: 'ROWS', length: 3 });
  assert.equal(body.requests[4].appendCells.rows.length, 8);
  assert.equal(body.requests[5].appendCells.rows.length, 9);

  const marker = body.requests[6].updateCells;
  assert.deepEqual(marker.range, { sheetId: 15, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 26 });
  const cells = marker.rows[0].values;
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('status')], { userEnteredValue: { stringValue: 'SUCCESS_WITH_EXCEPTIONS' } });
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('rows_read')], { userEnteredValue: { numberValue: 19 } });
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('error_code')], {});
});

test('prices are numbers, empty cells are cleared, text is text', () => {
  const plan = core.processBatch(week2Input());
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 3 });
  const flr2 = body.requests[1].updateCells.rows[plan.writes.catalog.findIndex((r) => r.sku === 'FLR-002')].values;
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('unit_price')], { userEnteredValue: { numberValue: 75.5 } });
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('previous_price')], { userEnteredValue: { numberValue: 70 } });
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('pending_review')], {});
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('first_seen')], { userEnteredValue: { stringValue: '2026-10-05' } });
});

test('formula-like text is written as stringValue, never as a formula', () => {
  const formula = '=HYPERLINK("http://example.com","x")';
  const plan = core.processBatch({
    config: {}, batch: makeBatch(), run: { run_id: 'r1' }, sheet: sheetState(),
    csvText: 'sku,name,unit,unit_price\nF-1,"=HYPERLINK(""http://example.com"",""x"")",each,10\n',
  });
  assert.equal(plan.writes.catalog[0].name, formula);
  const body = core.buildPublishRequest({
    plan,
    sheetMeta: Object.assign({}, META, { Catalog: { sheetId: 11, rowCount: 1000, columnCount: 12 } }),
    runRowNumber: 2,
  });
  assert.ok(!JSON.stringify(body).includes('formulaValue'));
  assert.deepEqual(body.requests[0].updateCells.rows[0].values[1], { userEnteredValue: { stringValue: formula } });
});

test('halted and rejected plans touch only Exceptions and the run row', () => {
  const lines = w.csvText.split('\n');
  const halted = core.processBatch(Object.assign(week2Input(), { csvText: lines.slice(0, 6).join('\n') }));
  assert.deepEqual(kinds(core.buildPublishRequest({ plan: halted, sheetMeta: META, runRowNumber: 3 })), [['appendCells', 14], ['updateCells', 15]]);
  const rejected = core.processBatch(Object.assign(week2Input(), { csvText: '' }));
  assert.deepEqual(kinds(core.buildPublishRequest({ plan: rejected, sheetMeta: META, runRowNumber: 3 })), [['appendCells', 14], ['updateCells', 15]]);
});

test('stale STARTED rows are marked INTERRUPTED before the commit marker', () => {
  const plan = core.processBatch(Object.assign(week2Input(), { stale_runs: [{ row_number: 2, run_id: '1000', batch_id: WEEK2_BATCH_ID }] }));
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 3 });
  const stale = body.requests[body.requests.length - 2].updateCells;
  const statusColumn = core.RUNLOG_COLUMNS.indexOf('status');
  assert.deepEqual(stale.range, { sheetId: 15, startRowIndex: 1, endRowIndex: 2, startColumnIndex: statusColumn, endColumnIndex: statusColumn + 1 });
  assert.deepEqual(stale.rows, [{ values: [{ userEnteredValue: { stringValue: 'INTERRUPTED' } }] }]);
  assert.equal(body.requests[body.requests.length - 1].updateCells.range.startRowIndex, 2);
});

test('limits and metadata problems are refused before sending', () => {
  const plan = core.processBatch(week2Input());
  const refuse = (code, input) => assert.throws(() => core.buildPublishRequest(Object.assign({ plan, sheetMeta: META, runRowNumber: 3 }, input)),
    (err) => err instanceof core.SheetOpsError && err.code === code, code);
  refuse('PUBLISH_TOO_LARGE', { config: { max_request_bytes: 1000 } });
  refuse('OUTPUT_SCHEMA_MISMATCH', { sheetMeta: Object.assign({}, META, { Catalog: { sheetId: 11, rowCount: 12, columnCount: 11 } }) });
  refuse('OUTPUT_SCHEMA_MISMATCH', { sheetMeta: { Catalog: META.Catalog } });
  refuse('PLAN_INVALID', { runRowNumber: 1 });
  refuse('PLAN_INVALID', { runRowNumber: 4 });
});

test('the STARTED, BLOCKED and FAILED rows carry the batch identity', () => {
  const run = { run_id: '77', mode: 'scheduled', started_at: '2026-10-19T07:00:00.000Z', finished_at: '2026-10-19T07:00:01.000Z', queue_remaining: 2 };
  const started = core.buildStartedRow(run, w.batch);
  assert.deepEqual([started.status, started.finished_at, started.batch_id, started.effective_date, started.queue_remaining],
    ['STARTED', '', WEEK2_BATCH_ID, '2026-10-19', 2]);
  const blocked = core.buildBlockedRow(run, { batch: w.batch, code: 'BATCH_HALTED', message: 'waiting' });
  assert.deepEqual([blocked.status, blocked.error_code, blocked.batch_id], ['BLOCKED', 'BATCH_HALTED', WEEK2_BATCH_ID]);
  const failed = core.buildFailedRunRow(run, w.batch, 'CATALOG_INVALID', 'x'.repeat(600));
  assert.deepEqual([failed.status, failed.error_message.length], ['FAILED', 500]);
  const body = core.buildRunRowUpdateRequest({ row: failed, sheetMeta: META, runRowNumber: 2 });
  assert.deepEqual(kinds(body), [['updateCells', 15]]);
});

test('publish errors: 4xx except 408 is a definitive rejection; everything else is unknown', () => {
  const cases = [[400, 'REJECTED'], [403, 'REJECTED'], [404, 'REJECTED'], [429, 'REJECTED'],
    [408, 'UNKNOWN'], [500, 'UNKNOWN'], [503, 'UNKNOWN'], [undefined, 'UNKNOWN']];
  for (const [httpStatus, kind] of cases) assert.equal(core.classifyPublishFailure({ httpStatus }), kind, String(httpStatus));
});

test('reconciliation never writes FAILED over a confirmed commit, and writes nothing when inconclusive', () => {
  const run = { run_id: '1001', mode: 'scheduled', started_at: '2026-10-19T07:00:00.000Z', finished_at: '2026-10-19T07:00:09.000Z' };
  const base = { run, batch: w.batch, errorMessage: 'socket hang up' };
  const row = (status) => runLogValues([Object.assign(core.buildStartedRow(run, w.batch), { status })]);

  const rejected = core.resolvePublishFailure(Object.assign({ httpStatus: 403 }, base));
  assert.deepEqual([rejected.outcome, rejected.write.status, rejected.write.error_code], ['REJECTED', 'FAILED', 'PUBLISH_REJECTED']);

  const confirmed = core.resolvePublishFailure(Object.assign({ httpStatus: 503, runLog: row('SUCCESS_WITH_EXCEPTIONS') }, base));
  assert.deepEqual([confirmed.outcome, confirmed.write], ['CONFIRMED', null]);

  const notApplied = core.resolvePublishFailure(Object.assign({ runLog: row('STARTED') }, base));
  assert.deepEqual([notApplied.outcome, notApplied.write.status, notApplied.write.error_code], ['NOT_APPLIED', 'FAILED', 'PUBLISH_NOT_APPLIED']);

  const unreadable = core.resolvePublishFailure(Object.assign({ runLog: null }, base));
  assert.deepEqual([unreadable.outcome, unreadable.write], ['INCONCLUSIVE', null]);

  const missing = core.resolvePublishFailure(Object.assign({ httpStatus: 502, runLog: runLogValues([]) }, base));
  assert.deepEqual([missing.outcome, missing.write], ['INCONCLUSIVE', null]);

  const otherBatch = runLogValues([Object.assign(core.buildStartedRow(run, w.batch), {
    status: 'SUCCESS', batch_id: 'drv-x@2026-10-19T06:00:00.000Z',
  })]);
  assert.equal(core.resolvePublishFailure(Object.assign({ httpStatus: 500, runLog: otherBatch }, base)).write, null);
});

test('UTF-8 byte counting matches the encoding rules', () => {
  assert.equal(core.utf8ByteLength('abc'), 3);
  assert.equal(core.utf8ByteLength('é'), 2);
  assert.equal(core.utf8ByteLength('€'), 3);
  assert.equal(core.utf8ByteLength('ሀ'), 3);
  assert.equal(core.utf8ByteLength('😀'), 4);
});
