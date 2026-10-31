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
  if (kind === 'addSheet') return [kind, inner.properties.sheetId];
  return [kind, inner.sheetId !== undefined ? inner.sheetId : inner.range.sheetId];
});
// Hand-calculated: week 2 starts 2026-10-19T07:00Z, 291 days and 7 hours after
// 2026-01-01, i.e. 291 * 86400 + 7 * 3600 = 25,167,600 seconds.
const WEEK2_VERSION = 1000000000 + 25167600;

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

test('week 2 publishes in one request, in contract order: version check first, run row last', () => {
  const plan = core.processBatch(week2Input());
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 3 });
  assert.deepEqual(kinds(body), [
    ['addSheet', WEEK2_VERSION],
    ['appendDimension', 11], ['updateCells', 11],
    ['appendDimension', 12], ['updateCells', 12],
    ['updateCells', 13], ['updateCells', 14],
    ['updateCells', 15],
  ]);
  assert.deepEqual(body.requests[0].addSheet.properties,
    { sheetId: WEEK2_VERSION, title: '_sheetops_version', hidden: true, gridProperties: { rowCount: 1, columnCount: 1 } });
  assert.deepEqual(body.requests[1].appendDimension, { sheetId: 11, dimension: 'ROWS', length: 1 });
  assert.deepEqual(body.requests[2].updateCells.range, { sheetId: 11, startRowIndex: 1, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 12 });
  assert.equal(body.requests[2].updateCells.rows.length, 12);
  assert.equal(body.requests[2].updateCells.fields, 'userEnteredValue');
  assert.deepEqual(body.requests[3].appendDimension, { sheetId: 12, dimension: 'ROWS', length: 3 });
  // Changes and Exceptions start empty, so the new rows go to rows 2-9 and 2-10.
  assert.deepEqual(body.requests[5].updateCells.range, { sheetId: 13, startRowIndex: 1, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: 11 });
  assert.equal(body.requests[5].updateCells.rows.length, 8);
  assert.deepEqual(body.requests[6].updateCells.range, { sheetId: 14, startRowIndex: 1, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 11 });
  assert.equal(body.requests[6].updateCells.rows.length, 9);
  assert.ok(!JSON.stringify(body).includes('appendCells'), 'history rows are never appended');

  const marker = body.requests[7].updateCells;
  assert.deepEqual(marker.range, { sheetId: 15, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 26 });
  const cells = marker.rows[0].values;
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('status')], { userEnteredValue: { stringValue: 'SUCCESS_WITH_EXCEPTIONS' } });
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('rows_read')], { userEnteredValue: { numberValue: 19 } });
  assert.deepEqual(cells[core.RUNLOG_COLUMNS.indexOf('error_code')], {});
});

test('prices are numbers, empty cells are cleared, text is text', () => {
  const plan = core.processBatch(week2Input());
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 3 });
  const flr2 = body.requests[2].updateCells.rows[plan.writes.catalog.findIndex((r) => r.sku === 'FLR-002')].values;
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('unit_price')], { userEnteredValue: { numberValue: 75.5 } });
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('previous_price')], { userEnteredValue: { numberValue: 70 } });
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('pending_review')], {});
  assert.deepEqual(flr2[core.CATALOG_COLUMNS.indexOf('first_seen')], { userEnteredValue: { stringValue: '2026-10-05' } });
});

test('formula-like text is written as stringValue, never as a formula', () => {
  const formula = '=HYPERLINK("http://example.com","x")';
  const plan = core.processBatch({
    config: {}, batch: makeBatch(), run: { run_id: 'r1', started_at: '2026-10-26T07:00:00.000Z' }, sheet: sheetState(),
    csvText: 'sku,name,unit,unit_price\nF-1,"=HYPERLINK(""http://example.com"",""x"")",each,10\n',
  });
  assert.equal(plan.writes.catalog[0].name, formula);
  const body = core.buildPublishRequest({
    plan,
    sheetMeta: Object.assign({}, META, { Catalog: { sheetId: 11, rowCount: 1000, columnCount: 12 } }),
    runRowNumber: 2,
  });
  assert.ok(!JSON.stringify(body).includes('formulaValue'));
  assert.deepEqual(body.requests[1].updateCells.rows[0].values[1], { userEnteredValue: { stringValue: formula } });
});

test('halted and rejected plans touch only Exceptions and the run row', () => {
  const lines = w.csvText.split('\n');
  const halted = core.processBatch(Object.assign(week2Input(), { csvText: lines.slice(0, 6).join('\n') }));
  const only = [['addSheet', WEEK2_VERSION], ['updateCells', 14], ['updateCells', 15]];
  assert.deepEqual(kinds(core.buildPublishRequest({ plan: halted, sheetMeta: META, runRowNumber: 3 })), only);
  const rejected = core.processBatch(Object.assign(week2Input(), { csvText: '' }));
  assert.deepEqual(kinds(core.buildPublishRequest({ plan: rejected, sheetMeta: META, runRowNumber: 3 })), only);
});

test('the version check: delete the version planned from, add a strictly higher one', () => {
  const withVersion = (sheetId) => Object.assign({}, META, { _sheetops_version: { sheetId, rowCount: 1, columnCount: 1 } });
  const plan = core.processBatch(week2Input());
  const first = (sheetMeta) => core.buildPublishRequest({ plan, sheetMeta, runRowNumber: 3 }).requests.slice(0, 2);

  // A later version than the clock gives: +1. An earlier one: the clock value.
  assert.deepEqual(first(withVersion(WEEK2_VERSION + 50)), [
    { deleteSheet: { sheetId: WEEK2_VERSION + 50 } },
    { addSheet: { properties: { sheetId: WEEK2_VERSION + 51, title: '_sheetops_version', hidden: true, gridProperties: { rowCount: 1, columnCount: 1 } } } },
  ]);
  assert.deepEqual(core.publicationVersion(withVersion(1000000007), '2026-10-19T07:00:00.000Z'), { from: 1000000007, to: WEEK2_VERSION });
  assert.deepEqual(core.publicationVersion(META, '2025-12-31T23:59:59.000Z'), { from: null, to: 1000000001 });

  // Two plans made from the same version both delete it, so at most one can apply.
  const recovery = core.processBatch(Object.assign(week2Input(), { run: Object.assign({}, w.run, { run_id: '1002', started_at: '2026-10-19T07:20:00.000Z' }) }));
  const a = core.buildPublishRequest({ plan, sheetMeta: withVersion(WEEK2_VERSION), runRowNumber: 3 });
  const b = core.buildPublishRequest({ plan: recovery, sheetMeta: Object.assign(withVersion(WEEK2_VERSION), { 'Run Log': { sheetId: 15, rowCount: 4, columnCount: 26 } }), runRowNumber: 4 });
  assert.deepEqual(a.requests[0], b.requests[0]);
  assert.deepEqual(a.requests[0], { deleteSheet: { sheetId: WEEK2_VERSION } });

  for (const [label, sheetMeta, code] of [
    ['a tab with that title and an ID SheetOps never uses', withVersion(12345), 'OUTPUT_SCHEMA_MISMATCH'],
    ['the next ID already taken by another tab', Object.assign(withVersion(WEEK2_VERSION + 50), { Notes: { sheetId: WEEK2_VERSION + 51, rowCount: 1, columnCount: 1 } }), 'PLAN_INVALID'],
    ['IDs exhausted', withVersion(2147483646), 'OUTPUT_SCHEMA_MISMATCH'],
  ]) {
    assert.throws(() => core.buildPublishRequest({ plan, sheetMeta, runRowNumber: 3 }), (err) => err.code === code, label);
  }
});

test('history rows go to a fixed range just below the rows read, growing the grid when needed', () => {
  const plan = core.processBatch(Object.assign(week2Input(), {
    sheet: Object.assign(week2Input().sheet, {
      changes: { header: Array.from(core.CHANGES_COLUMNS), ids: ['EV|old-1', undefined, 'EV|old-2'], rows: 3 },
      exceptions: { header: Array.from(core.EXCEPTIONS_COLUMNS), ids: ['EX|old'], rows: 1 },
    }),
  }));
  assert.deepEqual(plan.next_rows, { changes: 5, exceptions: 3 });
  const small = Object.assign({}, META, { Changes: { sheetId: 13, rowCount: 6, columnCount: 11 } });
  const body = core.buildPublishRequest({ plan, sheetMeta: small, runRowNumber: 3 });
  const forChanges = body.requests.filter((r) => (r.appendDimension || (r.updateCells && r.updateCells.range)) && ((r.appendDimension || {}).sheetId === 13 || (r.updateCells && r.updateCells.range.sheetId === 13)));
  // 8 new rows at rows 5-12 need 12 rows; the grid has 6.
  assert.deepEqual(forChanges[0], { appendDimension: { sheetId: 13, dimension: 'ROWS', length: 6 } });
  assert.deepEqual(forChanges[1].updateCells.range, { sheetId: 13, startRowIndex: 4, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 11 });
  // The same plan always builds the same request.
  assert.deepEqual(core.buildPublishRequest({ plan, sheetMeta: small, runRowNumber: 3 }), body);
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
});

test('a FAILED row is written with values.update, which needs only the row number', () => {
  const run = { run_id: '77', mode: 'scheduled', started_at: '2026-10-19T07:00:00.000Z', finished_at: '2026-10-19T07:00:01.000Z' };
  const row = core.buildFailedRunRow(run, w.batch, 'READ_FAILED', 'quota');
  const settings = { spreadsheet_id: 'SHEET_ID_1234567890abcdef', inbox_folder_id: 'FOLDER_ID_123456', supplier: 'demo-supplier', currency: 'ETB' };
  const request = core.buildRunRowUpdateRequest({ settings, runRowNumber: 7, row });
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, "https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID_1234567890abcdef/values/'Run%20Log'!A7%3AZ7?valueInputOption=RAW");
  assert.equal(request.body.range, "'Run Log'!A7:Z7");
  assert.deepEqual(request.body.values, [core.rowToValues(core.RUNLOG_COLUMNS, row)]);
  assert.equal(request.body.values[0][core.RUNLOG_COLUMNS.indexOf('status')], 'FAILED');
  assert.throws(() => core.buildRunRowUpdateRequest({ settings, runRowNumber: 1, row }), (err) => err.code === 'PLAN_INVALID');
});

test('publish errors: 4xx except 408 is a definitive rejection; everything else is unknown', () => {
  const cases = [[400, 'REJECTED'], [403, 'REJECTED'], [404, 'REJECTED'], [429, 'REJECTED'],
    [408, 'UNKNOWN'], [500, 'UNKNOWN'], [503, 'UNKNOWN'], [undefined, 'UNKNOWN']];
  for (const [httpStatus, kind] of cases) assert.equal(core.classifyPublishFailure({ httpStatus }), kind, String(httpStatus));
});

// Contract §12: this run's row is checked by reading exactly that row.
const RUN = { run_id: '1001', mode: 'scheduled', started_at: '2026-10-19T07:00:00.000Z', finished_at: '2026-10-19T07:00:09.000Z' };
const STARTED = core.buildStartedRow(RUN, w.batch);
const rowRead = (patch) => ({
  range: "'Run Log'!A3:Z3", majorDimension: 'ROWS', values: [core.rowToValues(core.RUNLOG_COLUMNS, Object.assign({}, STARTED, patch))],
});
const resolve = (failure, read, expectedStatus) => core.resolveRunFailure({
  failure, rowRead: read, runRowNumber: 3, run: RUN, batch: w.batch, expectedStatus,
});
const NOT_OURS = [
  ['unreadable', { error: { message: 'timeout of 20000ms exceeded' } }, /could not be read \(.*timeout of 20000ms exceeded\)/],
  ['empty', { range: "'Run Log'!A3:Z3", majorDimension: 'ROWS' }, /is empty/],
  ['another run', rowRead({ run_id: '999' }), /shows run 999, STARTED/],
  ['another batch', rowRead({ batch_id: 'drv-other@2026-10-19T06:00:00.000Z' }), /shows run 1001, STARTED/],
];

test('publishFailure: a refused publish is definitive; every other error is unknown', () => {
  assert.deepEqual(core.publishFailure({ outcome: 'REJECTED', httpStatus: 403, message: 'The caller does not have permission' }),
    { kind: 'DEFINITIVE', code: 'PUBLISH_REJECTED', message: 'HTTP 403: The caller does not have permission' });
  assert.deepEqual(core.publishFailure({ outcome: 'UNKNOWN', httpStatus: 503, message: 'Service Unavailable' }),
    { kind: 'UNKNOWN', code: 'PUBLISH_OUTCOME_UNKNOWN', message: 'HTTP 503: Service Unavailable' });
  assert.deepEqual(core.publishFailure({ outcome: 'UNKNOWN', httpStatus: undefined, message: 'timeout of 60000ms exceeded' }),
    { kind: 'UNKNOWN', code: 'PUBLISH_OUTCOME_UNKNOWN', message: 'timeout of 60000ms exceeded' });
});

test("a definitive failure writes FAILED only over this run's own STARTED row", () => {
  const failure = { kind: 'DEFINITIVE', code: 'DOWNLOAD_FAILED', message: 'Downloading demo-supplier_2026-10-19.csv failed: timeout' };
  const written = resolve(failure, rowRead({}));
  assert.deepEqual([written.outcome, written.run_status, written.code, written.message], ['FAILED', 'FAILED', 'DOWNLOAD_FAILED', failure.message]);
  assert.deepEqual(written.write, core.buildFailedRunRow(RUN, w.batch, 'DOWNLOAD_FAILED', failure.message));

  const cases = NOT_OURS.concat([['already final', rowRead({ status: 'SUCCESS' }), /shows run 1001, SUCCESS/]]);
  for (const [label, read, shows] of cases) {
    const r = resolve(failure, read);
    assert.deepEqual([r.outcome, r.write, r.code], ['UNVERIFIED', null, 'RUN_ROW_UNVERIFIED'], label);
    assert.match(r.message, /^DOWNLOAD_FAILED: Downloading .* FAILED was not written because row 3 /, label);
    assert.match(r.message, shows, label);
  }
  assert.equal(resolve(failure, rowRead({ status: 'SUCCESS' })).run_status, 'SUCCESS', 'reports what the row shows');
  assert.equal(resolve(failure, NOT_OURS[0][1]).run_status, 'STARTED', 'this run never finished its row');
});

test('after an unknown publish outcome nothing is ever written; the commit marker decides what is reported', () => {
  const unknown = core.publishFailure({ outcome: 'UNKNOWN', httpStatus: 503, message: 'Service Unavailable' });
  // Confirmed for every final status a plan can build, rejection and halt plans included.
  for (const status of ['SUCCESS', 'SUCCESS_WITH_EXCEPTIONS', 'REJECTED_FILE', 'HALTED_REVIEW']) {
    const r = resolve(unknown, rowRead({ status }), status);
    assert.deepEqual([r.outcome, r.write, r.run_status, r.code], ['CONFIRMED', null, status, ''], status);
    assert.match(r.message, new RegExp(`^The publish response was lost \\(HTTP 503: Service Unavailable\\); row 3 shows ${status}, so Google applied it$`));
  }

  const stillStarted = resolve(unknown, rowRead({}), 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual([stillStarted.outcome, stillStarted.write, stillStarted.run_status, stillStarted.code],
    ['UNKNOWN', null, 'STARTED', 'PUBLISH_OUTCOME_UNKNOWN']);
  assert.match(stillStarted.message, /^HTTP 503: Service Unavailable; after the wait, row 3 shows run 1001, STARTED\. Nothing was written/);

  const others = NOT_OURS.concat([
    ['a different final status than planned', rowRead({ status: 'SUCCESS' }), /shows run 1001, SUCCESS/],
    ['FAILED', rowRead({ status: 'FAILED' }), /shows run 1001, FAILED/],
  ]);
  for (const [label, read, shows] of others) {
    const r = resolve(unknown, read, 'SUCCESS_WITH_EXCEPTIONS');
    assert.deepEqual([r.outcome, r.write, r.code], ['UNKNOWN', null, 'PUBLISH_OUTCOME_UNKNOWN'], label);
    assert.match(r.message, shows, label);
  }
});

test('before publishing, every row overwritten by position is checked against the fresh Run Log read', () => {
  const stale = core.buildStartedRow({ run_id: '1000', mode: 'scheduled', started_at: '2026-10-19T06:00:00.000Z' }, w.batch);
  const staleRuns = [{ row_number: 2, run_id: '1000', batch_id: WEEK2_BATCH_ID }];
  const verify = (rows) => core.verifyRunLogRows({ runLog: runLogValues(rows), runRowNumber: 3, run: RUN, batch: w.batch, staleRuns });
  const refused = (rows, shows) => assert.throws(() => verify(rows),
    (err) => err instanceof core.SheetOpsError && err.code === 'RUN_ROW_UNVERIFIED' && err.detail.startsWith(`Run Log row 3 shows ${shows}`), shows);

  assert.deepEqual(verify([stale, STARTED]), staleRuns);
  refused([STARTED, stale], 'run 1000, STARTED');
  refused([stale], 'no row');
  refused([stale, Object.assign({}, STARTED, { status: 'FAILED' })], 'run 1001, FAILED');
  refused([stale, Object.assign({}, STARTED, { batch_id: 'drv-other@2026-10-19T06:00:00.000Z' })], 'run 1001, STARTED');
  // A stale row that has moved or was already finished is not marked this time.
  const other = core.buildStartedRow({ run_id: '998', mode: 'scheduled', started_at: '2026-10-19T05:00:00.000Z' }, w.batch);
  assert.deepEqual(verify([other, STARTED]), []);
  assert.deepEqual(verify([Object.assign({}, stale, { status: 'INTERRUPTED' }), STARTED]), []);
});

test('UTF-8 byte counting matches the encoding rules', () => {
  assert.equal(core.utf8ByteLength('abc'), 3);
  assert.equal(core.utf8ByteLength('é'), 2);
  assert.equal(core.utf8ByteLength('€'), 3);
  assert.equal(core.utf8ByteLength('ሀ'), 3);
  assert.equal(core.utf8ByteLength('😀'), 4);
});
