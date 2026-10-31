'use strict';

// FR-015, R1–R6 end to end: the real workflow JSON and Code-node source, run by
// the n8n interpreter against the fake Google. SIMULATED: no real n8n engine,
// no real Google API. scripts/verify-in-n8n.js and the live M2 tests cover those.

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, week2, stripMessages, WEEK2_BATCH_ID } = require('./support/helpers.js');
const { FakeGoogle } = require('./support/fake-google.js');
const { runWorkflow } = require('./support/n8n-sim.js');
const { buildWorkflow } = require('../workflow/build.js');

const w = week2();
const SPREADSHEET_ID = 'SHEET_ID_1234567890abcdef';
const FOLDER_ID = 'FOLDER_ID_123456';
const NOW = '2026-10-19T07:00:00.000Z';
const LATER = (minutes) => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
const WEEK2_FILE = {
  id: 'drv-week2', name: 'demo-supplier_2026-10-19.csv',
  modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T05:58:00.000Z', content: w.csvText,
};
const baseWorkflow = buildWorkflow();

function configured(manualOptions) {
  const workflow = JSON.parse(JSON.stringify(baseWorkflow));
  const assign = (nodeName, values) => {
    for (const a of workflow.nodes.find((n) => n.name === nodeName).parameters.assignments.assignments) {
      if (a.name in values) a.value = values[a.name];
    }
  };
  assign('Settings', { spreadsheet_id: SPREADSHEET_ID, inbox_folder_id: FOLDER_ID });
  if (manualOptions) assign('Manual run options', manualOptions);
  return workflow;
}

function newGoogle(state) {
  const s = Object.assign({ catalog: w.catalogBefore, review: [], runLog: [], files: [WEEK2_FILE] }, state || {});
  const google = new FakeGoogle({ spreadsheetId: SPREADSHEET_ID, folderId: FOLDER_ID });
  const tab = (title, columns, sheetId, rows) => {
    google.addTab(title, Array.from(columns), { sheetId });
    for (const row of rows) google.tabs.get(title).rows.push(core.rowToValues(columns, row));
  };
  tab('Catalog', core.CATALOG_COLUMNS, 0, s.catalog);
  tab('Review', core.REVIEW_COLUMNS, 101, s.review);
  tab('Changes', core.CHANGES_COLUMNS, 102, []);
  tab('Exceptions', core.EXCEPTIONS_COLUMNS, 103, []);
  tab('Run Log', core.RUNLOG_COLUMNS, 104, s.runLog);
  for (const file of s.files) google.addFile(file);
  // The version tab a previous publication left behind, if any.
  if (s.version) google.addTab('_sheetops_version', [], { sheetId: s.version, rowCount: 1, columnCount: 1 });
  return google;
}

function run(google, opts) {
  const o = Object.assign({ trigger: 'Every 2 hours', now: NOW, id: '1' }, opts || {});
  const result = runWorkflow(o.workflow || configured(o.manual), { google, now: o.now, executionId: o.id, trigger: o.trigger });
  const done = result.outputs.get('Done');
  return Object.assign(result, { done: done ? done[0].json : null });
}

const kinds = (google) => google.log.map((entry) => entry.kind);
const expectedRunRow = (overrides) => Object.assign({}, w.expected.runRow, { run_id: '1', started_at: NOW, finished_at: NOW }, overrides || {});

test('happy path: one scheduled run publishes exactly the hand-calculated week-2 result', () => {
  const google = newGoogle();
  const result = run(google);
  assert.equal(result.error, null);
  assert.deepEqual(kinds(google), ['DRIVE_LIST', 'VALUES_GET', 'VALUES_APPEND', 'DRIVE_GET', 'SHEETS_META', 'VALUES_BATCH_GET', 'VALUES_GET', 'BATCH_UPDATE']);
  assert.equal(google.log[6].node, 'Re-read Review', 'the final Review check comes right before the publish');
  assert.deepEqual([result.done.action, result.done.run_status], ['PROCESS', 'SUCCESS_WITH_EXCEPTIONS']);
  assert.deepEqual(google.table('Catalog'), w.expected.catalog);
  assert.deepEqual(google.table('Review'), w.expected.review);
  assert.deepEqual(google.table('Changes'), w.expected.changes);
  assert.deepEqual(stripMessages(google.table('Exceptions')), w.expected.exceptions);
  assert.deepEqual(google.table('Run Log'), [expectedRunRow()]);
});

test('a second scheduled run finds nothing new and writes nothing', () => {
  const google = newGoogle();
  run(google);
  google.log = [];
  const second = run(google, { now: LATER(120), id: '2' });
  assert.deepEqual([second.done.action, second.done.run_status], ['IDLE', '']);
  assert.deepEqual(kinds(google), ['DRIVE_LIST', 'VALUES_GET']);
  assert.equal(google.table('Run Log').length, 1);
});

test('an approval typed into Review is applied by a manual reprocess', () => {
  const google = newGoogle();
  run(google);
  const review = google.tabs.get('Review');
  const teaRow = review.rows.findIndex((row) => row[0] === `RV|TEA-001|${WEEK2_BATCH_ID}`);
  review.rows[teaRow][core.REVIEW_COLUMNS.indexOf('decision')] = 'APPROVE';
  review.rows[teaRow][core.REVIEW_COLUMNS.indexOf('note')] = 'Supplier confirmed box of 100 bags';

  const result = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(120), id: '2' });
  assert.deepEqual([result.done.action, result.done.run_status, result.done.mode], ['PROCESS', 'SUCCESS_WITH_EXCEPTIONS', 'manual reprocess_latest']);
  assert.equal(google.table('Catalog').find((r) => r.sku === 'TEA-001').unit, 'box');
  const changes = google.table('Changes');
  assert.equal(changes.length, 9);
  assert.deepEqual([changes[8].event_id, changes[8].disposition, changes[8].note],
    [`RV|TEA-001|${WEEK2_BATCH_ID}|UNIT_CHANGED|APPLIED`, 'APPLIED_AFTER_REVIEW', 'Supplier confirmed box of 100 bags']);
  assert.deepEqual(google.table('Review').map((r) => r.sku), ['BTR-002', 'EGG-030']);
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status, r.mode]),
    [['1', 'SUCCESS_WITH_EXCEPTIONS', 'scheduled'], ['2', 'SUCCESS_WITH_EXCEPTIONS', 'manual reprocess_latest']]);
});

test('a refused publish (403) records FAILED, changes nothing, and the next run recovers', () => {
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 403, body: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } });
  const first = run(google);
  assert.deepEqual([first.done.run_status, first.done.code], ['FAILED', 'PUBLISH_REJECTED']);
  assert.ok(first.order.includes('Write FAILED row') && !first.order.includes('Wait 20 seconds'));
  // The row is read, then overwritten, at exactly the range the append reported.
  const [check, write] = google.log.slice(-2);
  assert.deepEqual([check.kind, check.node, write.kind, write.node], ['VALUES_GET', 'Read run row', 'VALUES_UPDATE', 'Write FAILED row']);
  assert.equal(check.url, `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'Run%20Log'!A2%3AZ2?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS`);
  assert.equal(write.url, `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'Run%20Log'!A2%3AZ2?valueInputOption=RAW`);
  assert.equal(write.body.range, "'Run Log'!A2:Z2");
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
  assert.deepEqual([google.table('Changes'), google.table('Exceptions')], [[], []]);
  const failedRow = google.table('Run Log')[0];
  assert.deepEqual([failedRow.status, failedRow.error_code], ['FAILED', 'PUBLISH_REJECTED']);
  assert.match(failedRow.error_message, /^HTTP 403: The caller does not have permission/);

  const second = run(google, { now: LATER(60), id: '2' });
  assert.equal(second.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => r.status), ['FAILED', 'SUCCESS_WITH_EXCEPTIONS']);
  assert.deepEqual(google.table('Changes'), w.expected.changes);
  assert.deepEqual(google.table('Catalog'), w.expected.catalog);
});

test('a lost response after Google applied the publish is confirmed by the marker; FAILED is never written', () => {
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'apply_then_timeout' });
  const result = run(google);
  assert.equal(result.error, null);
  assert.ok(['Wait 20 seconds', 'Read run row', 'Resolve failure'].every((n) => result.order.includes(n)));
  assert.ok(!result.order.includes('Write FAILED row'));
  assert.deepEqual([result.done.run_status, result.done.code], ['SUCCESS_WITH_EXCEPTIONS', '']);
  assert.match(result.done.message, /^The publish response was lost \(timeout of 60000ms exceeded\); row 2 shows SUCCESS_WITH_EXCEPTIONS/);
  assert.ok(!kinds(google).includes('VALUES_UPDATE'));
  assert.deepEqual(google.table('Run Log').map((r) => r.status), ['SUCCESS_WITH_EXCEPTIONS']);
  assert.deepEqual(google.table('Changes'), w.expected.changes, 'published exactly once');
  assert.equal(run(google, { now: LATER(120), id: '2' }).done.action, 'IDLE');
});

test('an unknown outcome that was not applied (503) writes no failure status; scheduled runs block; an explicit reprocess recovers', () => {
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' });
  const first = run(google);
  assert.deepEqual([first.done.run_status, first.done.code], ['STARTED', 'PUBLISH_OUTCOME_UNKNOWN']);
  assert.match(first.done.message, /^HTTP 503: Service Unavailable; after the wait, row 2 shows run 1, STARTED\. Nothing was written/);
  assert.ok(first.order.includes('Resolve failure') && !first.order.includes('Write FAILED row'));
  assert.ok(!kinds(google).includes('VALUES_UPDATE'));
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
  assert.deepEqual(google.table('Run Log').map((r) => r.status), ['STARTED']);

  // An old STARTED row blocks scheduled runs: its age proves nothing about the publish.
  google.log = [];
  const blocked = run(google, { now: LATER(20), id: '2' });
  assert.deepEqual([blocked.done.action, blocked.done.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED']);
  assert.deepEqual(kinds(google), ['DRIVE_LIST', 'VALUES_GET', 'VALUES_APPEND'], 'nothing published');
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
  // After checking the evidence, an operator reprocesses it explicitly.
  const later = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(25), id: '3' });
  assert.equal(later.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'INTERRUPTED'], ['2', 'BLOCKED'], ['3', 'SUCCESS_WITH_EXCEPTIONS']]);
  assert.deepEqual(google.table('Changes'), w.expected.changes);
});

test('a publish that lands after the reconcile read is never contradicted: no FAILED, the marker and the data agree', () => {
  // The race v2.2 lost: Google applies the timed-out request just after this
  // run read its row, which still showed STARTED.
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Read run row' });
  const first = run(google);
  assert.equal(first.error, null);
  assert.deepEqual([first.done.run_status, first.done.code], ['STARTED', 'PUBLISH_OUTCOME_UNKNOWN']);
  assert.equal(google.landed.length, 1, 'the delayed publish landed after the read');
  assert.ok(!kinds(google).includes('VALUES_UPDATE'), 'no failure status was written');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'SUCCESS_WITH_EXCEPTIONS']]);
  assert.deepEqual(google.table('Catalog'), w.expected.catalog);
  assert.deepEqual(google.table('Changes'), w.expected.changes);

  const next = run(google, { now: LATER(20), id: '2' });
  assert.equal(next.done.action, 'IDLE', 'the next run sees the batch committed');
  assert.deepEqual(google.table('Changes'), w.expected.changes, 'published exactly once');
});

test('a lost response on a rejection run is confirmed by its REJECTED_FILE marker', () => {
  const google = newGoogle({ files: [{ id: 'drv-xlsx', name: 'prices.xlsx', mimeType: 'application/vnd.ms-excel', modifiedTime: NOW, createdTime: NOW, content: 'PK' }] });
  google.inject({ kind: 'BATCH_UPDATE', type: 'apply_then_timeout' });
  const result = run(google);
  assert.deepEqual([result.done.run_status, result.done.code], ['REJECTED_FILE', '']);
  assert.ok(!kinds(google).includes('VALUES_UPDATE'));
  assert.deepEqual(google.table('Run Log').map((r) => [r.status, r.error_code]), [['REJECTED_FILE', 'BAD_FILENAME']]);
});

test('if the marker cannot be read, nothing is written; a later run waits, then blocks until an explicit reprocess', () => {
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' });
  google.inject({ kind: 'VALUES_GET', node: 'Read run row', type: 'timeout', times: 3 });
  const first = run(google);
  assert.deepEqual([first.done.run_status, first.done.code], ['STARTED', 'PUBLISH_OUTCOME_UNKNOWN']);
  assert.match(first.done.message, /row 2 could not be read \(.*timeout of 20000ms exceeded\)/);
  assert.equal(kinds(google).filter((k) => k === 'VALUES_GET').length, 1 + 1 + 3, 'Run Log once, the final Review check once, then three tries at the row');
  assert.deepEqual(google.table('Run Log').map((r) => r.status), ['STARTED']);

  google.log = [];
  const soon = run(google, { now: LATER(5), id: '2' });
  assert.deepEqual([soon.done.action, soon.done.code], ['WAIT', 'RUN_IN_PROGRESS']);
  assert.deepEqual(kinds(google), ['DRIVE_LIST', 'VALUES_GET']);

  const blocked = run(google, { now: LATER(20), id: '3' });
  assert.deepEqual([blocked.done.action, blocked.done.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED']);
  const later = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(25), id: '4' });
  assert.equal(later.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'INTERRUPTED'], ['3', 'BLOCKED'], ['4', 'SUCCESS_WITH_EXCEPTIONS']]);
  assert.deepEqual(google.table('Changes'), w.expected.changes);
});

test('a download that keeps failing after STARTED is recorded as FAILED', () => {
  const google = newGoogle();
  google.inject({ kind: 'DRIVE_GET', type: 'timeout', times: 3 });
  const result = run(google);
  assert.deepEqual([result.done.run_status, result.done.code], ['FAILED', 'DOWNLOAD_FAILED']);
  assert.equal(kinds(google).filter((k) => k === 'DRIVE_GET').length, 3, 'three tries');
  assert.deepEqual(google.table('Run Log').map((r) => [r.status, r.error_code]), [['FAILED', 'DOWNLOAD_FAILED']]);
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
});

test('a file that disappears 50% of the catalog halts; the queue blocks until an explicit override', () => {
  const truncated = Object.assign({}, WEEK2_FILE, { content: w.csvText.split('\n').slice(0, 6).join('\n') });
  const google = newGoogle({ files: [truncated] });
  assert.equal(run(google).done.run_status, 'HALTED_REVIEW');
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
  assert.deepEqual(google.table('Exceptions').map((e) => [e.code, e.raw_value]), [['MASS_DISCONTINUE', '5/10']]);

  const blocked = run(google, { now: LATER(120), id: '2' });
  assert.deepEqual([blocked.done.action, blocked.done.code, blocked.done.run_status], ['BLOCKED', 'BATCH_HALTED', 'BLOCKED']);
  assert.deepEqual(kinds(google).slice(-3), ['DRIVE_LIST', 'VALUES_GET', 'VALUES_APPEND']);

  const override = run(google, {
    trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID, confirm_mass_discontinue: true }, now: LATER(240), id: '3',
  });
  assert.equal(override.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => [r.status, r.mode]), [
    ['HALTED_REVIEW', 'scheduled'], ['BLOCKED', 'scheduled'], ['SUCCESS_WITH_EXCEPTIONS', 'manual target_batch_id confirm_mass_discontinue'],
  ]);
  assert.equal(google.table('Changes').filter((c) => c.change_type === 'DISCONTINUED').length, 5);
});

test('a Run Log sorted during the run blocks the publish and every overwrite; an explicit reprocess recovers', () => {
  const week1 = core.describeSourceFile({ id: 'drv-week1', name: 'demo-supplier_2026-10-12.csv', modifiedTime: '2026-10-12T06:00:00.000Z', createdTime: '2026-10-12T05:58:00.000Z' }, w.config);
  const prior = Object.assign(core.buildStartedRow({ run_id: '0', mode: 'scheduled', started_at: '2026-10-12T07:00:00.000Z' }, week1),
    { status: 'SUCCESS', finished_at: '2026-10-12T07:00:00.000Z' });
  const google = newGoogle({ runLog: [prior] });
  // Someone sorts Run Log newest first after the STARTED row was appended.
  google.before('Read working tabs', (g) => {
    const rows = g.tabs.get('Run Log').rows;
    rows.splice(1, 2, rows[2], rows[1]);
  });
  const first = run(google);
  assert.deepEqual([first.done.run_status, first.done.code], ['STARTED', 'RUN_ROW_UNVERIFIED']);
  assert.match(first.done.message, /^RUN_ROW_UNVERIFIED: Run Log row 3 shows run 0, SUCCESS.*FAILED was not written because row 3 shows run 0, SUCCESS$/);
  assert.ok(!kinds(google).includes('BATCH_UPDATE') && !kinds(google).includes('VALUES_UPDATE'));
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'STARTED'], ['0', 'SUCCESS']]);
  assert.deepEqual(google.table('Run Log')[1], core.rowToValues(core.RUNLOG_COLUMNS, prior).reduce((o, v, i) => Object.assign(o, { [core.RUNLOG_COLUMNS[i]]: v }), {}));
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);

  const later = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(20), id: '2' });
  assert.equal(later.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'INTERRUPTED'], ['0', 'SUCCESS'], ['2', 'SUCCESS_WITH_EXCEPTIONS']]);
});

test('a stale row that changes before the publish keeps its new status; INTERRUPTED never replaces a final status', () => {
  const stale = core.buildStartedRow({ run_id: '0', mode: 'scheduled', started_at: LATER(-30) }, w.batch);
  const google = newGoogle({ runLog: [stale] });
  // Between this run's two Run Log reads, a person records the old run as FAILED.
  google.before('Read working tabs', (g) => { g.tabs.get('Run Log').rows[1][core.RUNLOG_COLUMNS.indexOf('status')] = 'FAILED'; });
  const result = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: NOW, id: '1' });
  assert.equal(result.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['0', 'FAILED'], ['1', 'SUCCESS_WITH_EXCEPTIONS']]);

  // Without the change, the same stale row is marked INTERRUPTED.
  const plain = newGoogle({ runLog: [stale] });
  run(plain, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID } });
  assert.deepEqual(plain.table('Run Log').map((r) => [r.run_id, r.status]), [['0', 'INTERRUPTED'], ['1', 'SUCCESS_WITH_EXCEPTIONS']]);
});

test('a Google-native file and a file listed above the size limit are rejected without downloading either', () => {
  const native = { id: 'drv-native', name: 'demo-supplier_2026-10-12.csv', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-12T06:00:00.000Z', createdTime: '2026-10-12T05:00:00.000Z' };
  const big = { id: 'drv-big', name: 'demo-supplier_2026-10-13.csv', size: 2000001, modifiedTime: '2026-10-13T06:00:00.000Z', createdTime: '2026-10-13T05:00:00.000Z', content: 'sku,name,unit,unit_price\n' };
  const google = newGoogle({ files: [WEEK2_FILE, big, native] });
  const first = run(google);
  const second = run(google, { now: LATER(120), id: '2' });
  for (const [result, code] of [[first, 'NOT_A_CSV_FILE'], [second, 'FILE_TOO_LARGE']]) {
    assert.deepEqual([result.done.action, result.done.code, result.done.run_status], ['REJECT_FILE', code, 'REJECTED_FILE']);
    assert.ok(!result.order.includes('Download CSV'), `${code}: the download node never ran`);
  }
  assert.ok(!kinds(google).includes('DRIVE_GET'), 'no file contents were requested');
  assert.deepEqual(google.table('Exceptions').map((e) => [e.code, e.source_file, e.action]),
    [['NOT_A_CSV_FILE', native.name, 'FILE_NOT_PROCESSED'], ['FILE_TOO_LARGE', big.name, 'FILE_NOT_PROCESSED']]);
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);

  google.log = [];
  assert.equal(run(google, { now: LATER(240), id: '3' }).done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.log.filter((e) => e.kind === 'DRIVE_GET').map((e) => e.url),
    ['https://www.googleapis.com/drive/v3/files/drv-week2?alt=media&supportsAllDrives=true']);
});

test('a malformed file name is rejected without being downloaded', () => {
  const google = newGoogle({ files: [{ id: 'drv-xlsx', name: 'prices.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: NOW, createdTime: NOW, content: 'PK' }] });
  const result = run(google);
  assert.deepEqual([result.done.action, result.done.code, result.done.run_status], ['REJECT_FILE', 'BAD_FILENAME', 'REJECTED_FILE']);
  assert.ok(!kinds(google).includes('DRIVE_GET'));
  assert.deepEqual(google.table('Exceptions').map((e) => [e.code, e.raw_value]), [['BAD_FILENAME', 'prices.xlsx']]);
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
});

test('a listing in more than one page, or more than 50 files, blocks the run as QUEUE_TOO_LARGE with recovery steps', () => {
  const paged = newGoogle();
  paged.listingPaged = true;
  const result = run(paged);
  assert.deepEqual([result.done.action, result.done.code, result.done.run_status], ['BLOCKED', 'QUEUE_TOO_LARGE', 'BLOCKED']);
  assert.deepEqual(kinds(paged), ['DRIVE_LIST', 'VALUES_GET', 'VALUES_APPEND'], 'nothing downloaded or published');
  const pagedRow = paged.table('Run Log')[0];
  assert.deepEqual([pagedRow.status, pagedRow.error_code, pagedRow.batch_id], ['BLOCKED', 'QUEUE_TOO_LARGE', '']);
  assert.match(pagedRow.error_message, /more than one page.*Run again; if this repeats, move processed files to another folder$/);

  const files = Array.from({ length: 51 }, (_, i) => Object.assign({}, WEEK2_FILE, { id: `drv-${String(i).padStart(2, '0')}` }));
  const full = newGoogle({ files });
  assert.equal(run(full).done.code, 'QUEUE_TOO_LARGE');
  assert.match(full.table('Run Log')[0].error_message, /^More than 50 files are in the inbox \(51 listed\)\. Move processed files/);
  assert.deepEqual(full.table('Catalog'), w.catalogBefore);
});

test('an unconfigured workflow stops at Prepare run and calls nothing', () => {
  const google = newGoogle();
  const result = run(google, { workflow: baseWorkflow });
  assert.equal(result.error.node, 'Prepare run');
  assert.match(result.error.message, /SETTINGS_INVALID/);
  assert.deepEqual(google.log, []);
});

test('formula-like text from the supplier is stored as plain text', () => {
  const file = Object.assign({}, WEEK2_FILE, { content: 'sku,name,unit,unit_price\nF-1,"=HYPERLINK(""http://example.com"",""x"")",each,10\n' });
  const google = newGoogle({ catalog: [], files: [file] });
  assert.equal(run(google).done.run_status, 'SUCCESS');
  const name = google.table('Catalog')[0].name;
  assert.equal(typeof name, 'string');
  assert.equal(name, '=HYPERLINK("http://example.com","x")');
});

// Contract §8. Rows of the Review tab as stored, keyed by review_id.
const reviewCells = (google) => new Map(google.tabs.get('Review').rows.slice(1).filter((row) => row[0]).map((row) => [row[0], row]));
const DECISION = core.REVIEW_COLUMNS.indexOf('decision');
const NOTE = core.REVIEW_COLUMNS.indexOf('note');
const weekFile = (id, date, content) => ({ id, name: `demo-supplier_${date}.csv`, modifiedTime: `${date}T06:00:00.000Z`, createdTime: `${date}T05:58:00.000Z`, content });

test("an operator's APPROVE and notes survive ordinary reprocessing until the run that applies the approval", () => {
  const google = newGoogle();
  run(google);
  const egg = `RV|EGG-030|${WEEK2_BATCH_ID}`;
  const btr = `RV|BTR-002|${WEEK2_BATCH_ID}`;
  const typed = { [egg]: ['APPROVE', 'Confirmed with supplier on 2026-10-20'], [btr]: ['', 'Waiting for the new label'] };
  for (const [id, [decision, note]] of Object.entries(typed)) {
    const row = reviewCells(google).get(id);
    row[DECISION] = decision;
    row[NOTE] = note;
  }
  const unchanged = (label) => {
    const cells = reviewCells(google);
    for (const [id, [decision, note]] of Object.entries(typed)) {
      assert.deepEqual([cells.get(id)[DECISION] || '', cells.get(id)[NOTE]], [decision, note], `${label}: ${id}`);
    }
  };

  // Week 3: EGG-030's price is unreadable, so the approval cannot apply yet.
  const lines = w.csvText.split('\n');
  lines[17] = 'EGG-030,Eggs (tray of 30),each,4 20.00,ETB';
  google.addFile(weekFile('drv-week3', '2026-10-26', lines.join('\n')));
  const week3 = run(google, { now: '2026-10-26T07:00:00.000Z', id: '2' });
  assert.deepEqual([week3.done.batch_id, week3.done.run_status], ['drv-week3@2026-10-26T06:00:00.000Z', 'SUCCESS_WITH_EXCEPTIONS']);
  unchanged('scheduled run, week 3');
  assert.equal(google.table('Review').find((r) => r.review_id === egg).status, 'APPROVED');
  assert.equal(google.table('Catalog').find((r) => r.sku === 'EGG-030').unit_price, 300);

  // An ordinary manual reprocess of the same batch changes nothing either.
  const again = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: '2026-10-26T09:00:00.000Z', id: '3' });
  assert.equal(again.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  unchanged('manual reprocess, week 3');

  // Week 4 repeats the proposal; the scheduled run applies the approval.
  google.addFile(weekFile('drv-week4', '2026-11-02', w.csvText));
  assert.equal(run(google, { now: '2026-11-02T07:00:00.000Z', id: '4' }).done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.equal(google.table('Catalog').find((r) => r.sku === 'EGG-030').unit_price, 420);
  const applied = google.table('Changes').filter((c) => c.disposition === 'APPLIED_AFTER_REVIEW');
  assert.deepEqual(applied.map((c) => [c.event_id, c.note]), [[`${egg}|PRICE_CHANGED|APPLIED`, typed[egg][1]]]);
  assert.ok(!reviewCells(google).has(egg), 'the applied item leaves Review');
  assert.equal(reviewCells(google).get(btr)[NOTE], typed[btr][1], 'the other note is still there');
});

// §8 (v2.5): the final Review check closes the window between the tab read
// and the final read. It cannot close the window between the final read and
// Google applying the publish: an edit saved there is still lost.
test('a Review edit saved after the final Review check, just before the publish, is still lost, and nothing is applied because of it', () => {
  const google = newGoogle();
  run(google);
  const tea = `RV|TEA-001|${WEEK2_BATCH_ID}`;
  google.before('Publish', (g) => { reviewCells(g).get(tea)[DECISION] = 'APPROVE'; });
  const result = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(120), id: '2' });
  assert.equal(result.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.equal(reviewCells(google).get(tea)[DECISION] || '', '', 'the edit was overwritten by the publish');
  assert.equal(google.table('Catalog').find((r) => r.sku === 'TEA-001').unit, 'pack', 'and not applied');
  assert.ok(google.table('Changes').every((c) => c.disposition !== 'APPLIED_AFTER_REVIEW'));

  // Typed again outside the window, it applies on the next reprocess.
  reviewCells(google).get(tea)[DECISION] = 'APPROVE';
  run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(240), id: '3' });
  assert.equal(google.table('Catalog').find((r) => r.sku === 'TEA-001').unit, 'box');
});

const publishSent = (google) => google.log.some((entry) => entry.kind === 'BATCH_UPDATE');
const runLogRows = (google) => google.table('Run Log').map((r) => [r.run_id, r.status, r.error_code]);

test('the final Review check: an approval saved after the tab read aborts the run; nothing is published and the approval is kept', () => {
  const google = newGoogle();
  run(google);
  const tea = `RV|TEA-001|${WEEK2_BATCH_ID}`;
  google.before('Re-read Review', (g) => { reviewCells(g).get(tea)[DECISION] = 'APPROVE'; });
  google.log = [];
  const aborted = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(120), id: '2' });
  assert.deepEqual([aborted.done.run_status, aborted.done.code], ['FAILED', 'REVIEW_CHANGED']);
  assert.match(aborted.done.message, /RV\|TEA-001\|\S*: decision changed.*Nothing was published/);
  assert.ok(!publishSent(google), 'no publish request was sent');
  assert.deepEqual(google.log.slice(-3).map((e) => [e.kind, e.node]),
    [['VALUES_GET', 'Re-read Review'], ['VALUES_GET', 'Read run row'], ['VALUES_UPDATE', 'Write FAILED row']]);
  assert.deepEqual(runLogRows(google), [['1', 'SUCCESS_WITH_EXCEPTIONS', ''], ['2', 'FAILED', 'REVIEW_CHANGED']]);
  assert.equal(reviewCells(google).get(tea)[DECISION], 'APPROVE', 'the operator\'s approval is kept, not overwritten');
  assert.equal(google.table('Catalog').find((r) => r.sku === 'TEA-001').unit, 'pack', 'and not yet applied');
  // Processed again, the run plans from the approval and applies it.
  const again = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(240), id: '3' });
  assert.equal(again.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.equal(google.table('Catalog').find((r) => r.sku === 'TEA-001').unit, 'box');
  assert.ok(google.table('Changes').some((c) => c.sku === 'TEA-001' && c.disposition === 'APPLIED_AFTER_REVIEW'));
});

test('the final Review check: a note saved after the tab read aborts the run; the note is kept exactly', () => {
  const google = newGoogle();
  run(google);
  const butter = `RV|BTR-002|${WEEK2_BATCH_ID}`;
  google.before('Re-read Review', (g) => { reviewCells(g).get(butter)[NOTE] = 'Asked the supplier: margarine is correct'; });
  google.log = [];
  const aborted = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(120), id: '2' });
  assert.deepEqual([aborted.done.run_status, aborted.done.code], ['FAILED', 'REVIEW_CHANGED']);
  assert.match(aborted.done.message, /RV\|BTR-002\|\S*: note changed/);
  assert.ok(!publishSent(google), 'no publish request was sent');
  assert.equal(reviewCells(google).get(butter)[NOTE], 'Asked the supplier: margarine is correct');
  // Unchanged on the next reprocess, the check passes and the note survives the publish.
  google.log = [];
  const again = run(google, { trigger: 'Run manually', manual: { reprocess_latest: true }, now: LATER(240), id: '3' });
  assert.equal(again.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.ok(publishSent(google));
  assert.equal(reviewCells(google).get(butter)[NOTE], 'Asked the supplier: margarine is correct');
});

test('the final Review check: a failed final read aborts the run; nothing is published and the next run processes the file again', () => {
  const google = newGoogle();
  google.inject({ kind: 'VALUES_GET', node: 'Re-read Review', type: 'status', status: 503, body: 'Service Unavailable', times: 3 });
  const aborted = run(google);
  assert.deepEqual([aborted.done.run_status, aborted.done.code], ['FAILED', 'REVIEW_READ_FAILED']);
  assert.match(aborted.done.message, /final check.*Nothing was published/);
  assert.equal(google.log.filter((e) => e.node === 'Re-read Review').length, 3, 'an idempotent read is tried three times');
  assert.ok(!publishSent(google), 'no publish request was sent');
  assert.deepEqual(google.table('Catalog'), w.catalogBefore, 'the catalog is unchanged');
  assert.deepEqual(runLogRows(google), [['1', 'FAILED', 'REVIEW_READ_FAILED']]);
  // A definitive failure is a failed attempt: the next scheduled run processes the file again.
  const next = run(google, { now: LATER(120), id: '2' });
  assert.equal(next.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assertWeek2Once(google, 'after the retry');
});

test('the final Review check is skipped for a rejected file, whose publish never writes Review', () => {
  const google = newGoogle({ files: [{ id: 'drv-xlsx', name: 'prices.xlsx', mimeType: 'application/vnd.ms-excel', modifiedTime: NOW, createdTime: NOW, content: 'PK' }] });
  const result = run(google);
  assert.equal(result.done.run_status, 'REJECTED_FILE');
  assert.ok(!google.log.some((e) => e.node === 'Re-read Review'));
  assert.ok(publishSent(google));
});

// Contract §12: an uncertain publication that lands late, while a recovery runs.
const PRIOR_VERSION = 1000000500;
const ids = (rows, key) => rows.map((row) => row[key]);
const unique = (values) => new Set(values).size === values.length;
const RUN_LOG_SHEET = 104;
// The data part of a publish: everything except the version check and Run Log writes.
const dataRequests = (body) => body.requests.filter((r) => {
  const kind = Object.keys(r)[0];
  if (kind === 'addSheet' || kind === 'deleteSheet') return false;
  const inner = r[kind];
  return (inner.sheetId !== undefined ? inner.sheetId : inner.range.sheetId) !== RUN_LOG_SHEET;
});
const publishes = (google) => google.log.filter((e) => e.kind === 'BATCH_UPDATE');

function assertWeek2Once(google, label) {
  assert.deepEqual(google.table('Catalog'), w.expected.catalog, `${label}: Catalog`);
  assert.deepEqual(google.table('Review'), w.expected.review, `${label}: Review`);
  assert.deepEqual(google.table('Changes'), w.expected.changes, `${label}: Changes`);
  assert.deepEqual(stripMessages(google.table('Exceptions')), w.expected.exceptions, `${label}: Exceptions`);
  assert.ok(unique(ids(google.table('Changes'), 'event_id')) && unique(ids(google.table('Exceptions'), 'exception_id')), `${label}: duplicate IDs`);
}

test('an original publish that lands after the recovery committed is rejected by the version check', () => {
  const google = newGoogle({ version: PRIOR_VERSION });
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Publish' });
  assert.equal(run(google).done.code, 'PUBLISH_OUTCOME_UNKNOWN');
  const recovery = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(20), id: '2' });
  assert.equal(recovery.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');

  // The original arrived after the recovery and changed nothing.
  assert.equal(google.landed.length, 1);
  assert.equal(google.landed[0].reply.status, 400);
  assertWeek2Once(google, 'after both');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'INTERRUPTED'], ['2', 'SUCCESS_WITH_EXCEPTIONS']]);
  // Both were planned from the same version, for the same batch, with the same data writes.
  const [original, again] = publishes(google);
  assert.deepEqual([original.body.requests[0], again.body.requests[0]], [{ deleteSheet: { sheetId: PRIOR_VERSION } }, { deleteSheet: { sheetId: PRIOR_VERSION } }]);
  assert.deepEqual(dataRequests(again.body), dataRequests(original.body));
  assert.equal(run(google, { now: LATER(140), id: '3' }).done.action, 'IDLE');
});

test('an original publish that lands between the tab read and the final Review read is caught by the check; the recovery sends nothing', () => {
  const google = newGoogle({ version: PRIOR_VERSION });
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Read working tabs' });
  assert.equal(run(google).done.code, 'PUBLISH_OUTCOME_UNKNOWN');
  // The original rewrites Review after run 2 read it, so run 2's final check differs.
  google.log = [];
  const recovery = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(20), id: '2' });
  assert.equal(google.landed[0].reply.status, 200, 'the original applied');
  assert.deepEqual([recovery.done.run_status, recovery.done.code], ['FAILED', 'REVIEW_CHANGED']);
  assert.ok(!publishSent(google), 'the recovery sent no publish');
  assertWeek2Once(google, 'after both');
  assert.deepEqual(runLogRows(google), [['1', 'SUCCESS_WITH_EXCEPTIONS', ''], ['2', 'FAILED', 'REVIEW_CHANGED']]);
  assert.equal(run(google, { now: LATER(140), id: '3' }).done.action, 'IDLE');
});

test('an original publish that lands between the final Review read and the recovery publish wins; the recovery is rejected', () => {
  const google = newGoogle({ version: PRIOR_VERSION });
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Re-read Review' });
  assert.equal(run(google).done.code, 'PUBLISH_OUTCOME_UNKNOWN');
  // Run 2 passes its final Review check, then the original lands, then run 2
  // publishes from a stale read: only the version check can stop it.
  const recovery = run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(20), id: '2' });
  assert.equal(google.landed[0].reply.status, 200, 'the original applied');
  assert.deepEqual([recovery.done.run_status, recovery.done.code], ['FAILED', 'PUBLISH_REJECTED']);
  assertWeek2Once(google, 'after both');
  // Each row tells the truth: run 1 published, run 2's publish was refused.
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status, r.error_code]),
    [['1', 'SUCCESS_WITH_EXCEPTIONS', ''], ['2', 'FAILED', 'PUBLISH_REJECTED']]);
  assert.equal(run(google, { now: LATER(140), id: '3' }).done.action, 'IDLE');
});

test('if Google did not enforce the version check, the fixed-range writes still prevent duplicate rows', () => {
  // A deliberately broken Google: both the recovery and the late original apply.
  const google = newGoogle({ version: PRIOR_VERSION });
  google.enforceSheetChecks = false;
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Publish' });
  run(google);
  run(google, { trigger: 'Run manually', manual: { target_batch_id: WEEK2_BATCH_ID }, now: LATER(20), id: '2' });
  assert.equal(google.landed[0].reply.status, 200, 'the original applied as well');
  assertWeek2Once(google, 'both applied');
  // What this degraded case cannot keep: run 1's late marker overwrote its
  // INTERRUPTED status, so two rows show the batch committed (contract §12).
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'SUCCESS_WITH_EXCEPTIONS'], ['2', 'SUCCESS_WITH_EXCEPTIONS']]);
});

test('a newer-dated or waiting batch is never published while an earlier publication is unresolved', () => {
  // Run 1 publishes the week-3 list; the outcome is unknown and it lands late.
  const week3 = { id: 'drv-week3', name: 'demo-supplier_2026-10-26.csv', modifiedTime: '2026-10-19T06:30:00.000Z', createdTime: '2026-10-19T06:29:00.000Z', content: w.csvText };
  const google = newGoogle({ files: [week3] });
  google.inject({ kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Publish' });
  assert.equal(run(google).done.code, 'PUBLISH_OUTCOME_UNKNOWN');
  // Meanwhile an older, never-processed list arrives. On its own it would be next in the queue.
  google.addFile(WEEK2_FILE);
  google.log = [];
  const blocked = run(google, { now: LATER(20), id: '2' });
  assert.deepEqual([blocked.done.action, blocked.done.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED']);
  assert.ok(!kinds(google).includes('BATCH_UPDATE') && !kinds(google).includes('DRIVE_GET'), 'neither list was published');
  const recovery = run(google, { trigger: 'Run manually', manual: { target_batch_id: 'drv-week3@2026-10-19T06:30:00.000Z' }, now: LATER(25), id: '3' });
  assert.deepEqual([recovery.done.batch_id, recovery.done.run_status], ['drv-week3@2026-10-19T06:30:00.000Z', 'SUCCESS_WITH_EXCEPTIONS']);
  assert.equal(google.landed[0].reply.status, 400, 'the late original was rejected');

  // The oracle: the same list published once, cleanly.
  const clean = newGoogle({ files: [week3] });
  run(clean, { now: LATER(20), id: '2' });
  for (const tab of ['Catalog', 'Review', 'Changes', 'Exceptions']) assert.deepEqual(google.table(tab), clean.table(tab), tab);

  // The older list is now out of order and is rejected, never applied over week 3.
  const third = run(google, { now: LATER(140), id: '4' });
  assert.deepEqual([third.done.action, third.done.code], ['REJECT_FILE', 'OUT_OF_ORDER_FILE']);
  assert.deepEqual(google.table('Catalog'), clean.table('Catalog'));
});

// Brief item 11: duplicate executions. The fake's mid-run hook pauses
// execution A at one of its requests and runs a whole execution B there.
test('a duplicate execution that starts after the first one appended its STARTED row waits and writes nothing', () => {
  const google = newGoogle();
  let second = null;
  google.before('Download CSV', (g) => {
    const before = g.log.length;
    second = run(g, { now: LATER(1), id: '2' });
    second.requests = g.log.slice(before).map((e) => e.kind);
  });
  const first = run(google);
  assert.deepEqual([second.done.action, second.done.code], ['WAIT', 'RUN_IN_PROGRESS']);
  assert.deepEqual(second.requests, ['DRIVE_LIST', 'VALUES_GET'], 'B only read');
  assert.equal(first.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assertWeek2Once(google, 'after both');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['1', 'SUCCESS_WITH_EXCEPTIONS']]);
});

test('two executions that both select the batch before either appends publish it once; no duplicate rows', () => {
  const google = newGoogle({ version: PRIOR_VERSION });
  let second = null;
  // A has read Run Log and chosen week 2; B runs completely before A appends.
  google.before('Append STARTED row', (g) => { second = run(g, { now: NOW, id: '2' }); });
  const first = run(google, { now: NOW, id: '1' });
  assert.equal(second.done.run_status, 'SUCCESS_WITH_EXCEPTIONS', 'B published week 2');
  // A planned from the tabs and version read after B's publish, so it adds nothing new.
  assert.equal(first.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual([first.done.summary.changes_new, first.done.summary.exceptions_new], [0, 0]);
  assertWeek2Once(google, 'after both');
  assert.deepEqual(google.table('Run Log').map((r) => [r.run_id, r.status]), [['2', 'SUCCESS_WITH_EXCEPTIONS'], ['1', 'SUCCESS_WITH_EXCEPTIONS']]);
});
