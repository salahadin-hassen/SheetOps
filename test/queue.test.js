'use strict';

// FR-001 and R5/R6: source queue ordering and the processed-file rule (contract §2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { core, runLogValues } = require('./support/helpers.js');

const CFG = { supplier: 'demo-supplier' };
const NOW = '2026-10-27T08:00:00.000Z';

const file = (id, name, modifiedTime, createdTime) => ({ id, name, modifiedTime, createdTime: createdTime || modifiedTime });
const version = (f) => core.describeSourceFile(f, CFG);

function runRow(runId, f, status, extra) {
  const v = version(f);
  return Object.assign({
    run_id: runId, mode: 'scheduled', status, started_at: '2026-10-27T07:00:00.000Z', finished_at: '2026-10-27T07:00:05.000Z',
    batch_id: v.batch_id, source_file_id: v.file_id, source_name: v.name, effective_date: v.effective_date,
    source_modified_at: v.modified_at, source_created_at: v.created_at,
  }, extra || {});
}

function select(files, runs, params, config) {
  return core.selectNextBatch({ config: Object.assign({}, CFG, config), files, runLog: runLogValues(runs || []), now: NOW, params });
}

const A = file('drv-a', 'demo-supplier_2026-10-12.csv', '2026-10-12T06:00:00.000Z', '2026-10-12T05:00:00.000Z');
const B = file('drv-b', 'demo-supplier_2026-10-19.csv', '2026-10-19T06:00:00.000Z', '2026-10-19T05:00:00.000Z');
const C = file('drv-c', 'demo-supplier_2026-10-26.csv', '2026-10-26T06:00:00.000Z', '2026-10-26T05:00:00.000Z');

test('a backlog is processed oldest effective date first, one per run', () => {
  const files = [C, A, B];
  const picks = [];
  const runs = [];
  for (let i = 0; i < 4; i += 1) {
    const s = select(files, runs);
    picks.push([s.action, s.batch ? s.batch.file_id : '', s.queue_remaining]);
    if (s.action === 'PROCESS') runs.push(runRow(`r${i}`, files.find((f) => f.id === s.batch.file_id), i === 0 ? 'SUCCESS_WITH_EXCEPTIONS' : 'SUCCESS'));
  }
  assert.deepEqual(picks, [['PROCESS', 'drv-a', 2], ['PROCESS', 'drv-b', 1], ['PROCESS', 'drv-c', 0], ['IDLE', '', 0]]);
});

test('editing a file in Drive creates a distinguishable batch version', () => {
  const edited = Object.assign({}, B, { modifiedTime: '2026-10-20T09:30:00Z' });
  assert.equal(version(B).batch_id, 'drv-b@2026-10-19T06:00:00.000Z');
  assert.equal(version(edited).batch_id, 'drv-b@2026-10-20T09:30:00.000Z');
});

test('an older effective date can never roll back a newer committed catalog', () => {
  const lateOld = file('drv-d', 'demo-supplier_2026-10-12.csv', '2026-10-27T07:00:00.000Z');
  const s = select([B, lateOld], [runRow('r1', B, 'SUCCESS')]);
  assert.deepEqual([s.action, s.code, s.batch.file_id], ['REJECT_FILE', 'OUT_OF_ORDER_FILE', 'drv-d']);

  const editedOld = Object.assign({}, A, { modifiedTime: '2026-10-27T07:00:00.000Z' });
  const s2 = select([editedOld, B, C], [runRow('r1', A, 'SUCCESS'), runRow('r2', B, 'SUCCESS'), runRow('r3', C, 'SUCCESS')]);
  assert.deepEqual([s2.action, s2.code, s2.batch.batch_id], ['REJECT_FILE', 'OUT_OF_ORDER_FILE', 'drv-a@2026-10-27T07:00:00.000Z']);
});

test('an older version of the committed date is rejected; a newer version is processed as a correction', () => {
  const committed = Object.assign({}, C, { modifiedTime: '2026-10-26T09:00:00.000Z' });
  const older = file('drv-e', 'demo-supplier_2026-10-26.csv', '2026-10-26T07:00:00.000Z');
  const s = select([committed, older], [runRow('r1', committed, 'SUCCESS')]);
  assert.deepEqual([s.action, s.code, s.batch.file_id], ['REJECT_FILE', 'OUT_OF_ORDER_FILE', 'drv-e']);

  const correction = Object.assign({}, C, { modifiedTime: '2026-10-27T07:00:00.000Z' });
  const s2 = select([correction], [runRow('r1', C, 'SUCCESS')]);
  assert.deepEqual([s2.action, s2.batch.batch_id], ['PROCESS', 'drv-c@2026-10-27T07:00:00.000Z']);
});

test('same effective date: ordered by modified time, then created time, then file id', () => {
  const f1 = file('drv-z', 'demo-supplier_2026-10-26.csv', '2026-10-26T06:00:00.000Z', '2026-10-26T01:00:00.000Z');
  const f2 = file('drv-y', 'demo-supplier_2026-10-26.csv', '2026-10-26T05:00:00.000Z', '2026-10-26T02:00:00.000Z');
  assert.equal(select([f1, f2]).batch.file_id, 'drv-y');
  const g1 = file('drv-z', 'demo-supplier_2026-10-26.csv', '2026-10-26T05:00:00.000Z', '2026-10-26T01:00:00.000Z');
  const g2 = file('drv-y', 'demo-supplier_2026-10-26.csv', '2026-10-26T05:00:00.000Z', '2026-10-26T02:00:00.000Z');
  assert.equal(select([g2, g1]).batch.file_id, 'drv-z');
  const h1 = file('drv-z', 'demo-supplier_2026-10-26.csv', '2026-10-26T05:00:00.000Z');
  const h2 = file('drv-y', 'demo-supplier_2026-10-26.csv', '2026-10-26T05:00:00.000Z');
  assert.equal(select([h1, h2]).batch.file_id, 'drv-y');
});

test('malformed names are reported once each, oldest first, before valid files', () => {
  const files = [
    B,
    file('drv-bad1', 'Demo-Supplier_2026-10-19.csv', '2026-10-20T06:00:00.000Z'),
    file('drv-bad2', 'prices.xlsx', '2026-10-18T06:00:00.000Z'),
    file('drv-wrong', 'other-supplier_2026-10-19.csv', '2026-10-21T06:00:00.000Z'),
    file('drv-date', 'demo-supplier_2026-02-30.csv', '2026-10-22T06:00:00.000Z'),
    file('drv-ext', 'demo-supplier_2026-10-19.CSV', '2026-10-23T06:00:00.000Z'),
  ];
  const runs = [];
  const picks = [];
  for (let i = 0; i < 6; i += 1) {
    const s = select(files, runs);
    picks.push([s.action, s.code, s.batch.file_id]);
    if (s.action === 'REJECT_FILE') runs.push(runRow(`r${i}`, files.find((f) => f.id === s.batch.file_id), 'REJECTED_FILE'));
  }
  assert.deepEqual(picks, [
    ['REJECT_FILE', 'BAD_FILENAME', 'drv-bad2'],
    ['REJECT_FILE', 'BAD_FILENAME', 'drv-bad1'],
    ['REJECT_FILE', 'WRONG_SUPPLIER', 'drv-wrong'],
    ['REJECT_FILE', 'BAD_FILENAME', 'drv-date'],
    ['REJECT_FILE', 'BAD_FILENAME', 'drv-ext'],
    ['PROCESS', '', 'drv-b'],
  ]);
});

test('Google-native files and files listed above the size limit are rejected before download', () => {
  const sheetFile = Object.assign(file('drv-gs', 'demo-supplier_2026-10-19.csv', '2026-10-19T06:00:00.000Z'),
    { mimeType: 'application/vnd.google-apps.spreadsheet' });
  const big = Object.assign(file('drv-big', 'demo-supplier_2026-10-20.csv', '2026-10-20T06:00:00.000Z'),
    { mimeType: 'text/csv', size: '2000001' });
  const atLimit = Object.assign(file('drv-ok', 'demo-supplier_2026-10-21.csv', '2026-10-21T06:00:00.000Z'),
    { mimeType: 'text/csv', size: '2000000' });
  const files = [sheetFile, big, atLimit];
  const s1 = select(files, []);
  assert.deepEqual([s1.action, s1.code, s1.batch.file_id], ['REJECT_FILE', 'NOT_A_CSV_FILE', 'drv-gs']);
  const s2 = select(files, [runRow('r1', sheetFile, 'REJECTED_FILE')]);
  assert.deepEqual([s2.action, s2.code, s2.batch.file_id], ['REJECT_FILE', 'FILE_TOO_LARGE', 'drv-big']);
  assert.match(s2.message, /2000001 bytes; the limit is 2000000/);
  const s3 = select(files, [runRow('r1', sheetFile, 'REJECTED_FILE'), runRow('r2', big, 'REJECTED_FILE')]);
  assert.deepEqual([s3.action, s3.batch.file_id], ['PROCESS', 'drv-ok']);
  assert.throws(() => select([Object.assign({}, atLimit, { size: '-1' })]), (err) => err.code === 'INVALID_LISTING');
});

test('an incomplete Drive listing blocks the run as QUEUE_TOO_LARGE instead of skipping files', () => {
  const s = core.selectNextBatch({ config: CFG, files: [A], listing_complete: false, runLog: runLogValues([]), now: NOW });
  assert.deepEqual([s.action, s.code, s.batch, s.queue_remaining], ['BLOCKED', 'QUEUE_TOO_LARGE', null, 0]);
  assert.equal(s.message, 'Drive returned the inbox listing in more than one page (1 file on the first page). '
    + 'Run again; if this repeats, move processed files to another folder');
  // Checked before anything else: even a fresh STARTED row does not hide it.
  const busy = core.selectNextBatch({ config: CFG, files: [A], listing_complete: false, runLog: runLogValues([runRow('9', A, 'STARTED', { started_at: NOW })]), now: NOW });
  assert.equal(busy.code, 'QUEUE_TOO_LARGE');
});

test('a halted version blocks the queue; newer files wait', () => {
  const s = select([B, C], [runRow('r1', B, 'HALTED_REVIEW')]);
  assert.deepEqual([s.action, s.code, s.batch.file_id, s.queue_remaining], ['BLOCKED', 'BATCH_HALTED', 'drv-b', 2]);
});

test('failed attempts are retried up to the limit, then the queue blocks', () => {
  const failed = (n) => Array.from({ length: n }, (_, i) => runRow(`f${i}`, B, 'FAILED'));
  assert.equal(select([B, C], failed(2)).action, 'PROCESS');
  const blocked = select([B, C], failed(3));
  assert.deepEqual([blocked.action, blocked.code, blocked.batch.file_id], ['BLOCKED', 'RETRY_LIMIT', 'drv-b']);
  const mixed = failed(1).concat([runRow('i1', B, 'INTERRUPTED'), runRow('s1', B, 'STARTED', { started_at: '2026-10-27T06:00:00.000Z' })]);
  assert.equal(select([B], mixed, undefined, AUTO).code, 'RETRY_LIMIT');
  // By default the unresolved STARTED row blocks first, whatever its attempts.
  assert.equal(select([B], mixed).code, 'PUBLICATION_UNRESOLVED');
});

test('a fresh STARTED row means WAIT; an old one is an unresolved publication, never safe because of its age', () => {
  const fresh = select([B], [runRow('9', B, 'STARTED', { started_at: '2026-10-27T07:50:00.000Z' })]);
  assert.deepEqual([fresh.action, fresh.code], ['WAIT', 'RUN_IN_PROGRESS']);
  // 20 minutes, then 3 days: age only shows that no run is active.
  for (const started of ['2026-10-27T07:40:00.000Z', '2026-10-24T08:00:00.000Z']) {
    const old = select([B], [runRow('9', B, 'STARTED', { started_at: started })]);
    assert.deepEqual([old.action, old.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED'], started);
    assert.deepEqual(old.stale_runs, [{ row_number: 2, run_id: '9', batch_id: version(B).batch_id }]);
  }
  // Only with automatic recovery switched on does a scheduled run reprocess it.
  assert.equal(select([B], [runRow('9', B, 'STARTED', { started_at: '2026-10-27T07:40:00.000Z' })], undefined, AUTO).action, 'PROCESS');
});

test('R5: a committed version is skipped even if a later run for it failed', () => {
  const s = select([B, C], [runRow('5', B, 'SUCCESS'), runRow('6', B, 'FAILED')]);
  assert.deepEqual([s.action, s.batch.file_id], ['PROCESS', 'drv-c']);
});

test('more than 50 listed files blocks the run as QUEUE_TOO_LARGE; 50 are processed', () => {
  const files = Array.from({ length: 51 }, (_, i) => file(`drv-${i}`, `demo-supplier_2026-10-${String((i % 28) + 1).padStart(2, '0')}.csv`, '2026-10-01T00:00:00.000Z'));
  const s = select(files, []);
  assert.deepEqual([s.action, s.code, s.batch], ['BLOCKED', 'QUEUE_TOO_LARGE', null]);
  assert.equal(s.message, 'More than 50 files are in the inbox (51 listed). '
    + 'Move processed files to another folder until at most 50 remain, then run again');
  assert.equal(select(files.slice(0, 50), []).action, 'PROCESS');
});

test('manual runs: reprocess the latest, override a halt, and refuse unsafe targets', () => {
  const runs = [runRow('r1', A, 'SUCCESS'), runRow('r2', B, 'SUCCESS'), runRow('r3', C, 'HALTED_REVIEW')];
  const files = [A, B, C];

  const latest = select(files, runs, { reprocess_latest: true });
  assert.deepEqual([latest.action, latest.batch.file_id, latest.reprocess], ['PROCESS', 'drv-b', true]);

  const override = select(files, runs, { target_batch_id: version(C).batch_id, confirm_mass_discontinue: true });
  assert.deepEqual([override.action, override.batch.file_id, override.confirm_mass_discontinue], ['PROCESS', 'drv-c', true]);

  assert.equal(select(files, runs, { target_batch_id: version(A).batch_id }).code, 'TARGET_OUT_OF_ORDER');
  assert.equal(select(files, runs, { target_batch_id: 'drv-x@2026-10-27T00:00:00.000Z' }).code, 'TARGET_NOT_IN_INBOX');
  assert.equal(select(files, [], { reprocess_latest: true }).code, 'NOTHING_COMMITTED');
  const bad = file('drv-bad', 'prices.csv', '2026-10-27T01:00:00.000Z');
  assert.equal(select([bad], [], { target_batch_id: version(bad).batch_id }).code, 'TARGET_PRECHECK_FAILED');
  const rejected = select([B], [runRow('r1', B, 'REJECTED_FILE')], { target_batch_id: version(B).batch_id });
  assert.deepEqual([rejected.action, rejected.code], ['REFUSED', 'TARGET_REJECTED']);
});

test('invalid listings and run logs are refused', () => {
  assert.throws(() => select([{ id: 'drv-a', name: 'x.csv', modifiedTime: 'yesterday', createdTime: '2026-10-12T05:00:00Z' }]),
    (err) => err.code === 'INVALID_LISTING');
  assert.throws(() => select([A], [runRow('r1', A, 'DONE')]), (err) => err.code === 'RUNLOG_INVALID');
  assert.throws(() => select([A], [runRow('r1', A, 'SUCCESS', { effective_date: '' })]), (err) => err.code === 'RUNLOG_INVALID');
});

// Contract §2: a stale STARTED row is an unresolved publication.
const STALE = { started_at: '2026-10-27T07:40:00.000Z' };
const AUTO = { auto_recover_uncertain: true };

test('with automatic recovery on: while a publication is unresolved, only its batch can be processed, never a newer one', () => {
  // C's attempt is unresolved; B is older and waiting, D is newer.
  const D = file('drv-d', 'demo-supplier_2026-11-02.csv', '2026-11-02T06:00:00.000Z');
  const runs = [runRow('r1', A, 'SUCCESS'), runRow('r2', C, 'STARTED', STALE)];
  const s = select([A, B, C, D], runs, undefined, AUTO);
  assert.deepEqual([s.action, s.batch.file_id, s.reprocess], ['PROCESS', 'drv-c', false]);
  assert.deepEqual(s.stale_runs, [{ row_number: 3, run_id: 'r2', batch_id: version(C).batch_id }]);

  // The unresolved version left the inbox (deleted, or edited into a new version): blocked.
  const gone = select([A, B, D], runs, undefined, AUTO);
  assert.deepEqual([gone.action, gone.code, gone.batch], ['BLOCKED', 'PUBLICATION_UNRESOLVED', null]);
  assert.match(gone.message, /^Publication outcome unknown for row 3 \(run r2, drv-c@2026-10-26T06:00:00\.000Z\), and that file version is no longer in the inbox/);

  // Two different unresolved batches: blocked.
  const two = select([B, C], [runRow('r1', B, 'STARTED', STALE), runRow('r2', C, 'STARTED', STALE)], undefined, AUTO);
  assert.deepEqual([two.action, two.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED']);
  // The same batch unresolved twice is still one batch.
  assert.equal(select([B, C], [runRow('r1', B, 'STARTED', STALE), runRow('r2', B, 'STARTED', STALE)], undefined, AUTO).batch.file_id, 'drv-b');
});

test('with automatic recovery on: an unresolved publication keeps its other limits; nothing newer runs', () => {
  const runs = [runRow('f1', B, 'FAILED'), runRow('f2', B, 'FAILED'), runRow('s1', B, 'STARTED', STALE)];
  const limited = select([B, C], runs, undefined, AUTO);
  assert.deepEqual([limited.action, limited.code, limited.batch.file_id], ['BLOCKED', 'RETRY_LIMIT', 'drv-b']);
  const halted = select([B, C], [runRow('h1', B, 'HALTED_REVIEW'), runRow('s1', B, 'STARTED', STALE)], undefined, AUTO);
  assert.deepEqual([halted.action, halted.code], ['BLOCKED', 'BATCH_HALTED']);
  // An unresolved reprocess of a committed batch is processed again, as a reprocess.
  const again = select([B, C], [runRow('r1', B, 'SUCCESS'), runRow('r2', B, 'STARTED', STALE)], undefined, AUTO);
  assert.deepEqual([again.action, again.batch.file_id, again.reprocess], ['PROCESS', 'drv-b', true]);
  // An unresolved rejection is published again as the same rejection.
  const bad = file('drv-bad', 'prices.csv', '2026-10-27T01:00:00.000Z');
  const rejection = select([bad, C], [runRow('r1', bad, 'STARTED', STALE)], undefined, AUTO);
  assert.deepEqual([rejection.action, rejection.code, rejection.batch.file_id], ['REJECT_FILE', 'BAD_FILENAME', 'drv-bad']);
});

test('manual runs cannot overtake an unresolved publication; targeting it is allowed', () => {
  const runs = [runRow('r1', A, 'SUCCESS'), runRow('r2', C, 'STARTED', STALE)];
  for (const params of [{ target_batch_id: version(B).batch_id }, { reprocess_latest: true }]) {
    const s = select([A, B, C], runs, params);
    assert.deepEqual([s.action, s.code], ['REFUSED', 'PUBLICATION_UNRESOLVED'], JSON.stringify(params));
    assert.match(s.message, /only target_batch_id drv-c@2026-10-26T06:00:00\.000Z can run$/);
  }
  const target = select([A, B, C], runs, { target_batch_id: version(C).batch_id });
  assert.deepEqual([target.action, target.batch.file_id], ['PROCESS', 'drv-c']);
});

test('by default an unresolved publication blocks until a person explicitly targets it', () => {
  const runs = [runRow('r1', A, 'SUCCESS'), runRow('r2', C, 'STARTED', STALE)];
  const blocked = select([A, B, C], runs);
  assert.deepEqual([blocked.action, blocked.code, blocked.batch.file_id], ['BLOCKED', 'PUBLICATION_UNRESOLVED', 'drv-c']);
  assert.match(blocked.message, /outcome is not established and automatic recovery is off\. Inspect the evidence .*target_batch_id drv-c@2026-10-26T06:00:00\.000Z$/);
  assert.doesNotMatch(blocked.message, /by hand/, 'never advises marking the row by hand');
  const explicit = select([A, B, C], runs, { target_batch_id: version(C).batch_id });
  assert.deepEqual([explicit.action, explicit.batch.file_id], ['PROCESS', 'drv-c']);
  assert.equal(core.DEFAULT_CONFIG.auto_recover_uncertain, false, 'off by default');
});
