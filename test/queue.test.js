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
  assert.equal(select([B], mixed).code, 'RETRY_LIMIT');
});

test('a fresh STARTED row means WAIT; a stale one counts as an attempt and is listed for marking', () => {
  const fresh = select([B], [runRow('9', B, 'STARTED', { started_at: '2026-10-27T07:50:00.000Z' })]);
  assert.deepEqual([fresh.action, fresh.code], ['WAIT', 'RUN_IN_PROGRESS']);
  const stale = select([B], [runRow('9', B, 'STARTED', { started_at: '2026-10-27T07:40:00.000Z' })]);
  assert.equal(stale.action, 'PROCESS');
  assert.deepEqual(stale.stale_runs, [{ row_number: 2, run_id: '9', batch_id: version(B).batch_id }]);
});

test('R5: a committed version is skipped even if a later run for it failed', () => {
  const s = select([B, C], [runRow('5', B, 'SUCCESS'), runRow('6', B, 'FAILED')]);
  assert.deepEqual([s.action, s.batch.file_id], ['PROCESS', 'drv-c']);
});

test('more than 50 listed files blocks the run', () => {
  const files = Array.from({ length: 51 }, (_, i) => file(`drv-${i}`, `demo-supplier_2026-10-${String((i % 28) + 1).padStart(2, '0')}.csv`, '2026-10-01T00:00:00.000Z'));
  const s = select(files, []);
  assert.deepEqual([s.action, s.code], ['BLOCKED', 'INBOX_TOO_LARGE']);
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
  assert.equal(select([bad], [], { target_batch_id: version(bad).batch_id }).code, 'TARGET_BAD_FILENAME');
  const rejected = select([B], [runRow('r1', B, 'REJECTED_FILE')], { target_batch_id: version(B).batch_id });
  assert.deepEqual([rejected.action, rejected.code], ['REFUSED', 'TARGET_REJECTED']);
});

test('invalid listings and run logs are refused', () => {
  assert.throws(() => select([{ id: 'drv-a', name: 'x.csv', modifiedTime: 'yesterday', createdTime: '2026-10-12T05:00:00Z' }]),
    (err) => err.code === 'INVALID_LISTING');
  assert.throws(() => select([A], [runRow('r1', A, 'DONE')]), (err) => err.code === 'RUNLOG_INVALID');
  assert.throws(() => select([A], [runRow('r1', A, 'SUCCESS', { effective_date: '' })]), (err) => err.code === 'RUNLOG_INVALID');
});
