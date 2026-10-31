'use strict';

// SheetOps live tests on the dedicated synthetic spreadsheet (docs/setup.md §5).
//
//   node scripts/live/run-live-tests.js check      T-UI (import and credential), T-LIVE-1
//   node scripts/live/run-live-tests.js harness    T-ATOM-1, T-ATOM-2 with T-SEC-1, T-VERSION-1, T-VERSION-2
//   node scripts/live/run-live-tests.js recovery   T-LOST-A (applied, response lost), T-LOST-B (never applied)
//   node scripts/live/run-live-tests.js all
//   node scripts/live/run-live-tests.js reconcile  read-only: what the evidence shows about every
//                                                  unresolved publication; records operator declarations
//
// Options: --dry-run (fake Google and the n8n simulator; touches nothing),
// --broken-google (dry run with Google's sheet checks switched off, to show
// the harness detects a failed version check), --reps=N (T-VERSION-2, default 8),
// reconcile only: --declare=<entry id or run:<run id>>:not-applied --reason="...".
//
// Every write is recorded first in a ledger (var/live/ledger-<spreadsheet>.json).
// The runner resets or publishes only when every earlier publication is
// established, by evidence, as not submitted, rejected or committed. Age is
// never evidence (lib.js, "The publication ledger").
//
// Live runs read the spreadsheet and folder IDs from the Settings node of the
// workflow imported in the n8n UI, and the credential's ID (never its data)
// from n8n's database. Every write goes only to a spreadsheet whose title
// contains "synthetic" and whose tabs are exactly SheetOps' own. Evidence goes
// to var/live/ (gitignored). n8n's own server must be stopped while this runs.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../../src/sheetops-core.js');
const { FakeGoogle } = require('../../test/support/fake-google.js');
const { CREDENTIAL_NAME } = require('../../workflow/build.js');
const L = require('./lib.js');

const PRODUCTION_NAME = 'SheetOps: supplier price list reconciliation';
const FIXTURES = path.join(L.ROOT, 'fixtures', 'week2');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
const WEEK2_CSV = fs.readFileSync(path.join(FIXTURES, 'demo-supplier_2026-10-19.csv'), 'utf8');
const CATALOG_BEFORE = readJson('catalog_before.json');
const EXPECTED = {
  catalog: readJson('expected/catalog_after.json'),
  review: readJson('expected/review_after.json'),
  changes: readJson('expected/changes_new.json'),
  exceptions: readJson('expected/exceptions_new.json'),
  runRow: readJson('expected/run_row.json'),
};
const FIXTURE_BATCH = 'drv-week2@2026-10-19T06:00:00.000Z';
// SheetOps itself treats a STARTED row younger than 15 minutes as possibly
// active (WAIT). T-LOST-B waits that long to test the product's next steps;
// the runner never uses age as evidence about a publication.
const PRODUCT_ACTIVE_WINDOW_MS = 15 * 60000 + 30000;

// ---------------------------------------------------------------------------

class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.results = [];
    fs.mkdirSync(dir, { recursive: true });
  }

  save(test, step, data) {
    const folder = path.join(this.dir, test);
    fs.mkdirSync(folder, { recursive: true });
    const text = L.redact(JSON.stringify(data, null, 2)).text;
    fs.writeFileSync(path.join(folder, `${step}.json`), `${text}\n`);
  }

  result(id, verdict, details) {
    this.results.push({ id, verdict, details });
    console.log(`${verdict.padEnd(12)} ${id}`);
    for (const line of [].concat(details.summary || [])) console.log(`             ${line}`);
    for (const line of [].concat(details.problems || []).slice(0, 12)) console.log(`             ! ${line}`);
  }

  finish(meta) {
    const report = Object.assign({}, meta, { finished_at: new Date().toISOString(), results: this.results });
    fs.writeFileSync(path.join(this.dir, 'report.json'), `${L.redact(JSON.stringify(report, null, 2)).text}\n`);
    return report;
  }
}

function parseArgs(argv) {
  const args = { phase: argv[0] || 'all', dry: false, broken: false, reps: 8, declare: [], reason: '' };
  for (const a of argv.slice(1)) {
    if (a === '--dry-run') args.dry = true;
    else if (a === '--broken-google') { args.dry = true; args.broken = true; }
    else if (a.startsWith('--reps=')) args.reps = Number(a.slice(7));
    else if (a.startsWith('--declare=')) args.declare.push(a.slice(10));
    else if (a.startsWith('--reason=')) args.reason = a.slice(9);
    else throw new Error(`Unknown option ${a}`);
  }
  if (!['check', 'harness', 'recovery', 'all', 'reconcile'].includes(args.phase)) throw new Error(`Unknown phase ${args.phase}`);
  if (args.declare.length > 0 && args.phase !== 'reconcile') throw new Error('--declare is only accepted by the reconcile phase');
  return args;
}

// ---------------------------------------------------------------------------
// n8n's database, read-only: credential IDs and names, workflow nodes and
// execution records. The credential data column is never selected.
// ---------------------------------------------------------------------------

function readN8nDatabase() {
  const file = path.join(L.ROOT, 'var', 'n8n', '.n8n', 'database.sqlite');
  if (!fs.existsSync(file)) throw new Error('var/n8n has no n8n database yet: complete docs/setup.md sections 3 and 4 first');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const credentials = db.prepare('SELECT id, name, type FROM credentials_entity').all();
    const workflows = db.prepare('SELECT id, name, active, nodes FROM workflow_entity').all().map((w) => Object.assign({}, w, { nodes: JSON.parse(w.nodes) }));
    const executions = db.prepare('SELECT id, "workflowId" AS workflowId, status, mode, "startedAt" AS startedAt FROM execution_entity ORDER BY id DESC LIMIT 200').all();
    const dataOf = (executionId) => {
      const row = db.prepare('SELECT data FROM execution_data WHERE "executionId" = ?').get(executionId);
      if (!row) return null;
      const flatted = require(path.join(process.env.HOME, '.local/lib/node_modules/n8n/node_modules/flatted'));
      return flatted.parse(row.data);
    };
    return { credentials, workflows, executions, dataOf };
  } finally {
    // dataOf is used before close below; keep the handle until the caller is done.
    process.on('exit', () => db.close());
  }
}

// ---------------------------------------------------------------------------

function makeContext(args, hooks) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recorder = new Recorder(path.join(L.ROOT, 'var', 'live', `${args.dry ? (args.broken ? 'dry-broken' : 'dry') : 'live'}-${stamp}`));
  if (args.dry && hooks.google) {
    // Tests continue with a spreadsheet an earlier dry run left behind.
    const transport = L.dryTransport({ google: hooks.google, hooks: hooks.transport, start: hooks.start });
    return withLedger({ args, hooks, recorder, transport, settings: { spreadsheet_id: hooks.google.spreadsheetId, inbox_folder_id: hooks.google.folderId, supplier: 'demo-supplier', currency: 'ETB' }, credentialId: null });
  }
  if (args.dry) {
    const google = new FakeGoogle({ spreadsheetId: 'SYNTH_SHEET_1234567890', folderId: 'SYNTH_FOLDER_123456' });
    const tab = (title, columns, sheetId, rows) => {
      google.addTab(title, Array.from(columns), { sheetId });
      for (const row of rows) google.tabs.get(title).rows.push(core.rowToValues(columns, row));
    };
    tab('Catalog', core.CATALOG_COLUMNS, 0, CATALOG_BEFORE);
    tab('Review', core.REVIEW_COLUMNS, 101, []);
    tab('Changes', core.CHANGES_COLUMNS, 102, []);
    tab('Exceptions', core.EXCEPTIONS_COLUMNS, 103, []);
    tab('Run Log', core.RUNLOG_COLUMNS, 104, []);
    google.addFile({ id: 'synthWeek2File', name: 'demo-supplier_2026-10-19.csv', modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T05:58:00.000Z', content: WEEK2_CSV });
    if (args.broken) google.enforceSheetChecks = false;
    if (hooks.setupGoogle) hooks.setupGoogle(google);
    const transport = L.dryTransport({ google, hooks: hooks.transport, start: hooks.start });
    return withLedger({ args, hooks, recorder, transport, settings: { spreadsheet_id: google.spreadsheetId, inbox_folder_id: google.folderId, supplier: 'demo-supplier', currency: 'ETB' }, credentialId: null });
  }
  const running = spawnSync('pgrep', ['-af', 'n8n start'], { encoding: 'utf8' }).stdout.trim();
  if (running) throw new Error(`An n8n server is running; stop it first (CLI runs share its database):\n${running}`);
  const db = readN8nDatabase();
  const credential = db.credentials.filter((c) => c.name === CREDENTIAL_NAME && c.type === 'googleApi');
  if (credential.length !== 1) throw new Error(`Expected exactly one googleApi credential named "${CREDENTIAL_NAME}", found ${credential.length}`);
  const production = db.workflows.filter((w) => w.name === PRODUCTION_NAME);
  if (production.length !== 1) throw new Error(`Expected exactly one imported workflow named "${PRODUCTION_NAME}", found ${production.length}`);
  const settingsNode = production[0].nodes.find((n) => n.name === 'Settings');
  const values = Object.fromEntries(settingsNode.parameters.assignments.assignments.map((a) => [a.name, a.value]));
  const settings = core.checkSettings(values);
  const transport = L.liveTransport({ evidenceDir: recorder.dir });
  transport.setCredentialId(credential[0].id);
  return withLedger({ args, hooks, recorder, transport, settings, credentialId: credential[0].id, db, production: production[0], credential: credential[0] });
}

// The ledger persists across runs for live tests; a dry run keeps its own,
// unless a test passes one. maxVersionSeen keeps fresh version IDs unused.
function withLedger(ctx) {
  const file = ctx.hooks.ledgerFile
    || (ctx.args.dry ? path.join(ctx.recorder.dir, 'ledger.json') : path.join(L.ROOT, 'var', 'live', `ledger-${ctx.settings.spreadsheet_id}.json`));
  return Object.assign(ctx, { ledger: new L.Ledger(file, ctx.settings.spreadsheet_id, () => ctx.transport.now()), maxVersionSeen: 0, versionRegressions: [] });
}

// Sends publish requests (concurrently when more than one), recording each in
// the ledger before it is sent and its established outcome after.
async function sendPublishes(ctx, items) {
  const entries = items.map((item) => {
    const fields = Object.assign({ outcome: 'unknown', basis: 'sent; no answer recorded yet' }, L.publicationFacts(item.body, item.plan));
    if (item.entry) return ctx.ledger.update(item.entry.id, fields);
    return ctx.ledger.add(Object.assign({ kind: 'publish', label: item.label, run_id: item.run.run_id, run_row: item.runRow, batch_id: item.batch.batch_id }, fields));
  });
  const replies = await ctx.transport.send(items.map((item) => ({ method: 'POST', url: publishUrl(ctx), body: item.body })));
  replies.forEach((reply, i) => ctx.ledger.update(entries[i].id, Object.assign(L.outcomeOfReply(reply), { http_status: reply.status, error: reply.error || null })));
  return replies.map((reply, i) => Object.assign({}, reply, { entry: ctx.ledger.entries.find((e) => e.id === entries[i].id) }));
}

// Settles unknown entries that the spreadsheet itself establishes: a commit
// marker for a publication, the intended baseline for a reset. Returns the
// entries still unknown, with what the spreadsheet shows.
function reconcileWithSheet(ctx, snap) {
  const open = [];
  for (const entry of ctx.ledger.forSheet().filter((e) => e.outcome === 'unknown')) {
    if (entry.kind === 'reset') {
      const problems = entry.intended ? L.baselineProblems(snap, entry.intended) : ['no intended baseline recorded'];
      if (problems.length === 0) ctx.ledger.update(entry.id, { outcome: 'committed', basis: 'the spreadsheet holds exactly the baseline this reset writes' });
      else open.push({ entry, evidence: `the spreadsheet does not hold the baseline it writes (${problems[0]})` });
      continue;
    }
    if (!entry.run_id) { open.push({ entry, evidence: 'no run is recorded for it, so there is no marker to check' }); continue; }
    const ev = L.markerEvidence(snap, entry);
    if (ev.state === 'committed') ctx.ledger.update(entry.id, { outcome: 'committed', basis: `commit marker: ${ev.text}` });
    else open.push({ entry, evidence: ev.text, state: ev.state });
  }
  return open;
}

async function snapshot(ctx) {
  const [reply] = await ctx.transport.send([L.snapshotRequest(ctx.settings.spreadsheet_id)]);
  if (reply.status !== 200) throw new Error(`Snapshot read failed: HTTP ${reply.status} ${reply.error || JSON.stringify(reply.body).slice(0, 300)}`);
  const snap = L.normalizeSnapshot(reply.body);
  snap.classification = L.classifySpreadsheet(snap);
  const version = snap.classification.version;
  // Version IDs must only grow: one below an ID already seen is a reuse.
  if (version !== null && version < ctx.maxVersionSeen) ctx.versionRegressions.push({ version, max_seen: ctx.maxVersionSeen, at: ctx.transport.now() });
  if (version !== null) ctx.maxVersionSeen = Math.max(ctx.maxVersionSeen, version);
  return snap;
}

// Preflight before any reset (fail-closed). Stops unless:
//   1. no n8n server, worker or CLI execution is running;
//   2. the target is the synthetic spreadsheet in an accepted state;
//   3. every publication and reset in the ledger is established as not
//      submitted, rejected or committed (unknown ones are first checked
//      against the spreadsheet's own evidence), or carries an explicit
//      operator declaration;
//   4. every STARTED row in Run Log belongs to a run the ledger establishes
//      as not submitted or rejected, or that an operator declared.
// The age of a STARTED row is never evidence: it shows only that no run is
// active, not what happened to its publish.
async function preflight(ctx, test) {
  const processes = ctx.transport.activeN8n();
  if (processes.length > 0) throw new Error(`Preflight ${test}: n8n is running (${processes.join(' | ')}); stopping`);
  const snap = await snapshot(ctx);
  const open = reconcileWithSheet(ctx, snap);
  const problems = [];
  const declared = [];
  for (const { entry, evidence } of open) {
    if (entry.operator) declared.push(`${entry.id} (${entry.label}): operator declared ${entry.operator.declared} on ${entry.operator.at}: "${entry.operator.reason}"`);
    else problems.push(`${entry.id} ${entry.label}${entry.run_id && !entry.label.includes(entry.run_id) ? ` (run ${entry.run_id})` : ''}: outcome unknown (${entry.basis}); ${evidence}`);
  }
  for (const row of L.tabObjects(snap, 'Run Log').filter((r) => r.status === 'STARTED')) {
    const entry = ctx.ledger.byRun(String(row.run_id));
    if (!entry) problems.push(`run ${row.run_id} (${row.batch_id}) is STARTED and the ledger has no record of its publish; whatever its age, its outcome is unknown`);
    else if (entry.outcome === 'committed') problems.push(`run ${row.run_id}: the ledger records it committed (${entry.basis}) but its row shows STARTED`);
  }
  ctx.recorder.save(test, 'preflight', { classification: snap.classification, unresolved: problems, operator_declared: declared });
  if (problems.length > 0) {
    throw new Error(`PUBLICATION_UNRESOLVED at ${test}: ${problems.join('; ')}. Nothing was written. Run "node scripts/live/run-live-tests.js reconcile" and see docs/setup.md, "An unresolved publication"`);
  }
  if (declared.length > 0) console.log(`             ${test}: proceeding on operator declarations (unverified): ${declared.join('; ')}`);
  return { snap, declared };
}

// Puts a known baseline in place and proves it by reading it back. Any failure
// throws, which stops the suite before a test request is prepared.
//   version: 'none' (uninitialized) or 'fresh' (a new, unused version ID)
//   started: test runs whose STARTED rows the baseline holds, at rows 2, 3...
//            Each is recorded as not submitted: its publish is not sent yet.
async function reset(ctx, test, options) {
  const o = Object.assign({ version: 'none', started: [] }, options);
  const { snap } = await preflight(ctx, test);
  const startedRows = o.started.map(({ run, batch }) => core.buildStartedRow(run, batch));
  const { request, intended } = L.resetRequest(snap, {
    spreadsheetId: ctx.settings.spreadsheet_id, catalogRows: CATALOG_BEFORE, startedRows,
    version: o.version, now: ctx.transport.now(), minVersion: ctx.maxVersionSeen,
  });
  const runEntries = o.started.map(({ run, batch }, i) => ctx.ledger.add({
    kind: 'publish', label: `${test} run ${run.run_id}`, run_id: run.run_id, run_row: 2 + i, batch_id: batch.batch_id,
    outcome: 'not_submitted', basis: 'its STARTED row is written by a reset; its publish has not been sent',
  }));
  const resetEntry = ctx.ledger.add({
    kind: 'reset', label: `reset for ${test}`, planned_from: L.versionOf(snap), planned_to: intended.version, intended,
    outcome: 'unknown', basis: 'sent; no answer recorded yet',
  });
  ctx.recorder.save(test, 'reset-request', request.body);
  const [reply] = await ctx.transport.send([request]);
  ctx.ledger.update(resetEntry.id, Object.assign(L.outcomeOfReply(reply), { http_status: reply.status, error: reply.error || null }));
  ctx.recorder.save(test, 'reset-response', reply);
  if (reply.status !== 200) throw new Error(`Reset for ${test} failed: HTTP ${reply.status} ${reply.error || JSON.stringify(reply.body).slice(0, 300)}; stopping`);
  if (intended.version !== null) ctx.maxVersionSeen = Math.max(ctx.maxVersionSeen, intended.version);
  if (ctx.hooks.afterResetWrite) await ctx.hooks.afterResetWrite(ctx, test);
  const readback = await snapshot(ctx);
  const problems = L.baselineProblems(readback, intended);
  ctx.recorder.save(test, 'baseline-readback', { readback, intended, problems });
  if (problems.length > 0) throw new Error(`Baseline for ${test} not confirmed by readback: ${problems.slice(0, 5).join('; ')}; stopping`);
  return { snap: readback, rows: o.started.map((s, i) => 2 + i), version: intended.version, entries: runEntries };
}

const runStatus = (snap, runId) => (L.tabObjects(snap, 'Run Log').find((r) => String(r.run_id) === runId) || {}).status;

// Week-2 expectations with the real Drive batch ID in place of the fixture's.
function week2Problems(snap, batchId) {
  const fix = (rows) => JSON.parse(JSON.stringify(rows).split(FIXTURE_BATCH).join(batchId));
  const strip = (rows) => rows.map((r) => { const c = Object.assign({}, r); delete c.message; return c; });
  const problems = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${label} differs: ${JSON.stringify(actual).slice(0, 400)}`);
  };
  check('Catalog', L.tabObjects(snap, 'Catalog'), fix(EXPECTED.catalog));
  check('Review', L.tabObjects(snap, 'Review'), fix(EXPECTED.review));
  check('Changes', L.tabObjects(snap, 'Changes'), fix(EXPECTED.changes));
  check('Exceptions', strip(L.tabObjects(snap, 'Exceptions')), fix(EXPECTED.exceptions));
  const dups = L.historyDuplicates(snap);
  if (dups.changes.length + dups.exceptions.length > 0) problems.push(`duplicate IDs: ${JSON.stringify(dups)}`);
  return problems;
}

function runRowProblems(row) {
  const skip = ['run_id', 'mode', 'started_at', 'finished_at', 'batch_id', 'source_file_id', 'source_modified_at', 'source_created_at'];
  const problems = [];
  for (const [key, value] of Object.entries(EXPECTED.runRow)) {
    if (skip.includes(key)) continue;
    if (String(row[key]) !== String(value)) problems.push(`run row ${key}: ${row[key]} (expected ${value})`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// check: T-UI and T-LIVE-1
// ---------------------------------------------------------------------------

async function phaseCheck(ctx) {
  if (ctx.transport.kind === 'dry') {
    ctx.recorder.result('T-UI', 'SKIPPED', { summary: 'dry run: no n8n database or UI' });
    const workflow = L.workflowCopy({ id: 'SheetOpsLiveUI', name: 'SheetOps live UI stand-in', settings: ctx.settings });
    await ctx.transport.runWorkflow(workflow);
  } else {
    const problems = [];
    const google = ctx.production.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
    const linked = google.filter((n) => n.credentials && n.credentials.googleApi && n.credentials.googleApi.id === ctx.credential.id);
    // As many Google nodes as the generated workflow has (11 since contract v2.5), all linked.
    const expected = JSON.parse(fs.readFileSync(path.join(L.ROOT, 'workflow', 'sheetops.workflow.json'), 'utf8'))
      .nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').length;
    if (google.length !== expected || linked.length !== expected) problems.push(`${linked.length} of ${google.length} Google nodes are linked to credential ${ctx.credential.id}; the workflow has ${expected}`);
    if (ctx.production.active) problems.push('the workflow is active');
    const executions = ctx.db.executions.filter((e) => e.workflowId === ctx.production.id);
    const doneOf = (execution) => {
      const data = ctx.db.dataOf(execution.id);
      const runData = data && data.resultData && data.resultData.runData;
      return runData && runData.Done ? runData.Done[0].data.main[0][0].json : null;
    };
    // The UI run that published week 2; later runs of the same workflow are IDLE.
    const published = executions.filter((e) => e.status === 'success').map((e) => ({ execution: e, done: doneOf(e) }))
      .filter((x) => x.done && x.done.run_status === 'SUCCESS_WITH_EXCEPTIONS');
    const latest = published[0] ? published[0].execution : null;
    const done = published[0] ? published[0].done : null;
    if (executions.length === 0) problems.push('the imported workflow has no execution: run it once with Test workflow');
    else if (!latest) problems.push(`none of its ${executions.length} executions published week 2: ${executions.slice(0, 3).map((e) => `${e.id} ${e.status}`).join(', ')}`);
    const failedRuns = executions.filter((e) => e.status !== 'success');
    if (failedRuns.length > 0) problems.push(`executions not successful: ${failedRuns.map((e) => `${e.id} ${e.status}`).join(', ')}`);
    const evidence = {
      credential: { id: ctx.credential.id, name: ctx.credential.name, type: ctx.credential.type },
      workflow: { id: ctx.production.id, name: ctx.production.name, active: ctx.production.active },
      google_nodes: google.map((n) => ({ name: n.name, credential: n.credentials && n.credentials.googleApi })),
      settings: ctx.settings,
      executions: executions.slice(0, 5),
      done,
    };
    ctx.recorder.save('T-UI', 'n8n-records', evidence);
    ctx.recorder.result('T-UI', problems.length === 0 ? 'PASS' : 'FAIL', {
      summary: [`${linked.length}/${google.length} Google nodes linked to "${ctx.credential.name}" (${ctx.credential.type}); latest execution ${latest ? `${latest.id} ${latest.mode} ${latest.status}` : 'none'}`],
      problems,
    });
  }
  const snap = await snapshot(ctx);
  ctx.recorder.save('T-LIVE-1', 'after', snap);
  const rows = L.tabObjects(snap, 'Run Log');
  const problems = [];
  if (rows.length !== 1) problems.push(`Run Log has ${rows.length} rows, expected 1`);
  const row = rows[0] || {};
  problems.push(...runRowProblems(row), ...week2Problems(snap, row.batch_id));
  if (snap.classification.state !== 'initialized') problems.push(`after the first publish the spreadsheet is ${snap.classification.state}, expected initialized`);
  ctx.recorder.result('T-LIVE-1', problems.length === 0 ? 'PASS' : 'FAIL', {
    summary: [`batch ${row.batch_id}; run ${row.run_id} ${row.status}; version ${L.versionOf(snap)}`],
    problems,
  });
}

// ---------------------------------------------------------------------------
// harness: T-ATOM-1, T-ATOM-2 (+T-SEC-1), T-VERSION-1, T-VERSION-2
// ---------------------------------------------------------------------------

let fileCounter = 0;
function newRun(ctx, label, day) {
  fileCounter += 1;
  const started = ctx.transport.now();
  return L.testRun(`live-${label}-${fileCounter}`, started, `demo-supplier_2026-11-${String(day).padStart(2, '0')}.csv`, `live-${label}-${fileCounter}`);
}

const publishUrl = (ctx) => `${L.SHEETS}/${ctx.settings.spreadsheet_id}:batchUpdate`;
const winnerOf = (replies) => replies.map((r, k) => (r.status === 200 ? k : -1)).filter((k) => k >= 0);
// How long to wait before re-reading, to see whether anything landed late.
const SETTLE_MS = 20000;

async function phaseHarness(ctx) {
  const formula = '=HYPERLINK("http://example.com","x")';

  // T-ATOM-1 and T-ATOM-2, with T-SEC-1, from an uninitialized baseline.
  {
    const c = newRun(ctx, 'atom', 2);
    const { snap: before, rows: [row] } = await reset(ctx, 'T-ATOM', { version: 'none', started: [c] });
    const csv = L.shiftedCsv(before, 2, [`SEC-1,"${formula.replace(/"/g, '""')}",each,10.00`]);
    const p = L.buildPublish(before, { run: c.run, batch: c.batch, csvText: csv, runRowNumber: row });
    const unused = 2147483000;
    if (Object.values(before.tabs).some((tab) => tab.sheetId === unused)) throw new Error('test sheet ID in use');
    const invalid = { requests: p.body.requests.concat([{ updateCells: { range: { sheetId: unused, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, rows: [{ values: [{ userEnteredValue: { stringValue: 'x' } }] }], fields: 'userEnteredValue' } }]), includeSpreadsheetInResponse: false };
    ctx.recorder.save('T-ATOM', 'request-valid', p.body);
    const [bad] = await sendPublishes(ctx, [{ label: 'T-ATOM-1 invalid publish', run: c.run, batch: c.batch, runRow: row, plan: p.plan, body: invalid }]);
    const afterBad = await snapshot(ctx);
    ctx.recorder.save('T-ATOM', 'response-invalid', bad);
    ctx.recorder.save('T-ATOM', 'after-invalid', afterBad);
    const diff1 = L.diffSnapshots(before, afterBad);
    ctx.recorder.result('T-ATOM-1', bad.status === 400 && diff1.length === 0 ? 'PASS' : 'FAIL', {
      summary: [`${invalid.requests.length} requests, the last invalid: HTTP ${bad.status}; full snapshot unchanged: ${diff1.length === 0}`],
      problems: bad.status === 400 ? diff1 : [`expected HTTP 400, got ${bad.status}`].concat(diff1),
    });

    const [good] = await sendPublishes(ctx, [{ label: 'T-ATOM-2 publish', run: c.run, batch: c.batch, runRow: row, plan: p.plan, body: p.body }]);
    const afterGood = await snapshot(ctx);
    const expected = L.applyToSnapshot(before, p.body);
    ctx.recorder.save('T-ATOM', 'response-valid', good);
    ctx.recorder.save('T-ATOM', 'after-valid', afterGood);
    ctx.recorder.save('T-ATOM', 'expected-valid', expected.snapshot);
    const diff2 = L.diffSnapshots(expected.snapshot, afterGood);
    ctx.recorder.result('T-ATOM-2', good.status === 200 && diff2.length === 0 && L.versionOf(afterGood) === p.version.to ? 'PASS' : 'FAIL', {
      summary: [`HTTP ${good.status}; every tab equals the oracle: ${diff2.length === 0}; ${before.classification.state} → ${afterGood.classification.state}, version ${p.version.from} → ${L.versionOf(afterGood)}; run row ${runStatus(afterGood, c.run.run_id)}`],
      problems: (good.status === 200 ? [] : [`expected HTTP 200, got ${good.status}: ${JSON.stringify(good.body).slice(0, 300)}`]).concat(diff2),
    });

    const secRow = afterGood.tabs.Catalog.rows.find((r) => r[0] && r[0].s === 'SEC-1');
    const nameCell = secRow && secRow[core.CATALOG_COLUMNS.indexOf('name')];
    ctx.recorder.result('T-SEC-1', nameCell && nameCell.s === formula && !('f' in nameCell) ? 'PASS' : 'FAIL', {
      summary: [`Catalog SEC-1 name cell userEnteredValue: ${JSON.stringify(nameCell)}`],
    });
  }

  // T-VERSION-1: a publish planned from a version that has since moved.
  const soloMs = [];
  {
    const a = newRun(ctx, 'v1a', 9);
    const b = newRun(ctx, 'v1b', 9);
    const { snap: s0, rows: [rowA, rowB], version, entries: [entryA, entryB] } = await reset(ctx, 'T-VERSION-1', { version: 'fresh', started: [a, b] });
    const pa = L.buildPublish(s0, { run: a.run, batch: a.batch, csvText: L.shiftedCsv(s0, 1, ['LIVE-V1A,Live test item A,each,11.00']), runRowNumber: rowA });
    const pb = L.buildPublish(s0, { run: b.run, batch: b.batch, csvText: L.shiftedCsv(s0, -1, ['LIVE-V1B,Live test item B,each,12.00']), runRowNumber: rowB });
    if (pa.version.from !== version || pb.version.from !== version) throw new Error('T-VERSION-1: requests not planned from the baseline version; stopping');
    const [ra] = await sendPublishes(ctx, [{ entry: entryA, run: a.run, batch: a.batch, runRow: rowA, plan: pa.plan, body: pa.body }]);
    const s1 = await snapshot(ctx);
    const [rb] = await sendPublishes(ctx, [{ entry: entryB, run: b.run, batch: b.batch, runRow: rowB, plan: pb.plan, body: pb.body }]);
    const s2 = await snapshot(ctx);
    soloMs.push(ra.node_ms, rb.node_ms);
    for (const [k, v] of Object.entries({ 'request-a': pa.body, 'request-b-stale': pb.body, 'response-a': ra, 'after-a': s1, 'response-b': rb, 'after-b': s2 })) ctx.recorder.save('T-VERSION-1', k, v);
    const expected = L.applyToSnapshot(s0, pa.body).snapshot;
    const problems = [];
    if (ra.status !== 200) problems.push(`first publish: HTTP ${ra.status}`);
    problems.push(...L.diffSnapshots(expected, s1).map((d) => `after A: ${d}`));
    if (rb.status !== 400) problems.push(`stale publish: expected HTTP 400, got ${rb.status}`);
    problems.push(...L.diffSnapshots(s1, s2).map((d) => `after stale B: ${d}`));
    if (runStatus(s2, b.run.run_id) !== 'STARTED') problems.push(`B's run row shows ${runStatus(s2, b.run.run_id)}`);
    const dups = L.historyDuplicates(s2);
    if (dups.changes.length + dups.exceptions.length > 0) problems.push(`duplicate IDs ${JSON.stringify(dups)}`);
    ctx.recorder.result('T-VERSION-1', problems.length === 0 ? 'PASS' : 'FAIL', {
      summary: [`A from version ${pa.version.from}: HTTP ${ra.status}, version now ${L.versionOf(s1)}; stale B from ${pb.version.from}: HTTP ${rb.status} (${rb.body && rb.body.error ? rb.body.error.message : rb.error || ''}); state unchanged by B: ${L.diffSnapshots(s1, s2).length === 0}`],
      problems,
    });
  }

  // T-VERSION-2: trials of two distinct publishes planned from one baseline
  // version and sent in one relay run (both in flight at once). Every trial
  // starts from its own verified baseline, alternating a fresh version (the
  // steady-state race: both delete the same tab) and no version (the first
  // publish: both add the same title).
  const trials = [];
  try {
    for (let i = 1; i <= ctx.args.reps; i += 1) {
      const label = `T-VERSION-2/trial-${i}`;
      const kind = i % 2 === 1 ? 'fresh' : 'none';
      const x = newRun(ctx, `v2x${i}`, 16);
      const y = newRun(ctx, `v2y${i}`, 16);
      const { snap: s, rows: [rowX, rowY], version, entries: [entryX, entryY] } = await reset(ctx, label, { version: kind, started: [x, y] });
      const px = L.buildPublish(s, { run: x.run, batch: x.batch, csvText: L.shiftedCsv(s, 1, [`LIVE-V2X${i},Live race item X${i},each,13.00`]), runRowNumber: rowX });
      const py = L.buildPublish(s, { run: y.run, batch: y.batch, csvText: L.shiftedCsv(s, -1, [`LIVE-V2Y${i},Live race item Y${i},each,14.00`]), runRowNumber: rowY });
      if (px.version.from !== version || py.version.from !== version || L.versionOf(s) !== version) {
        throw new Error(`${label}: requests planned from versions ${px.version.from}/${py.version.from}, baseline ${version}; stopping`);
      }
      if (JSON.stringify(px.body) === JSON.stringify(py.body)) throw new Error(`${label}: the two requests are identical; stopping`);
      ctx.recorder.save(label, 'request-x', px.body);
      ctx.recorder.save(label, 'request-y', py.body);
      if (ctx.hooks.beforeTrialSend) await ctx.hooks.beforeTrialSend(ctx, i);
      const replies = await sendPublishes(ctx, [
        { entry: entryX, run: x.run, batch: x.batch, runRow: rowX, plan: px.plan, body: px.body },
        { entry: entryY, run: y.run, batch: y.batch, runRow: rowY, plan: py.plan, body: py.body },
      ]);
      const final = await snapshot(ctx);
      // A later read: nothing may land after the responses.
      await ctx.transport.wait(SETTLE_MS);
      const settled = await snapshot(ctx);
      // A lost response stays unknown unless the spreadsheet's commit marker
      // establishes it; either way the trial cannot count as a pass.
      reconcileWithSheet(ctx, settled);
      const outcomes = replies.map((r) => ctx.ledger.entries.find((e) => e.id === r.entry.id));
      // Winners by established outcome: Google's 200, or a commit marker.
      const winners = outcomes.map((e, k) => (e.outcome === 'committed' ? k : -1)).filter((k) => k >= 0);
      // Judged from the replies themselves: an outcome a marker established later
      // still leaves the trial without both answers.
      const unknown = replies.some((r) => L.outcomeOfReply(r).outcome === 'unknown');
      const problems = [];
      let expected = s;
      if (winners.length > 1) problems.push('BOTH publishes committed');
      else if (winners.length === 1) expected = L.applyToSnapshot(s, [px, py][winners[0]].body).snapshot;
      problems.push(...L.diffSnapshots(expected, final).map((d) => `final: ${d}`));
      problems.push(...L.diffSnapshots(final, settled).map((d) => `changed after the responses: ${d}`));
      const loser = winners.length === 1 ? [x, y][1 - winners[0]] : null;
      if (loser && runStatus(final, loser.run.run_id) !== 'STARTED') problems.push(`the losing run's row shows ${runStatus(final, loser.run.run_id)}`);
      const dups = L.historyDuplicates(settled);
      if (dups.changes.length + dups.exceptions.length > 0) problems.push(`duplicate IDs ${JSON.stringify(dups)}`);
      if (ctx.versionRegressions.length > 0) problems.push(`version IDs went backwards: ${JSON.stringify(ctx.versionRegressions)}`);
      let verdict = 'PASS';
      if (problems.length > 0) verdict = 'FAIL';
      else if (unknown || winners.length === 0) verdict = 'INCONCLUSIVE';
      const trial = {
        trial: i,
        baseline: kind,
        baseline_version: version,
        planned_from: [px.version.from, py.version.from],
        planned_to: [px.version.to, py.version.to],
        statuses: replies.map((r) => r.status),
        outcomes: outcomes.map((e) => [e.outcome, e.basis]),
        errors: replies.map((r) => (r.body && r.body.error ? r.body.error.message : r.error)),
        date_headers: replies.map((r) => r.date),
        pair_node_ms: replies[0].node_ms,
        winner: winners.length === 1 ? ['X', 'Y'][winners[0]] : (winners.length === 0 ? 'none' : 'both'),
        http_winners: winnerOf(replies).map((k) => ['X', 'Y'][k]),
        version_after: L.versionOf(settled),
        verdict,
        problems,
      };
      trials.push(trial);
      for (const [k, v] of Object.entries({ responses: replies, final, settled, verdict: trial })) ctx.recorder.save(label, k, v);
    }
  } finally {
    ctx.recorder.save('T-VERSION-2', 'summary', { trials, solo_publish_node_ms: soloMs });
    const failed = trials.filter((r) => r.verdict === 'FAIL');
    const inconclusive = trials.filter((r) => r.verdict === 'INCONCLUSIVE');
    let verdict = 'PASS';
    if (failed.length > 0) verdict = 'FAIL';
    else if (inconclusive.length > 0 || trials.length < ctx.args.reps) verdict = 'INCONCLUSIVE';
    ctx.recorder.result('T-VERSION-2', verdict, {
      summary: [
        `${trials.length} of ${ctx.args.reps} trials ran, each from its own verified baseline; baselines ${trials.map((r) => r.baseline).join(',')}`,
        `statuses ${trials.map((r) => r.statuses.join('/')).join(', ')}; winners ${trials.map((r) => r.winner).join(',')}`,
        `pair node time ${trials.map((r) => r.pair_node_ms).join(', ')} ms; solo publishes ${soloMs.join(', ')} ms`,
      ],
      problems: trials.filter((r) => r.verdict !== 'PASS').map((r) => `trial ${r.trial} ${r.verdict}: ${r.problems.slice(0, 3).join('; ') || 'no commit, or an unknown outcome'}`),
      trials,
    });
  }
}

// ---------------------------------------------------------------------------
// recovery: T-LOST-A (applied, response lost) and T-LOST-B (never applied)
// ---------------------------------------------------------------------------

const RUN_LOG_SHEET = (snap) => snap.tabs['Run Log'].sheetId;
function dataRequests(body, runLogSheetId) {
  return body.requests.filter((r) => {
    const kind = Object.keys(r)[0];
    if (kind === 'addSheet' || kind === 'deleteSheet') return false;
    const inner = r[kind];
    return (inner.sheetId !== undefined ? inner.sheetId : inner.range.sheetId) !== runLogSheetId;
  });
}

// Runs a SheetOps workflow copy and records in the ledger what its execution
// establishes about its publish. The entry is created before the run, so a
// crash leaves it unknown.
async function runTracked(ctx, label, workflow, options) {
  const o = options || {};
  const entry = ctx.ledger.add({ kind: 'workflow', label, outcome: 'unknown', basis: 'execution started; no record yet' });
  const result = await ctx.transport.runWorkflow(workflow);
  const first = (name) => (result.outputs.get(name) || [])[0];
  const select = first('Select batch');
  const built = first('Plan and build');
  const pub = first('Publish');
  const patch = {
    run_id: select ? String(select.run.run_id) : null,
    batch_id: select && select.selection.batch ? select.selection.batch.batch_id : null,
  };
  if (!result.done) Object.assign(patch, { outcome: 'unknown', basis: 'the execution did not finish' });
  else if (!built || !built.http) Object.assign(patch, { outcome: 'not_submitted', basis: 'the execution finished without building a publish request' });
  else {
    Object.assign(patch, L.publicationFacts(built.http.body, { status: built.status }), { run_row: built.run_row.number });
    if (!pub) Object.assign(patch, { outcome: 'unknown', basis: 'a publish request was built but n8n recorded no Publish result' });
    else {
      // The whole error object: n8n may keep the code in a field other than message.
      const reply = { status: Number.isInteger(pub.statusCode) ? pub.statusCode : null, error: pub.error ? JSON.stringify(pub.error) : null };
      let outcome = L.outcomeOfReply(reply);
      // A copy whose Publish URL host is under .invalid, a name reserved never
      // to resolve (RFC 6761), cannot have reached Google if no HTTP answer came.
      if (o.unreachableHost && reply.status === null) outcome = { outcome: 'not_submitted', basis: 'the publish was addressed to sheets.googleapis.invalid, which never resolves (RFC 6761), and no HTTP answer came back' };
      Object.assign(patch, outcome, { http_status: reply.status, error: reply.error });
    }
  }
  return Object.assign(result, { entry: ctx.ledger.update(entry.id, patch) });
}

async function phaseRecovery(ctx) {
  const requests = core.buildGoogleRequests(ctx.settings);
  const [listing] = await ctx.transport.send([{ method: 'GET', url: requests.list_inbox }]);
  const files = (listing.body && listing.body.files) || [];
  const fixtureBytes = Buffer.byteLength(WEEK2_CSV);
  if (files.length !== 1 || files[0].name !== 'demo-supplier_2026-10-19.csv' || Number(files[0].size) !== fixtureBytes) {
    throw new Error(`The inbox must hold exactly demo-supplier_2026-10-19.csv (${fixtureBytes} bytes) for the recovery tests; it lists ${JSON.stringify(files.map((f) => [f.name, f.size]))}`);
  }
  const copy = (id, fault, manual) => L.workflowCopy({
    id, name: `SheetOps live ${id}`, settings: ctx.settings, credentialId: ctx.credentialId, fault: ctx.transport.kind === 'live' ? fault : null, manual,
  });
  const plain = copy('SheetOpsLivePlain', null);

  // T-LOST-B: a publish that provably never left (the host does not resolve).
  // SheetOps reports the outcome unknown, because it cannot know, and blocks
  // scheduled runs. An operator recovers with an explicit reprocess. The
  // runner allows that only because its evidence shows the original was never
  // sent.
  {
    const { snap: base } = await reset(ctx, 'T-LOST-B', { version: 'none' });
    if (ctx.transport.kind === 'dry') ctx.transport.injectPublishFault({ kind: 'BATCH_UPDATE', type: 'dns' });
    const first = await runTracked(ctx, 'T-LOST-B original', copy('SheetOpsLiveUnreachable', { unreachable: true }), { unreachableHost: ctx.transport.kind === 'live' });
    const s1 = await snapshot(ctx);
    const original = (first.outputs.get('Plan and build') || [])[0];
    const problems = [];
    const firstDone = first.done || { run_status: '(no Done: the execution did not finish)', code: '' };
    if (firstDone.code !== 'PUBLISH_OUTCOME_UNKNOWN' || firstDone.run_status !== 'STARTED') problems.push(`first run Done: ${firstDone.run_status} ${firstDone.code}`);
    if (first.order.includes('Write FAILED row')) problems.push('first run wrote FAILED');
    // Allowed: the STARTED row itself, and the grid row INSERT_ROWS adds for it.
    const changed = L.diffSnapshots(base, s1).filter((d) => !d.startsWith('"Run Log" row 2') && !d.startsWith('"Run Log".rowCount'));
    problems.push(...changed.map((d) => `first run changed more than its STARTED row: ${d}`));
    ctx.recorder.save('T-LOST-B', 'original', { done: first.done, error: first.error && first.error.message, ledger: first.entry, after: s1 });
    if (first.entry.outcome !== 'not_submitted') {
      ctx.recorder.result('T-LOST-B', 'INCONCLUSIVE', { summary: [`the evidence does not show the original was never sent: ${first.entry.outcome} (${first.entry.basis})`], problems });
      throw new Error(`PUBLICATION_UNRESOLVED at T-LOST-B: run ${first.entry.run_id} outcome ${first.entry.outcome} (${first.entry.basis}); stopping without recovery`);
    }
    const soon = await runTracked(ctx, 'T-LOST-B one minute later', plain);
    if (soon.done.action !== 'WAIT') problems.push(`a run 1 minute later did ${soon.done.action}, expected WAIT`);
    console.log(`             waiting ${Math.round(PRODUCT_ACTIVE_WINDOW_MS / 60000)} minutes: SheetOps treats a younger STARTED row as a run in progress...`);
    await ctx.transport.wait(PRODUCT_ACTIVE_WINDOW_MS);
    const scheduled = await runTracked(ctx, 'T-LOST-B scheduled run', plain);
    if (scheduled.done.action !== 'BLOCKED' || scheduled.done.code !== 'PUBLICATION_UNRESOLVED') {
      problems.push(`the scheduled run did ${scheduled.done.action} ${scheduled.done.code}, expected BLOCKED PUBLICATION_UNRESOLVED`);
    }
    if ((scheduled.outputs.get('Publish') || []).length > 0) problems.push('the scheduled run sent a publish');
    const recovery = await runTracked(ctx, 'T-LOST-B operator reprocess', copy('SheetOpsLiveReprocess', null, { target_batch_id: first.entry.batch_id }));
    const s2 = await snapshot(ctx);
    if (recovery.done.run_status !== 'SUCCESS_WITH_EXCEPTIONS') problems.push(`operator reprocess Done: ${recovery.done.run_status} ${recovery.done.code} ${recovery.done.message}`);
    const log = L.tabObjects(s2, 'Run Log').map((r) => [String(r.run_id), r.status]);
    if (log.map((r) => r[1]).join() !== 'INTERRUPTED,BLOCKED,SUCCESS_WITH_EXCEPTIONS') problems.push(`Run Log: ${JSON.stringify(log)}`);
    const row = L.tabObjects(s2, 'Run Log').find((r) => r.status === 'SUCCESS_WITH_EXCEPTIONS') || {};
    problems.push(...week2Problems(s2, row.batch_id));
    const recovered = (recovery.outputs.get('Plan and build') || [])[0];
    const sameData = Boolean(original && recovered) && JSON.stringify(dataRequests(original.http.body, RUN_LOG_SHEET(s2))) === JSON.stringify(dataRequests(recovered.http.body, RUN_LOG_SHEET(s2)));
    const sameBody = Boolean(original && recovered) && JSON.stringify(original.http.body) === JSON.stringify(recovered.http.body);
    if (!sameData) problems.push('the reprocess data writes differ from the original');
    if (sameBody) problems.push('the reprocess sent the original request unchanged');
    ctx.recorder.save('T-LOST-B', 'evidence', {
      soon: soon.done, scheduled: scheduled.done, recovery: { done: recovery.done, order: recovery.order, ledger: recovery.entry },
      original_body: original && original.http.body, recovery_body: recovered && recovered.http.body, after_recovery: s2,
    });
    ctx.recorder.result('T-LOST-B', problems.length === 0 ? 'PASS' : 'FAIL', {
      summary: [
        `original: ${firstDone.code} in SheetOps; runner evidence: ${first.entry.basis}`,
        `+1 min: ${soon.done.action}; +16 min scheduled: ${scheduled.done.action} ${scheduled.done.code}; operator reprocess: ${recovery.done.run_status}; Run Log ${JSON.stringify(log)}`,
        `reprocess data writes equal the original's: ${sameData}; a new request, not a resend: ${!sameBody}`,
      ],
      problems,
    });
  }

  // T-LOST-A: the publish times out on our side after Google received it.
  // Only evidence settles each attempt. An attempt whose outcome stays unknown
  // stops the phase: no reset, no retry.
  const observations = [];
  let lostA = null;
  for (const timeoutMs of [400, 250, 600, 150, 900, 100]) {
    await reset(ctx, 'T-LOST-A', { version: 'none' });
    if (ctx.transport.kind === 'dry') ctx.transport.injectPublishFault({ kind: 'BATCH_UPDATE', type: 'apply_then_timeout' });
    const run = await runTracked(ctx, `T-LOST-A ${timeoutMs} ms`, copy('SheetOpsLiveShortTimeout', { timeoutMs }));
    const after = await snapshot(ctx);
    const answered = run.entry.outcome !== 'unknown';
    reconcileWithSheet(ctx, after);
    const entry = ctx.ledger.entries.find((e) => e.id === run.entry.id);
    const obs = {
      timeout_ms: timeoutMs, answered, outcome: entry.outcome, basis: entry.basis, done: run.done,
      write_failed_ran: run.order.includes('Write FAILED row'),
      run_log: L.tabObjects(after, 'Run Log').map((r) => [r.run_id, r.status, r.error_code]),
    };
    observations.push(obs);
    ctx.recorder.save('T-LOST-A', `attempt-${timeoutMs}ms`, Object.assign({ after, ledger: entry }, obs));
    if (!answered && entry.outcome === 'committed') { lostA = { obs, after }; break; }
    if (entry.outcome === 'unknown') {
      ctx.recorder.result('T-LOST-A', 'INCONCLUSIVE', { summary: observations.map((o) => `${o.timeout_ms} ms: ${o.outcome} (${o.basis})`) });
      throw new Error(`PUBLICATION_UNRESOLVED at T-LOST-A: run ${entry.run_id} outcome unknown (${entry.basis}); stopping without reset or retry. Run reconcile`);
    }
  }
  if (!lostA) {
    ctx.recorder.result('T-LOST-A', 'INCONCLUSIVE', {
      summary: ['no attempt produced "applied, but response lost"'].concat(observations.map((o) => `${o.timeout_ms} ms: ${o.outcome} (${o.basis})`)),
    });
    return;
  }
  const problems = [];
  const { obs, after } = lostA;
  if (obs.done.run_status !== 'SUCCESS_WITH_EXCEPTIONS' || obs.done.code !== '') problems.push(`Done: ${obs.done.run_status} ${obs.done.code}`);
  if (obs.write_failed_ran) problems.push('Write FAILED row ran');
  const row = L.tabObjects(after, 'Run Log')[0] || {};
  problems.push(...week2Problems(after, row.batch_id), ...runRowProblems(row));
  const next = await runTracked(ctx, 'T-LOST-A next run', plain);
  const afterNext = await snapshot(ctx);
  if (next.done.action !== 'IDLE') problems.push(`the next run did ${next.done.action}, expected IDLE`);
  if ((next.outputs.get('Publish') || []).length > 0) problems.push('the next run sent a publish');
  problems.push(...L.diffSnapshots(after, afterNext).map((d) => `next run changed: ${d}`));
  ctx.recorder.save('T-LOST-A', 'next-run', { done: next.done, order: next.order });
  ctx.recorder.result('T-LOST-A', problems.length === 0 ? 'PASS' : 'FAIL', {
    summary: [`timeout ${obs.timeout_ms} ms: no answer, committed by ${obs.basis}; Done ${obs.done.run_status}; next run ${next.done.action}, no publish sent`],
    problems,
  });
}

// ---------------------------------------------------------------------------
// reconcile: read-only. Shows what the evidence establishes about every
// unresolved publication, and records explicit operator declarations.
// ---------------------------------------------------------------------------

async function phaseReconcile(ctx) {
  const snap = await snapshot(ctx);
  const before = ctx.ledger.forSheet().filter((e) => e.outcome === 'unknown').map((e) => e.id);
  const open = reconcileWithSheet(ctx, snap);
  const settled = before.filter((id) => !open.some((o) => o.entry.id === id)).map((id) => ctx.ledger.entries.find((e) => e.id === id));
  const unrecorded = () => L.tabObjects(snap, 'Run Log').filter((r) => r.status === 'STARTED' && !ctx.ledger.byRun(String(r.run_id)));
  const refuse = (why) => { throw new Error(`Declaration refused (nothing was recorded or written): ${why}`); };
  for (const spec of ctx.args.declare) {
    const match = /^(.*):not-applied$/.exec(spec);
    if (!match) refuse(`"${spec}" must be <entry id>:not-applied or run:<run id>:not-applied`);
    if (ctx.args.reason.trim().length < 10) refuse('a --reason of at least 10 characters, naming the evidence inspected, is required');
    let entry;
    if (match[1].startsWith('run:')) {
      const runId = match[1].slice(4);
      const row = unrecorded().find((r) => String(r.run_id) === runId);
      if (!row) refuse(`run ${runId} has no STARTED row without a ledger record`);
      entry = ctx.ledger.add({ kind: 'external', label: `run ${runId}, not sent by this runner`, run_id: runId, batch_id: String(row.batch_id), outcome: 'unknown', basis: 'a STARTED row with no ledger record' });
    } else {
      entry = ctx.ledger.forSheet().find((e) => e.id === match[1]);
      if (!entry) refuse(`no ledger entry ${match[1]}`);
    }
    if (entry.outcome !== 'unknown') refuse(`${entry.id} is already established as ${entry.outcome} (${entry.basis})`);
    let evidence = 'a reset: its intended baseline is not in the spreadsheet';
    if (entry.kind !== 'reset') {
      const ev = L.markerEvidence(snap, entry);
      if (ev.state !== 'no_marker') refuse(`${entry.id}: the spreadsheet does not support "not applied": ${ev.text}`);
      evidence = ev.text;
    }
    // The outcome stays unknown; the declaration is recorded beside it.
    ctx.ledger.update(entry.id, { operator: { declared: 'not-applied', reason: ctx.args.reason.trim(), at: ctx.transport.now(), evidence } });
  }
  const listing = ctx.ledger.forSheet().filter((e) => e.outcome === 'unknown').map((e) => {
    const ev = e.kind !== 'reset' && e.run_id ? L.markerEvidence(snap, e) : null;
    return {
      id: e.id, kind: e.kind, label: e.label, run_id: e.run_id, batch_id: e.batch_id, planned_from: e.planned_from, planned_to: e.planned_to,
      basis: e.basis, spreadsheet_shows: ev ? ev.text : 'see the intended baseline recorded in the ledger', operator: e.operator,
    };
  });
  const stillUnrecorded = unrecorded();
  ctx.recorder.save('RECONCILE', 'evidence', { snapshot: snap, settled_by_evidence: settled, unresolved: listing, unrecorded_started_rows: stillUnrecorded });
  const blocking = listing.filter((l) => !l.operator).length + stillUnrecorded.length;
  ctx.recorder.result('RECONCILE', blocking === 0 ? 'RESOLVED' : 'UNRESOLVED', {
    summary: [
      `settled by spreadsheet evidence: ${settled.map((e) => `${e.id} ${e.outcome} (${e.basis})`).join('; ') || 'none'}`,
      `unknown: ${listing.map((l) => `${l.id} run ${l.run_id}: ${l.spreadsheet_shows}${l.operator ? ` [operator declared not applied: "${l.operator.reason}"]` : ''}`).join('; ') || 'none'}`,
      `STARTED rows with no record: ${stillUnrecorded.map((r) => r.run_id).join(', ') || 'none'}`,
    ],
    settled,
    unresolved: listing,
    unrecorded: stillUnrecorded.map((r) => String(r.run_id)),
  });
}

// ---------------------------------------------------------------------------

async function main(argv, hooks) {
  const args = parseArgs(argv);
  const ctx = makeContext(args, hooks || {});
  console.log(`SheetOps live tests (${ctx.transport.kind}${args.broken ? ', Google sheet checks OFF' : ''}): evidence in ${path.relative(L.ROOT, ctx.recorder.dir)}`);
  const phases = args.phase === 'all' ? ['check', 'harness', 'recovery'] : [args.phase];
  for (const phase of phases) {
    try {
      await { check: phaseCheck, harness: phaseHarness, recovery: phaseRecovery, reconcile: phaseReconcile }[phase](ctx);
    } catch (err) {
      ctx.recorder.result(`phase ${phase}`, 'ERROR', { problems: [err.message] });
      break;
    }
  }
  const declared = ctx.ledger.forSheet().filter((e) => e.outcome === 'unknown' && e.operator);
  const report = ctx.recorder.finish({
    transport: ctx.transport.kind, broken_google: args.broken, phases, settings: ctx.settings, evidence_dir: ctx.recorder.dir,
    ledger_file: ctx.ledger.file,
    unresolved: ctx.ledger.forSheet().filter((e) => e.outcome === 'unknown' && !e.operator).map((e) => ({ id: e.id, label: e.label, run_id: e.run_id, basis: e.basis })),
    operator_declarations: declared.map((e) => ({ id: e.id, label: e.label, run_id: e.run_id, declaration: e.operator })),
  });
  if (declared.length > 0) console.log(`\nOperator-declared outcomes (unverified by evidence): ${declared.map((e) => e.id).join(', ')}`);
  const bad = report.results.filter((r) => ['FAIL', 'ERROR', 'UNRESOLVED'].includes(r.verdict));
  const versionFailed = report.results.some((r) => r.id.startsWith('T-VERSION') && r.verdict !== 'PASS' && r.verdict !== 'PASS*');
  if (versionFailed) console.log('\nVERSION CHECK NOT CONFIRMED: keep auto_recover_uncertain off (contract §2); every uncertain publication needs an operator.');
  console.log(bad.length === 0 ? '\nNo failures.' : `\n${bad.length} failure(s).`);
  report.ok = bad.length === 0;
  return report;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((report) => { process.exitCode = report.ok ? 0 : 1; })
    .catch((err) => { console.error(err.stack || err.message); process.exitCode = 2; });
}

module.exports = { main, parseArgs };
