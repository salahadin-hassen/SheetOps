'use strict';

// The live-test harness itself (scripts/live/), run offline against the fake
// Google and the n8n simulator. It must pass every test on a well-behaved
// Google, and must fail the version tests on a Google that ignores the sheet
// checks the version guard relies on. SIMULATED: no network.

const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../scripts/live/run-live-tests.js');
const L = require('../scripts/live/lib.js');
const core = require('../src/sheetops-core.js');
const { FakeGoogle } = require('./support/fake-google.js');
const { runWorkflow } = require('./support/n8n-sim.js');
const { week2 } = require('./support/helpers.js');

// Evidence goes to a temporary folder: these tests never touch var/.
const EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetops-harness-'));
test.after(() => fs.rmSync(EVIDENCE_ROOT, { recursive: true, force: true }));

async function quietly(argv, hooks) {
  const log = console.log;
  console.log = () => {};
  try {
    return await main(argv.concat(`--evidence-root=${EVIDENCE_ROOT}`), hooks);
  } finally {
    console.log = log;
  }
}

async function dryReport(argv, hooks) {
  const report = await quietly(argv, hooks);
  const evidence = report.evidence_dir;
  const read = (file) => JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8'));
  return Object.assign(report, { read, cleanup: () => fs.rmSync(evidence, { recursive: true, force: true }) });
}

const errorOf = (report) => report.results.find((r) => r.verdict === 'ERROR');
// Only resets rewrite row index 0 of Catalog (sheet ID 0 in the dry fake).
const isReset = (r) => Boolean(r.body && r.body.requests && r.body.requests.some((q) => q.updateCells && q.updateCells.range.sheetId === 0 && q.updateCells.range.startRowIndex === 0));
const isPair = (requests) => requests.length === 2 && requests.every((r) => r.method === 'POST' && r.url.endsWith(':batchUpdate'));
const writes = (google) => google.log.filter((e) => e.method !== 'GET');

const verdicts = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.verdict]));

test('dry run: every live test passes against a Google that behaves as documented', async () => {
  const report = await quietly(['all', '--dry-run', '--reps=2']);
  fs.rmSync(report.evidence_dir, { recursive: true, force: true });
  assert.deepEqual(verdicts(report), {
    'T-UI': 'SKIPPED', 'T-LIVE-1': 'PASS', 'T-ATOM-1': 'PASS', 'T-ATOM-2': 'PASS', 'T-SEC-1': 'PASS',
    'T-VERSION-1': 'PASS', 'T-VERSION-2': 'PASS', 'T-LOST-A': 'PASS', 'T-LOST-B': 'PASS',
  });
});

test('dry run against a Google that ignores sheet checks: the version tests fail', async () => {
  const report = await quietly(['harness', '--broken-google', '--reps=2']);
  fs.rmSync(report.evidence_dir, { recursive: true, force: true });
  const v = verdicts(report);
  assert.deepEqual([v['T-VERSION-1'], v['T-VERSION-2']], ['FAIL', 'FAIL']);
  assert.equal(report.ok, false);
});

test('saved evidence never contains anything shaped like a token or key', () => {
  const sample = 'token ya29.a0AfB_byC-example and Bearer abcdefghijklmnopqrstuvwxyz012345 "private_key": "-----BEGIN PRIVATE KEY-----\\nMII\\n-----END PRIVATE KEY-----\\n"';
  const { text, found } = L.redact(sample);
  assert.ok(found >= 3);
  assert.doesNotMatch(text, /ya29\.|Bearer [a-z]{10}|BEGIN PRIVATE KEY/);
});

// ---------------------------------------------------------------------------
// Spreadsheet states (scripts/live/lib.js classifySpreadsheet)
// ---------------------------------------------------------------------------

const w = week2();
const BUSINESS = [['Catalog', core.CATALOG_COLUMNS, 0], ['Review', core.REVIEW_COLUMNS, 101], ['Changes', core.CHANGES_COLUMNS, 102], ['Exceptions', core.EXCEPTIONS_COLUMNS, 103], ['Run Log', core.RUNLOG_COLUMNS, 104]];

function syntheticGoogle(options) {
  const o = options || {};
  const google = new FakeGoogle({ spreadsheetId: 'SYNTH_SHEET_1234567890', folderId: 'SYNTH_FOLDER_123456', title: o.title });
  for (const [title, columns, sheetId] of BUSINESS) {
    if (o.skip === title) continue;
    google.addTab(title, Array.from(columns), { sheetId });
  }
  return google;
}
const addVersionTab = (google, props) => {
  const p = Object.assign({ sheetId: core.VERSION_BASE + 500, hidden: true, rowCount: 1, columnCount: 1 }, props);
  google.tabs.set(p.title || core.VERSION_TAB, { sheetId: p.sheetId, hidden: p.hidden, rowCount: p.rowCount, columnCount: p.columnCount, rows: p.rows || [] });
  return google;
};
const classify = (google) => L.classifySpreadsheet(L.snapshotOfFake(google));
const refused = (google, pattern) => assert.throws(() => classify(google), pattern);

test('accepted state 1, uninitialized: exactly the five business tabs, no version tab', () => {
  assert.deepEqual(classify(syntheticGoogle()), { state: 'uninitialized', version: null });
});

test('accepted state 2, initialized: the five business tabs plus a hidden, empty 1x1 version tab with a SheetOps ID', () => {
  assert.deepEqual(classify(addVersionTab(syntheticGoogle())), { state: 'initialized', version: core.VERSION_BASE + 500 });
});

test('a missing business tab, an extra tab or a non-synthetic title is refused', () => {
  refused(syntheticGoogle({ skip: 'Review' }), /missing business tab "Review"/);
  const extra = syntheticGoogle();
  extra.addTab('Sheet1', [], { sheetId: 7 });
  refused(extra, /unexpected tab "Sheet1"/);
  refused(syntheticGoogle({ title: 'Shop prices 2026' }), /does not contain "synthetic"/);
  const hidden = syntheticGoogle();
  hidden.tabs.get('Changes').hidden = true;
  refused(hidden, /business tab "Changes" is hidden/);
  const header = syntheticGoogle();
  header.tabs.get('Review').rows[0][0] = 'id';
  refused(header, /"Review" header differs/);
  const shared = syntheticGoogle();
  shared.tabs.get('Review').sheetId = 0;
  refused(shared, /share sheet ID 0/);
});

test('a version tab that is misnamed or not as SheetOps creates it is refused', () => {
  for (const title of ['_SheetOps_Version', 'sheetops version', '_sheetops_version ']) {
    refused(addVersionTab(syntheticGoogle(), { title }), /incorrectly named version tab/);
  }
  refused(addVersionTab(syntheticGoogle(), { hidden: false }), /is not hidden/);
  refused(addVersionTab(syntheticGoogle(), { rowCount: 1000, columnCount: 26 }), /is 1000x26, not 1x1/);
  refused(addVersionTab(syntheticGoogle(), { rows: [['typed']] }), /holds values/);
  for (const sheetId of [12345, core.VERSION_BASE, core.VERSION_MAX]) {
    refused(addVersionTab(syntheticGoogle(), { sheetId }), /outside the range SheetOps creates/);
  }
});

test('a missing version tab where the baseline must be initialized is reported', () => {
  const intended = { state: 'initialized', version: core.VERSION_BASE + 9, sheetIds: { Catalog: 0, Review: 101, Changes: 102, Exceptions: 103, 'Run Log': 104 }, rows: {} };
  for (const [title, columns] of BUSINESS) intended.rows[title] = [Array.from(columns).map((c) => ({ s: c }))];
  assert.deepEqual(L.baselineProblems(L.snapshotOfFake(syntheticGoogle()), intended),
    ['state is uninitialized, expected initialized', `version is null, expected ${core.VERSION_BASE + 9}`]);
});

test('the accepted version tab is exactly what a publish creates', () => {
  const { buildPublish, sheetInputs } = L;
  const google = syntheticGoogle();
  const snap = L.snapshotOfFake(google);
  const run = L.testRun('shape-1', '2026-11-02T07:00:00.000Z', 'demo-supplier_2026-11-02.csv', 'shape-file-1');
  const { body } = buildPublish(snap, { run: run.run, batch: run.batch, csvText: 'sku,name,unit,unit_price\nA-1,Rice,kg,10\n', runRowNumber: 2 });
  assert.ok(sheetInputs(snap));
  const props = body.requests[0].addSheet.properties;
  assert.deepEqual([props.title, props.hidden, props.gridProperties], [core.VERSION_TAB, L.VERSION_TAB_SHAPE.hidden, { rowCount: L.VERSION_TAB_SHAPE.rowCount, columnCount: L.VERSION_TAB_SHAPE.columnCount }]);
});

test('an initialization run leaves a state the next validation accepts, and so does every later run', () => {
  const google = syntheticGoogle();
  for (const row of w.catalogBefore) google.tabs.get('Catalog').rows.push(core.rowToValues(core.CATALOG_COLUMNS, row));
  google.addFile(Object.assign({ content: w.csvText }, { id: 'synthWeek2File', name: w.file.name, modifiedTime: w.file.modifiedTime, createdTime: w.file.createdTime }));
  assert.equal(classify(google).state, 'uninitialized');
  const settings = { spreadsheet_id: google.spreadsheetId, inbox_folder_id: google.folderId, supplier: 'demo-supplier', currency: 'ETB' };
  const workflow = L.workflowCopy({ id: 'InitRun', name: 'init', settings });
  const run = (now, id) => runWorkflow(workflow, { google, now, executionId: id, trigger: 'Run manually' }).outputs.get('Done')[0].json;

  // The first publish initializes: hidden 1x1 tab, ID from the core's rule.
  // Hand-calculated: 2026-10-19T07:00Z is 25,167,600 s after 2026-01-01.
  assert.equal(run('2026-10-19T07:00:00.000Z', '1').run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(classify(google), { state: 'initialized', version: core.VERSION_BASE + 25167600 });
  // An idle run publishes nothing; the state stays valid and unchanged.
  assert.equal(run('2026-10-19T09:00:00.000Z', '2').action, 'IDLE');
  assert.deepEqual(classify(google), { state: 'initialized', version: core.VERSION_BASE + 25167600 });
  // The next publish replaces the tab with a higher ID; still valid.
  google.addFile({ id: 'synthWeek3File', name: 'demo-supplier_2026-10-26.csv', modifiedTime: '2026-10-26T06:00:00.000Z', createdTime: '2026-10-26T05:58:00.000Z', content: w.csvText });
  assert.equal(run('2026-10-26T07:00:00.000Z', '3').run_status, 'SUCCESS_WITH_EXCEPTIONS');
  const after = classify(google);
  assert.equal(after.state, 'initialized');
  assert.ok(after.version > core.VERSION_BASE + 25167600);
});

// ---------------------------------------------------------------------------
// Baselines and concurrency trials (scripts/live/run-live-tests.js), dry
// ---------------------------------------------------------------------------

test('an invalid target is refused before any write', async () => {
  for (const setupGoogle of [(g) => { g.title = 'Shop prices 2026'; }, (g) => g.addTab('Budget', [], { sheetId: 9 })]) {
    let google;
    const report = await dryReport(['harness', '--dry-run'], { setupGoogle: (g) => { google = g; setupGoogle(g); } });
    report.cleanup();
    assert.match(errorOf(report).details.problems[0], /Refusing to touch this spreadsheet/);
    assert.deepEqual(writes(google), [], 'nothing but reads was sent');
  }
});

test('a running n8n process stops the suite before any write', async () => {
  let google;
  const report = await dryReport(['harness', '--dry-run'], {
    setupGoogle: (g) => { google = g; },
    transport: { activeN8n: () => ['4242 node /usr/bin/n8n start'] },
  });
  report.cleanup();
  assert.match(errorOf(report).details.problems[0], /n8n is running/);
  assert.deepEqual(writes(google), []);
});

test('every trial resets to its own baseline, reads it back, and plans both requests from that version', async () => {
  const report = await dryReport(['harness', '--dry-run', '--reps=4']);
  try {
    const result = report.results.find((r) => r.id === 'T-VERSION-2');
    assert.equal(result.verdict, 'PASS');
    const trials = result.details.trials;
    assert.deepEqual(trials.map((t) => t.baseline), ['fresh', 'none', 'fresh', 'none']);
    let lastFresh = 0;
    for (const trial of trials) {
      const check = report.read(`T-VERSION-2/trial-${trial.trial}/baseline-readback.json`);
      assert.deepEqual(check.problems, [], `trial ${trial.trial} readback`);
      assert.equal(check.readback.classification.state, trial.baseline === 'fresh' ? 'initialized' : 'uninitialized');
      assert.deepEqual(trial.planned_from, [trial.baseline_version, trial.baseline_version], `trial ${trial.trial} planned from its baseline`);
      if (trial.baseline === 'fresh') {
        assert.ok(trial.baseline_version > lastFresh, 'fresh versions only grow');
        lastFresh = trial.baseline_version;
      } else {
        assert.equal(trial.baseline_version, null);
      }
      // Run Log at the baseline: exactly the trial's two STARTED rows.
      const runLog = check.readback.tabs['Run Log'].rows.slice(1).map((row) => [row[0].s, row[2].s]);
      assert.deepEqual(runLog, [[`live-v2x${trial.trial}-${runLog[0][0].split('-').pop()}`, 'STARTED'], [runLog[1][0], 'STARTED']]);
    }
  } finally {
    report.cleanup();
  }
});

test('a contaminated baseline is detected, and no competing requests are sent for that trial', async () => {
  const sent = [];
  const report = await dryReport(['harness', '--dry-run', '--reps=4'], {
    afterResetWrite: (ctx, label) => {
      // Someone types into Catalog right after trial 2's reset.
      if (label === 'T-VERSION-2/trial-2') ctx.transport.google.tabs.get('Catalog').rows[3][3] = 999;
    },
    beforeTrialSend: (ctx, i) => { sent.push(i); },
  });
  report.cleanup();
  assert.match(errorOf(report).details.problems[0], /Baseline for T-VERSION-2\/trial-2 not confirmed by readback: "Catalog" row 4/);
  assert.deepEqual(sent, [1], 'trial 2 never sent its requests; trials 3 and 4 never ran');
  assert.equal(report.results.find((r) => r.id === 'T-VERSION-2').verdict, 'INCONCLUSIVE');
});

test('a failed reset stops the suite before the trial and every later phase', async () => {
  let resets = 0;
  const sent = [];
  const report = await dryReport(['all', '--dry-run', '--reps=4'], {
    transport: {
      beforeSend: (requests, google) => {
        // The fifth reset is trial 3's (T-ATOM, T-VERSION-1, trials 1 and 2 come first).
        if (requests.some(isReset) && ++resets === 5) google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 500, body: 'Internal error' });
      },
    },
    beforeTrialSend: (ctx, i) => { sent.push(i); },
  });
  report.cleanup();
  assert.match(errorOf(report).details.problems[0], /Reset for T-VERSION-2\/trial-3 failed: HTTP 500/);
  assert.deepEqual(sent, [1, 2]);
  assert.ok(!report.results.some((r) => r.id.startsWith('T-LOST')), 'the recovery phase did not run');
  assert.equal(report.ok, false);
});

test('an earlier write with an unknown outcome blocks the next trial', async () => {
  const report = await dryReport(['harness', '--dry-run', '--reps=4'], {
    // Trial 1's first request is lost in transit: it might still land.
    beforeTrialSend: (ctx, i) => { if (i === 1) ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'timeout' }); },
  });
  report.cleanup();
  const v2 = report.results.find((r) => r.id === 'T-VERSION-2');
  assert.equal(v2.verdict, 'INCONCLUSIVE');
  assert.deepEqual(v2.details.trials.map((t) => [t.trial, t.verdict, t.statuses]), [[1, 'INCONCLUSIVE', [null, 200]]]);
  assert.match(errorOf(report).details.problems[0], /^PUBLICATION_UNRESOLVED at T-VERSION-2\/trial-2: P\d+ T-VERSION-2\/trial-1 run live-v2x1-\d+: outcome unknown \(no answer from Google \(timeout of 20000ms exceeded\)\); its row still shows STARTED/);
});

test('an unsettled STARTED row from another run blocks the next trial', async () => {
  const report = await dryReport(['harness', '--dry-run', '--reps=4'], {
    transport: {
      afterSend: (requests, replies, google) => {
        if (!isPair(requests) || google.tabs.get('Run Log').rows.some((row) => row[0] === 'exec-777')) return;
        // A SheetOps execution started meanwhile (its row is fresh).
        const row = Object.assign(core.buildStartedRow({ run_id: 'exec-777', mode: 'manual', started_at: '2026-11-02T07:05:00.000Z' }, core.describeSourceFile({ id: 'drvOther', name: 'demo-supplier_2026-10-19.csv', modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T06:00:00.000Z' }, {})));
        google.tabs.get('Run Log').rows.push(core.rowToValues(core.RUNLOG_COLUMNS, row));
      },
    },
  });
  report.cleanup();
  assert.match(errorOf(report).details.problems[0], /run exec-777 \(drvOther@2026-10-19T06:00:00\.000Z\) is STARTED and the ledger has no record of its publish; whatever its age, its outcome is unknown/);
});

test('a fresh baseline version is above every ID seen and the clock rule, and is never an ID in use', () => {
  const snap = L.snapshotOfFake(addVersionTab(syntheticGoogle(), { sheetId: core.VERSION_BASE + 700 }));
  const build = (minVersion, now) => L.resetRequest(snap, { spreadsheetId: 'SYNTH_SHEET_1234567890', catalogRows: [], startedRows: [], version: 'fresh', now, minVersion });
  // Clock rule: 2026-01-01T00:16:40Z is 1,000 s after the epoch, above the current +700, so the clock value wins.
  assert.equal(build(0, '2026-01-01T00:16:40.000Z').intended.version, core.VERSION_BASE + 1000);
  // A high-water mark above the clock wins.
  assert.equal(build(core.VERSION_BASE + 5000, '2026-01-01T00:16:40.000Z').intended.version, core.VERSION_BASE + 5001);
  // The current version tab is always deleted first (the reset is fenced on it).
  assert.deepEqual(build(0, '2026-01-01T00:16:40.000Z').request.body.requests[0], { deleteSheet: { sheetId: core.VERSION_BASE + 700 } });
  // The reset itself refuses an invalid target.
  assert.throws(() => L.resetRequest(Object.assign({}, snap, { title: 'Shop prices' }), { spreadsheetId: 'x', version: 'none' }), /does not contain "synthetic"/);
});

// ---------------------------------------------------------------------------
// Unresolved STARTED rows: only evidence settles a publication, never age
// ---------------------------------------------------------------------------

const DRY_START = '2026-11-02T07:00:00.000Z';
const minutesBefore = (minutes) => new Date(Date.parse(DRY_START) - minutes * 60000).toISOString();
const AGES = [1, 20, 180, 3 * 24 * 60];
const otherBatch = core.describeSourceFile({ id: 'drvOld', name: 'demo-supplier_2026-10-12.csv', modifiedTime: '2026-10-12T06:00:00.000Z', createdTime: '2026-10-12T06:00:00.000Z' }, {});

function ledgerWith(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetops-ledger-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify({ entries: entries.map((e, i) => Object.assign({
    id: `P${String(i + 1).padStart(4, '0')}`, spreadsheet_id: 'SYNTH_SHEET_1234567890', kind: 'publish', label: `earlier ${e.run_id}`,
    run_row: null, batch_id: otherBatch.batch_id, expected_status: 'SUCCESS', planned_from: null, planned_to: null,
    operator: null, history: [], created_at: minutesBefore(5),
  }, e)) }));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function startedRow(google, runId, startedAt) {
  const row = core.buildStartedRow({ run_id: runId, mode: 'manual', started_at: startedAt }, otherBatch);
  google.tabs.get('Run Log').rows.push(core.rowToValues(core.RUNLOG_COLUMNS, row));
}

test('known not submitted: an earlier STARTED row the ledger records as never sent lets the suite proceed, whatever its age', async () => {
  for (const minutes of AGES) {
    const ledger = ledgerWith([{ run_id: 'live-old-1', outcome: 'not_submitted', basis: 'its STARTED row is written by a reset; its publish has not been sent' }]);
    let google;
    const report = await dryReport(['harness', '--dry-run', '--reps=1'], {
      ledgerFile: ledger.file, setupGoogle: (g) => { google = g; startedRow(g, 'live-old-1', minutesBefore(minutes)); },
    });
    report.cleanup();
    ledger.cleanup();
    assert.equal(errorOf(report), undefined, `${minutes} min: no error`);
    assert.equal(report.results.find((r) => r.id === 'T-ATOM-1').verdict, 'PASS', `${minutes} min`);
    assert.ok(writes(google).length > 0);
  }
});

test('CRITICAL: a STARTED row whose publish may have been sent blocks everything, whatever its age; nothing is written', async () => {
  const variants = [
    ['no ledger record at all', () => []],
    ['a publish sent with no answer recorded', (at) => [{ run_id: 'live-old-1', outcome: 'unknown', basis: 'sent; no answer recorded yet', created_at: at }]],
    ['an answer that does not establish the outcome (HTTP 503)', (at) => [{ run_id: 'live-old-1', outcome: 'unknown', basis: 'Google answered HTTP 503, which does not establish the outcome', created_at: at }]],
  ];
  for (const [label, entries] of variants) {
    for (const minutes of AGES) {
      const ledger = ledgerWith(entries(minutesBefore(minutes)));
      let google;
      // Both phases that write: the harness and the recovery tests.
      for (const [phase, first] of [['harness', 'T-ATOM'], ['recovery', 'T-LOST-B']]) {
        const report = await dryReport([phase, '--dry-run', '--reps=1'], {
          ledgerFile: ledger.file, setupGoogle: (g) => { google = g; startedRow(g, 'live-old-1', minutesBefore(minutes)); },
        });
        report.cleanup();
        const error = errorOf(report);
        assert.ok(error, `${phase}, ${label}, ${minutes} min: refused`);
        assert.match(error.details.problems[0], new RegExp(`^PUBLICATION_UNRESOLVED at ${first}: .*live-old-1.*Nothing was written`), `${phase}, ${label}, ${minutes} min`);
        assert.deepEqual(writes(google), [], `${phase}, ${label}, ${minutes} min: no reset, no publish, no workflow run`);
        assert.equal(report.results.filter((r) => /^T-/.test(r.id) && r.verdict !== 'SKIPPED').length, 0, 'no test ran');
      }
      ledger.cleanup();
    }
  }
});

test('a lost response after the publication applied is established as committed by its marker, and never republished', async () => {
  const sent = [];
  const report = await dryReport(['harness', '--dry-run', '--reps=4'], {
    beforeTrialSend: (ctx, i) => { sent.push(i); if (i === 1) ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'apply_then_timeout' }); },
  });
  try {
    const v2 = report.results.find((r) => r.id === 'T-VERSION-2');
    const first = v2.details.trials[0];
    assert.deepEqual([first.verdict, first.statuses, first.winner, first.http_winners], ['INCONCLUSIVE', [null, 400], 'X', []]);
    assert.equal(first.outcomes[0][0], 'committed');
    assert.match(first.outcomes[0][1], /^commit marker: its row shows SUCCESS for .*and the version tab is \d+, the one it creates$/);
    assert.deepEqual(first.outcomes[1], ['rejected', 'Google answered HTTP 400']);
    assert.deepEqual(sent, [1, 2, 3, 4], 'once established, the next trials ran');
    assert.equal(first.problems.length, 0, 'final state is exactly the committed publication; no duplicate IDs');
    assert.equal(v2.verdict, 'INCONCLUSIVE', 'a lost response never counts as a pass');
  } finally {
    report.cleanup();
  }
});

test('a definitive rejection is settled by HTTP 4xx; a 5xx is not, and stops the next trial', async () => {
  const normal = await dryReport(['harness', '--dry-run', '--reps=2']);
  normal.cleanup();
  for (const trial of normal.results.find((r) => r.id === 'T-VERSION-2').details.trials) {
    assert.deepEqual(trial.outcomes.map((o) => o[0]), ['committed', 'rejected']);
  }
  const sent = [];
  const report = await dryReport(['harness', '--dry-run', '--reps=3'], {
    beforeTrialSend: (ctx, i) => { sent.push(i); if (i === 1) ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' }); },
  });
  report.cleanup();
  assert.deepEqual(sent, [1]);
  assert.match(errorOf(report).details.problems[0], /outcome unknown \(Google answered HTTP 503, which does not establish the outcome\); its row still shows STARTED/);
});

test('an unknown publication whose marker cannot be read, or whose spreadsheet cannot be read, blocks before any write', async () => {
  const gone = ledgerWith([{ run_id: 'live-gone-1', outcome: 'unknown', basis: 'sent; no answer recorded yet' }]);
  let google;
  let report = await dryReport(['harness', '--dry-run'], { ledgerFile: gone.file, setupGoogle: (g) => { google = g; } });
  report.cleanup();
  gone.cleanup();
  assert.match(errorOf(report).details.problems[0], /live-gone-1.*its Run Log row \(run live-gone-1\) is not in the spreadsheet/);
  assert.deepEqual(writes(google), []);

  report = await dryReport(['harness', '--dry-run'], {
    setupGoogle: (g) => { google = g; g.inject({ kind: 'SHEETS_META', type: 'status', status: 503, body: 'Service Unavailable' }); },
  });
  report.cleanup();
  assert.match(errorOf(report).details.problems[0], /^Snapshot read failed: HTTP 503/);
  assert.deepEqual(writes(google), []);
});

test('no newer publication is sent while an older outcome is unresolved', async () => {
  let google;
  let pairsAfterUnknown = 0;
  let unknownSeen = false;
  const report = await dryReport(['all', '--dry-run', '--reps=4'], {
    setupGoogle: (g) => { google = g; },
    transport: { afterSend: (requests, replies) => { if (unknownSeen && requests.some((r) => r.method !== 'GET')) pairsAfterUnknown += 1; if (isPair(requests) && replies.some((r) => r.status === null)) unknownSeen = true; } },
    beforeTrialSend: (ctx, i) => { if (i === 1) ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'timeout' }); },
  });
  report.cleanup();
  assert.ok(unknownSeen);
  assert.equal(pairsAfterUnknown, 0, 'not one write after the unknown outcome: no reset, no publish');
  assert.ok(!report.results.some((r) => r.id.startsWith('T-LOST')), 'the recovery phase did not run');
  assert.ok(google.log.length > 0);
});

test('reconcile establishes an already-committed publication from its marker, writes nothing, and republishes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetops-ledger-'));
  const ledgerFile = path.join(dir, 'ledger.json');
  let google;
  try {
    // A suite crashes right after trial 1's requests were sent, before it
    // recorded the answers: X applied, Y was refused, the ledger shows neither.
    const crashed = await dryReport(['harness', '--dry-run', '--reps=2'], {
      ledgerFile, setupGoogle: (g) => { google = g; },
      transport: { afterSend: (requests) => { if (isPair(requests)) throw new Error('runner crashed'); } },
    });
    crashed.cleanup();
    const changesBefore = JSON.stringify(google.tabs.get('Changes').rows);
    const writesBefore = writes(google).length;

    const reconcile = await dryReport(['reconcile', '--dry-run'], { google, ledgerFile });
    reconcile.cleanup();
    const result = reconcile.results.find((r) => r.id === 'RECONCILE');
    assert.equal(result.verdict, 'UNRESOLVED', 'Y is still unknown: its 400 was never recorded');
    assert.equal(result.details.settled.length, 1);
    assert.match(result.details.settled[0].label, /trial-1 run live-v2x1-/);
    assert.equal(result.details.settled[0].outcome, 'committed');
    assert.match(result.details.settled[0].basis, /^commit marker: its row shows SUCCESS/);
    assert.equal(writes(google).length, writesBefore, 'reconcile wrote nothing');
    assert.equal(JSON.stringify(google.tabs.get('Changes').rows), changesBefore, 'no output record duplicated');
    const changeIds = google.tabs.get('Changes').rows.slice(1).map((r) => r[0]).filter(Boolean);
    assert.equal(new Set(changeIds).size, changeIds.length);

    // A later suite still refuses to start: Y is unresolved.
    const blocked = await dryReport(['harness', '--dry-run', '--reps=1'], { google, ledgerFile });
    blocked.cleanup();
    assert.match(errorOf(blocked).details.problems[0], /^PUBLICATION_UNRESOLVED at T-ATOM: .*trial-1 run live-v2y1-/);
    assert.equal(writes(google).length, writesBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('operator declarations: refused when unsafe or ambiguous, recorded but never converted into a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetops-ledger-'));
  const ledgerFile = path.join(dir, 'ledger.json');
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries;
  let google;
  try {
    const crashed = await dryReport(['harness', '--dry-run', '--reps=2'], {
      ledgerFile, setupGoogle: (g) => { google = g; },
      transport: { afterSend: (requests) => { if (isPair(requests)) throw new Error('runner crashed'); } },
    });
    crashed.cleanup();
    const y = ledger().find((e) => /trial-1 run live-v2y1-/.test(e.label));
    const x = ledger().find((e) => /trial-1 run live-v2x1-/.test(e.label));
    const writesBefore = writes(google).length;
    const declare = async (args) => {
      const r = await dryReport(['reconcile', '--dry-run'].concat(args), { google, ledgerFile });
      r.cleanup();
      return r;
    };

    // No reason: refused.
    let r = await declare([`--declare=${y.id}:not-applied`]);
    assert.match(errorOf(r).details.problems[0], /^Declaration refused .*--reason of at least 10 characters/);
    // X is committed by its marker: "not applied" contradicts the evidence.
    r = await declare([`--declare=${x.id}:not-applied`, '--reason=checked the sheet by hand']);
    assert.match(errorOf(r).details.problems[0], /already established as committed/);
    // A row someone set to FAILED by hand is not evidence: still refused, and still blocking.
    const status = core.RUNLOG_COLUMNS.indexOf('status');
    const yRow = google.tabs.get('Run Log').rows.find((row) => row[0] === y.run_id);
    yRow[status] = 'FAILED';
    r = await declare([`--declare=${y.id}:not-applied`, '--reason=the row says FAILED']);
    assert.match(errorOf(r).details.problems[0], /does not support "not applied": its row shows FAILED/);
    const blocked = await dryReport(['harness', '--dry-run', '--reps=1'], { google, ledgerFile });
    blocked.cleanup();
    assert.match(errorOf(blocked).details.problems[0], /^PUBLICATION_UNRESOLVED at T-ATOM: .*its row shows FAILED, not the SUCCESS it would write/);
    yRow[status] = 'STARTED';
    assert.equal(writes(google).length, writesBefore, 'every refusal wrote nothing');
    assert.equal(ledger().find((e) => e.id === y.id).operator, null);

    // A reasoned declaration on a row that shows no marker is recorded, and only that.
    r = await declare([`--declare=${y.id}:not-applied`, '--reason=Y got HTTP 400 in the n8n execution record; version tab moved past its planned version']);
    assert.equal(r.results.find((res) => res.id === 'RECONCILE').verdict, 'RESOLVED');
    const declared = ledger().find((e) => e.id === y.id);
    assert.deepEqual([declared.outcome, declared.operator.declared], ['unknown', 'not-applied'], 'still unknown, with the declaration beside it');
    const resumed = await dryReport(['harness', '--dry-run', '--reps=1'], { google, ledgerFile });
    resumed.cleanup();
    assert.equal(errorOf(resumed), undefined);
    assert.deepEqual(resumed.operator_declarations.map((d) => d.id), [y.id], 'reported as an unverified operator declaration');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a SheetOps execution that dies mid-publish leaves the outcome unknown and stops the recovery tests', async () => {
  let google;
  const report = await dryReport(['recovery', '--dry-run'], {
    setupGoogle: (g) => { google = g; },
    // T-LOST-B's original publish, the next one after its reset, kills its sender.
    afterResetWrite: (ctx, label) => { if (label === 'T-LOST-B') ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'crash' }); },
  });
  const ledger = JSON.parse(fs.readFileSync(path.join(report.evidence_dir, 'ledger.json'), 'utf8')).entries;
  report.cleanup();
  const original = ledger.find((e) => e.label === 'T-LOST-B original');
  assert.deepEqual([original.outcome, original.basis], ['unknown', 'the execution did not finish']);
  assert.match(errorOf(report).details.problems[0], /^PUBLICATION_UNRESOLVED at T-LOST-B: run \S+ outcome unknown \(the execution did not finish\); stopping without recovery/);
  assert.equal(report.results.find((r) => r.id === 'T-LOST-B').verdict, 'INCONCLUSIVE');
  assert.ok(!report.results.some((r) => r.id === 'T-LOST-A'), 'no further reset or attempt');
});
