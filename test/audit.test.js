'use strict';

// Tests added by the November 2026 engineering audit: confirmed defects, and
// contract rules that had no direct test. Offline: no network, no Google, no n8n.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { core, sheetState, runLogValues, tableValues, makeBatch, afterWeek2State, week2 } = require('./support/helpers.js');
const { parseArgs, versionVerdict } = require('../scripts/live/run-live-tests.js');
const R = require('../scripts/live/report.js');
const { buildWorkflow } = require('../workflow/build.js');

const META = Object.fromEntries(['Catalog', 'Review', 'Changes', 'Exceptions', 'Run Log'].map((t, i) => [t, { sheetId: i, rowCount: 200, columnCount: 30 }]));
const cat = (sku, price, extra) => Object.assign({
  sku, name: `Item ${sku}`, unit: 'each', unit_price: price, currency: 'ETB', status: 'ACTIVE', previous_price: '',
  first_seen: '2026-10-05', last_seen: '2026-10-12', last_changed: '2026-10-05', pending_review: '', last_issue: '',
}, extra);
const item = (sku, batchId, price, extra) => Object.assign({
  review_id: `RV|${sku}|${batchId}`, sku, status: 'PENDING', reasons: 'LARGE_PRICE_CHANGE', current_name: `Item ${sku}`, current_unit: 'each',
  current_price: 100, proposed_name: `Item ${sku}`, proposed_unit: 'each', proposed_price: price, change_pct: '', first_seen: '2026-10-19',
  last_seen: '2026-10-19', source_row: 2, decision: '', note: '',
}, extra);
const run = (csv, state) => core.processBatch({
  config: {}, batch: makeBatch(), csvText: `sku,name,unit,unit_price\n${csv}\n`,
  run: { run_id: 'r1', started_at: '2026-10-26T07:00:00.000Z' }, sheet: sheetState(state),
});
const OLD = 'drv-old@2026-10-19T06:00:00.000Z';
const OWN = 'drv-test@2026-10-26T06:00:00.000Z';

// ---- Confirmed defects ----------------------------------------------------

test('§8: a boolean typed in a decision or note cell keeps its value and type through a publish', () => {
  const w = week2();
  const plan = core.processBatch({
    config: w.config, batch: w.batch, csvText: w.csvText, run: w.run,
    sheet: afterWeek2State({ 'EGG-030': { note: true, decision: false } }),
  });
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 2 });
  const update = body.requests.find((r) => r.updateCells && r.updateCells.range.sheetId === 1);
  const row = update.updateCells.rows[plan.writes.review.findIndex((x) => x.sku === 'EGG-030')];
  assert.deepEqual(row.values[core.REVIEW_COLUMNS.indexOf('note')], { userEnteredValue: { boolValue: true } });
  assert.deepEqual(row.values[core.REVIEW_COLUMNS.indexOf('decision')], { userEnteredValue: { boolValue: false } });
});

test('§8: a final Review read with no usable rows is REVIEW_READ_FAILED, not REVIEW_CHANGED', () => {
  const planned = tableValues(core.REVIEW_COLUMNS, [item('AB-1', OLD, 200)]);
  for (const finalRead of [{}, { values: [] }]) {
    assert.throws(() => core.checkReviewUnchanged({ planned, finalRead }), (err) => err.code === 'REVIEW_READ_FAILED' && /Nothing was published/.test(err.detail));
  }
});

test('§7: the tampering guard also covers an item whose altered proposal fires no review rule', () => {
  const invalid = (err) => err.code === 'REVIEW_INVALID' && /edited by hand/.test(err.detail);
  // The file's 110.00 is within 25% of the catalog, but the batch's own item shows 500.00.
  assert.throws(() => run('AB-1,Item AB-1,each,110.00', { catalog: [cat('AB-1', 100)], review: [item('AB-1', OWN, 500)] }), invalid);
  // The SKU is not in the catalog at all.
  assert.throws(() => run('AB-1,Item AB-1,each,110.00\nZZ-9,Item ZZ-9,each,100.00', { catalog: [cat('ZZ-9', 100)], review: [item('AB-1', OWN, 500)] }), invalid);
  // A matching proposal from the same batch is not tampering.
  assert.equal(run('AB-1,Item AB-1,each,500.00', { catalog: [cat('AB-1', 100)], review: [item('AB-1', OWN, 500)] }).writes.review.length, 1);
});

test('§12: after an unknown outcome the message does not promise that the next run reconciles it', () => {
  const resolved = core.resolveRunFailure({
    failure: { kind: 'UNKNOWN', code: 'PUBLISH_OUTCOME_UNKNOWN', message: 'HTTP 503' },
    rowRead: { values: [core.rowToValues(core.RUNLOG_COLUMNS, { run_id: 'r1', status: 'STARTED', batch_id: OWN })] },
    runRowNumber: 2, run: { run_id: 'r1' }, batch: { batch_id: OWN }, expectedStatus: 'SUCCESS',
  });
  assert.equal(resolved.write, null);
  assert.doesNotMatch(resolved.message, /next run reconciles/);
  assert.match(resolved.message, /docs\/setup\.md/);
});

const started = (id, batch) => ({
  run_id: id, status: 'STARTED', started_at: '2026-10-26T06:00:00.000Z', batch_id: batch, effective_date: '2026-10-26',
});
const select = (runs, files, params) => core.selectNextBatch({ runLog: runLogValues(runs), files, now: '2026-10-26T07:00:00.000Z', params });
const FILE = (id) => ({ id, name: 'demo-supplier_2026-10-26.csv', modifiedTime: '2026-10-26T06:00:00.000Z', createdTime: '2026-10-26T05:00:00.000Z' });
const batchOf = (id) => `${id}@2026-10-26T06:00:00.000Z`;

test('§2: with automatic recovery off, no message offers a reprocess that would be refused', () => {
  const offers = /reprocess it explicitly|only target_batch_id/;
  // Two batches unresolved: neither can run.
  const two = [started('1', batchOf('drvAAA')), started('2', batchOf('drvBBB'))];
  const scheduled = select(two, [FILE('drvAAA'), FILE('drvBBB')]);
  assert.deepEqual([scheduled.action, scheduled.code], ['BLOCKED', 'PUBLICATION_UNRESOLVED']);
  assert.doesNotMatch(scheduled.message, offers);
  assert.match(scheduled.message, /More than one batch/);
  const manual = select(two, [FILE('drvAAA'), FILE('drvBBB')], { target_batch_id: batchOf('drvAAA') });
  assert.equal(manual.code, 'PUBLICATION_UNRESOLVED');
  assert.doesNotMatch(manual.message, offers);
  // The file version has left the inbox.
  const gone = select([started('1', batchOf('drvAAA'))], []);
  assert.doesNotMatch(gone.message, offers);
  assert.match(gone.message, /no longer in the inbox/);
  // One batch in the inbox: the explicit reprocess is the documented next step.
  assert.match(select([started('1', batchOf('drvAAA'))], [FILE('drvAAA')]).message, /reprocess it explicitly/);
});

// ---- Live runner rules ----------------------------------------------------

test('a live T-VERSION-2 needs at least 8 trials: fewer is refused before any live step', () => {
  for (const phase of ['harness', 'all']) {
    assert.throws(() => parseArgs([phase, '--reps=7']), /at least 8/);
    assert.equal(parseArgs([phase, '--reps=8']).reps, 8);
    assert.equal(parseArgs([phase]).reps, 8);
    assert.equal(parseArgs([phase, '--dry-run', '--reps=2']).reps, 2);
  }
  const p = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'live', 'run-live-tests.js'), 'harness', '--reps=7'], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /at least 8/);
});

test('versionVerdict: fewer than 8 live trials is never a pass, whatever the requested count', () => {
  const pass = (n) => Array.from({ length: n }, () => ({ verdict: 'PASS' }));
  assert.equal(versionVerdict(pass(8), { reps: 8, live: true }), 'PASS');
  assert.equal(versionVerdict(pass(7), { reps: 7, live: true }), 'INCONCLUSIVE');
  assert.equal(versionVerdict(pass(7), { reps: 8, live: true }), 'INCONCLUSIVE');
  assert.equal(versionVerdict(pass(2), { reps: 2, live: false }), 'PASS');
  assert.equal(versionVerdict([], { reps: 1, live: false }), 'INCONCLUSIVE');
  assert.equal(versionVerdict(pass(7).concat({ verdict: 'FAIL' }), { reps: 8, live: true }), 'FAIL');
  assert.equal(versionVerdict(pass(7).concat({ verdict: 'INCONCLUSIVE' }), { reps: 8, live: true }), 'INCONCLUSIVE');
});

const FULL = ['T-UI', 'T-LIVE-1', 'T-ATOM-1', 'T-ATOM-2', 'T-SEC-1', 'T-VERSION-1', 'T-LOST-A', 'T-LOST-B'].map((id) => ({ id, verdict: 'PASS' }));
const phases = ['check', 'harness', 'recovery'];

test('the report refuses a live T-VERSION-2 PASS that holds fewer than 8 trials', () => {
  const withTrials = (n) => FULL.concat({ id: 'T-VERSION-2', verdict: 'PASS', details: { trials: Array.from({ length: n }, () => ({ verdict: 'PASS' })) } });
  assert.equal(R.assess({ results: withTrials(8), phases, transport: 'live', ledgerUnresolved: [] }).exit_code, 0);
  for (const results of [withTrials(7), FULL.concat({ id: 'T-VERSION-2', verdict: 'PASS' })]) {
    const s = R.assess({ results, phases, transport: 'live', ledgerUnresolved: [] });
    assert.equal(s.exit_code, 1);
    assert.match(s.malformed.join(), /T-VERSION-2: PASS with \d+ recorded trials; a live verdict needs at least 8/);
    assert.ok(!s.passed.includes('T-VERSION-2'));
  }
});

test('a passing single phase says it is partial verification, in the terminal and the report', () => {
  const s = R.assess({ results: [{ id: 'T-UI', verdict: 'PASS' }, { id: 'T-LIVE-1', verdict: 'PASS' }], phases: ['check'], transport: 'live', ledgerUnresolved: [] });
  assert.equal(s.exit_code, 0);
  assert.equal(s.verification, 'PARTIAL');
  assert.equal(s.outcome, 'PARTIAL_PASSED');
  const text = R.summaryLines(s, { transport: 'live', declared: 0 }).join('\n');
  assert.match(text, /Result: PARTIAL VERIFICATION PASSED \(check only\)/);
  assert.match(text, /full live suite has not been verified by this run/);
  assert.doesNotMatch(text, /ALL REQUIRED TESTS PASSED/);
  const full = R.assess({ results: FULL.concat({ id: 'T-VERSION-2', verdict: 'PASS', details: { trials: Array(8).fill({ verdict: 'PASS' }) } }), phases, transport: 'live', ledgerUnresolved: [] });
  assert.deepEqual([full.verification, full.outcome], ['FULL', 'ALL_REQUIRED_PASSED']);
});

test('the replay does not share a task-runner port with the dedicated n8n server', () => {
  const fs = require('node:fs');
  const port = (file, re) => re.exec(fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8'))[1];
  assert.notEqual(port('verify-in-n8n.js', /N8N_RUNNERS_BROKER_PORT: '(\d+)'/), port('start-n8n.sh', /N8N_RUNNERS_BROKER_PORT=(\d+)/));
});

// ---- Contract rules without a direct test (expected to pass) ---------------

test('§3: BOM, LF, CRLF and lone CR parse to the same records; a final break adds none', () => {
  const expected = [['a', 'b'], ['1', '2']];
  for (const text of ['a,b\n1,2', 'a,b\n1,2\n', 'a,b\r\n1,2\r\n', 'a,b\r1,2\r', '﻿a,b\n1,2\n']) {
    assert.deepEqual(core.parseCsv(text).map((r) => r.fields), expected, JSON.stringify(text));
  }
});

test('§3: quoted commas, CRLF inside quotes and escaped quotes; numbering stays logical', () => {
  const records = core.parseCsv('a,b\r\n"x,""y""","l1\r\nl2"\r\nc,d\r\n');
  assert.deepEqual(records[1].fields, ['x,"y"', 'l1\r\nl2']);
  assert.deepEqual([records[2].record, records[2].line], [3, 4]);
});

test('§3, §6: a whitespace-only record is BLANK at any width; a shifted record is rejected, never re-aligned', () => {
  const plan = run('AB-1,Item AB-1,each,100.00\n  ,\t, \n \nCD-2,Item,with comma,each,100.00', { catalog: [cat('AB-1', 100), cat('CD-2', 100)] });
  assert.deepEqual(plan.row_outcomes.map((r) => r.outcome), ['ACCEPTED', 'BLANK', 'BLANK', 'REJECTED']);
  assert.equal(plan.writes.exceptions[0].code, 'FIELD_COUNT_MISMATCH');
  assert.equal(plan.writes.catalog.find((c) => c.sku === 'CD-2').status, 'ACTIVE');
});

test('§5, §6: SKU identity ignores case and outer spaces', () => {
  const same = run('ab-1,Item AB-1,each,100.00\n AB-1 ,Item AB-1,each,100.00', { catalog: [cat('AB-1', 100)] });
  assert.deepEqual(same.row_outcomes.map((r) => r.outcome), ['ACCEPTED', 'COLLAPSED']);
  const differ = run('ab-1,Item AB-1,each,100.00\nAB-1,Item AB-1,each,101.00', { catalog: [cat('AB-1', 100)] });
  assert.deepEqual(differ.row_outcomes.map((r) => r.outcome), ['HELD_CONFLICT', 'HELD_CONFLICT']);
});

test('§5: price limits are exact in integer cents, with no rounding drift', () => {
  assert.equal(core.parsePrice('10,000,000.00').cents, 1000000000);
  assert.equal(core.parsePrice('10000000.01').code, 'INVALID_PRICE');
  assert.equal(core.parsePrice('0.01').cents, 1);
  assert.equal(core.parsePrice('0.00').code, 'INVALID_PRICE');
  for (let cents = 1; cents < 3000; cents += 7) {
    const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    assert.equal(core.parsePrice(text).cents, cents, text);
  }
});

test('§11: formula-like text from the file reaches every tab as text, never as a formula', () => {
  const evil = '=IMPORTXML("http://x","//a")';
  const plan = run(`AB-1,"${evil.replace(/"/g, '""')}",each,100.00\n+CMD,x,each,1.00`, { catalog: [] });
  const body = JSON.stringify(core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 2 }));
  assert.ok(!body.includes('formulaValue'));
  assert.ok(body.includes(JSON.stringify({ stringValue: evil }).slice(1, -1)));
});

test('§2: the selected batch does not depend on the order Drive lists the files', () => {
  const files = ['07', '05', '09', '06'].map((d, i) => ({ id: `drvFile${i}`, name: `demo-supplier_2026-11-${d}.csv`, modifiedTime: `2026-11-${d}T06:00:00.000Z`, createdTime: `2026-11-${d}T05:00:00.000Z` }));
  const pick = (list) => select([], list).batch.effective_date;
  assert.equal(pick(files), '2026-11-05');
  assert.equal(pick(files.slice().reverse()), '2026-11-05');
  assert.equal(pick([files[2], files[0], files[3], files[1]]), '2026-11-05');
});

test('§12: publish HTTP outcomes: only a 2xx is applied, only a 4xx other than 408 is refused', () => {
  const outcome = (statusCode) => core.interpretPublishResponse({ statusCode, body: '' }).outcome;
  for (const s of [200, 204]) assert.equal(outcome(s), 'APPLIED', s);
  for (const s of [400, 401, 403, 404, 409, 429]) assert.equal(outcome(s), 'REJECTED', s);
  for (const s of [100, 301, 408, 500, 502, 503, 504]) assert.equal(outcome(s), 'UNKNOWN', s);
  assert.equal(core.interpretPublishResponse({ error: { message: 'ETIMEDOUT' } }).outcome, 'UNKNOWN');
  assert.equal(core.interpretPublishResponse(undefined).outcome, 'UNKNOWN');
});

test('property: reordering rows keeps accounting exact, and repeating a plan is byte-identical', () => {
  const rows = ['AB-1,Item AB-1,each,100.00', 'AB-1,Item AB-1,each,100.00', 'CD-2,Item CD-2,each,bad', 'CD-2,Item CD-2,each,100.00', 'EF-3,New,each,5.00', ',,,', 'GH-4,Item GH-4,each,500.00'];
  const state = { catalog: [cat('AB-1', 100), cat('CD-2', 100), cat('GH-4', 100)] };
  let seed = 12345;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (let i = 0; i < 25; i += 1) {
    const shuffled = rows.map((r) => [next(), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const plan = run(shuffled.join('\n'), state);
    const s = plan.summary;
    assert.equal(s.rows_read, s.accepted + s.collapsed + s.rejected + s.held_conflict + s.held_review + s.blank);
    assert.deepEqual([s.accepted, s.collapsed, s.rejected, s.held_conflict, s.held_review, s.blank], [2, 1, 1, 1, 1, 1]);
    assert.equal(JSON.stringify(run(shuffled.join('\n'), state)), JSON.stringify(plan));
  }
});

// ---- Workflow graph --------------------------------------------------------

test('workflow graph: every node runs from a trigger, and Publish is reachable only through its checks', () => {
  const wf = buildWorkflow();
  const edges = Object.entries(wf.connections).flatMap(([from, c]) => c.main.flat().map((t) => [from, t.node]));
  const into = (name) => edges.filter(([, to]) => to === name).map(([from]) => from).sort();
  assert.equal(wf.nodes.length, 33);
  assert.equal(wf.active, false);
  const seen = new Set(wf.nodes.filter((n) => /Trigger$/.test(n.type)).map((n) => n.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const [from, to] of edges) if (seen.has(from) && !seen.has(to)) { seen.add(to); grew = true; }
  }
  const unreachable = wf.nodes.filter((n) => !seen.has(n.name) && !n.type.endsWith('stickyNote')).map((n) => n.name);
  assert.deepEqual(unreachable, []);
  assert.deepEqual(into('Publish'), ['Publish or record failure', 'Review unchanged?']);
  assert.deepEqual(into('Re-read Review'), ['Publish or record failure']);
  assert.deepEqual(into('Write FAILED row'), ['Write FAILED?']);
  // The route that skips Re-read Review is the one Plan and build uses for plans that do not write Review.
  const out = wf.connections['Publish or record failure'].main.map((o) => o[0].node);
  assert.deepEqual(out, ['Re-read Review', 'Read run row', 'Publish']);
  const publish = wf.nodes.find((n) => n.name === 'Publish');
  assert.ok(!publish.retryOnFail);
  const http = wf.nodes.filter((n) => n.type.endsWith('httpRequest'));
  assert.equal(http.length, 12);
  for (const n of http) assert.deepEqual(n.credentials, { googleApi: { id: null, name: 'SheetOps Google service account' } }, n.name);
});
