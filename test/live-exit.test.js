'use strict';

// The live runner's result reporting, tested through real process exit codes.
// Every run here is a dry run against the fake Google, with its evidence in a
// temporary folder. No network, no n8n, nothing under var/. SIMULATED.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('../scripts/live/report.js');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'live', 'run-live-tests.js');
const DRIVER = path.join(__dirname, 'support', 'live-runner-cli.js');

function runProcess(args, withRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetops-exit-'));
  try {
    const p = spawnSync(process.execPath, withRoot(args, root), { cwd: ROOT, encoding: 'utf8', timeout: 110000 });
    const folders = fs.readdirSync(root);
    const file = folders.length === 1 ? path.join(root, folders[0], 'report.json') : null;
    const report = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { code: p.status, stdout: p.stdout, stderr: p.stderr, report };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const scenario = (name) => runProcess([DRIVER, name], (args, root) => [...args, root]);
const cliRun = (...args) => runProcess([RUNNER, ...args], (a, root) => [...a, `--evidence-root=${root}`]);

// Reads the terminal summary back, to compare it with report.json.
function terminalSummary(stdout) {
  const keys = { PASSED: 'passed', FAILED: 'failed', INCONCLUSIVE: 'inconclusive', ERROR: 'errors', UNRESOLVED: 'unresolved', SKIPPED: 'skipped', MISSING: 'missing', MALFORMED: 'malformed' };
  const summary = stdout.slice(stdout.lastIndexOf('\nSummary\n'));
  const out = {};
  for (const line of summary.split('\n')) {
    const m = /^([A-Z]+)\s+(\d+)(?:\s{2}(.*))?$/.exec(line);
    if (m && keys[m[1]]) out[keys[m[1]]] = { count: Number(m[2]), items: m[3] || '' };
  }
  return out;
}

function assertAgree(run) {
  assert.ok(run.report, `report.json exists:\n${run.stdout}\n${run.stderr}`);
  const shown = terminalSummary(run.stdout);
  assert.equal(Object.keys(shown).length, 8, 'all eight lines are printed');
  for (const [key, line] of Object.entries(shown)) {
    assert.equal(line.count, run.report.summary[key].length, key);
    assert.equal(line.items, run.report.summary[key].join(', '), key);
  }
  assert.equal(run.report.ok, run.code === 0);
  assert.equal(run.report.summary.exit_code, run.code);
  assert.match(run.stdout, run.code === 0 ? /Result: ALL REQUIRED TESTS PASSED/ : /Result: NOT PASSED/);
  assert.doesNotMatch(run.stdout, /No failures/);
  const verdict = (id) => { const r = run.report.results.find((x) => x && x.id === id); return r && r.verdict; };
  for (const id of run.report.summary.inconclusive) assert.equal(verdict(id), 'INCONCLUSIVE');
  for (const id of run.report.summary.failed) assert.equal(verdict(id), 'FAIL');
}

test('all tests pass: exit 0, in a real process, and terminal and report agree', () => {
  const run = scenario('all-pass');
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assertAgree(run);
  assert.equal(run.report.summary.outcome, 'ALL_REQUIRED_PASSED');
  assert.equal(run.report.summary.scope, 'full suite');
  assert.deepEqual(run.report.summary.skipped, ['T-UI']);
  assert.match(run.stdout, /not evidence about real Google behaviour/);
});

test('one test fails: nonzero, reported as FAILED and not as inconclusive', () => {
  const run = scenario('one-fail');
  assert.equal(run.code, 1);
  assertAgree(run);
  assert.deepEqual(run.report.summary.failed, ['T-VERSION-2']);
  assert.deepEqual(run.report.summary.inconclusive, []);
});

test('one test is inconclusive: nonzero, keeps its classification and its evidence', () => {
  const run = scenario('one-inconclusive');
  assert.equal(run.code, 1);
  assertAgree(run);
  assert.deepEqual(run.report.summary.inconclusive, ['T-VERSION-2']);
  assert.deepEqual(run.report.summary.failed, []);
  assert.ok(!run.report.summary.passed.includes('T-VERSION-2'));
  const result = run.report.results.find((r) => r.id === 'T-VERSION-2');
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.deepEqual(result.details.trials, [{ trial: 1, verdict: 'INCONCLUSIVE', statuses: [null, 200] }]);
  assert.match(run.stdout, /VERSION CHECK NOT CONFIRMED/);
});

test('failed and inconclusive together: nonzero, each reported accurately', () => {
  const run = scenario('fail-and-inconclusive');
  assert.equal(run.code, 1);
  assertAgree(run);
  assert.deepEqual(run.report.summary.failed, ['T-LOST-A']);
  assert.deepEqual(run.report.summary.inconclusive, ['T-VERSION-2']);
  assert.match(run.stdout, /Result: NOT PASSED \(full suite\): 1 FAILED, 1 INCONCLUSIVE\./);
});

test('a real inconclusive trial from the real harness phase: nonzero, evidence kept in report.json', () => {
  const run = scenario('real-inconclusive');
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assertAgree(run);
  assert.deepEqual(run.report.summary.inconclusive, ['T-VERSION-2']);
  const v2 = run.report.results.find((r) => r.id === 'T-VERSION-2');
  assert.deepEqual(v2.details.trials[0].statuses, [null, 200]);
  assert.equal(run.report.unresolved.length > 0, true, 'the unknown publication is listed');
});

for (const [name, key, expected] of [
  ['missing-result', 'missing', ['T-VERSION-2']],
  ['unknown-verdict', 'malformed', ['T-VERSION-2: unknown verdict "PASS*"']],
  ['no-verdict', 'malformed', ['T-VERSION-2: unknown verdict undefined']],
  ['null-entry', 'malformed', ['result 7: no test ID']],
  ['no-id', 'malformed', ['result 7: no test ID']],
  ['duplicate-pass', 'malformed', ['T-VERSION-2: more than one result']],
  ['contradictory-duplicate', 'malformed', ['T-VERSION-2: more than one result']],
  ['unexpected-test', 'malformed', ['T-EXTRA: PASS from a test this run does not require']],
]) {
  test(`missing or malformed results cannot pass: ${name}`, () => {
    const run = scenario(name);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.ok(run.report);
    assert.equal(run.report.ok, false);
    assert.deepEqual(run.report.summary[key], expected);
    assert.match(run.stdout, /Result: NOT PASSED/);
    assert.doesNotMatch(run.stdout, /ALL REQUIRED TESTS PASSED/);
  });
}

test('a run that records nothing cannot pass', () => {
  const run = scenario('nothing-recorded');
  assert.equal(run.code, 1);
  assertAgree(run);
  assert.equal(run.report.summary.passed.length, 0);
  assert.equal(run.report.summary.missing.length, 8);
});

test('a phase that crashes: nonzero, reported as ERROR, later required tests accounted for', () => {
  const run = scenario('phase-throws');
  assert.equal(run.code, 1);
  assertAgree(run);
  assert.deepEqual(run.report.summary.errors, ['phase harness']);
  assert.deepEqual(run.report.summary.missing, ['T-VERSION-2', 'T-LOST-B', 'T-LOST-A']);
});

test('results that are not a list cannot pass', () => {
  const run = scenario('results-not-a-list');
  assert.notEqual(run.code, 0);
  assert.doesNotMatch(run.stdout, /ALL REQUIRED TESTS PASSED/);
});

test('the real command line: a full dry run exits 0 with T-UI skipped and says it is a dry run', () => {
  const run = cliRun('all', '--dry-run', '--reps=2');
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assertAgree(run);
  assert.equal(run.report.summary.passed.length, 8);
  assert.match(run.stdout, /Dry run against the fake Google/);
});

test('the real command line: Google with its checks off exits nonzero', () => {
  const run = cliRun('harness', '--broken-google', '--reps=2');
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assertAgree(run);
  assert.deepEqual(run.report.summary.failed, ['T-VERSION-1', 'T-VERSION-2']);
});

test('the real command line: a passing single phase says PARTIAL VERIFICATION', () => {
  const run = cliRun('check', '--dry-run');
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.report.summary.scope, 'partial: check only');
  assert.equal(run.report.summary.verification, 'PARTIAL');
  assert.match(run.stdout, /Result: PARTIAL VERIFICATION PASSED \(check only\)/);
  assert.doesNotMatch(run.stdout, /ALL REQUIRED TESTS PASSED/);
});

for (const reps of ['0', '-1', 'abc', '1.5', '']) {
  test(`--reps=${reps} is refused with exit 2 and no report, rather than passing with no trials`, () => {
    const run = cliRun('harness', '--dry-run', `--reps=${reps}`);
    assert.equal(run.code, 2);
    assert.equal(run.report, null);
    assert.match(run.stderr, /--reps must be a positive whole number/);
  });
}

test('--evidence-root is refused on anything but a dry run, before any live step', () => {
  const p = spawnSync(process.execPath, [RUNNER, 'check', '--evidence-root=/nonexistent'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /--evidence-root is only accepted with --dry-run/);
});

test('live rules: T-UI is required, so skipping or omitting it cannot pass', () => {
  const base = ['T-LIVE-1'].map((id) => ({ id, verdict: 'PASS' }));
  const omitted = R.assess({ results: base, phases: ['check'], transport: 'live', ledgerUnresolved: [] });
  assert.equal(omitted.exit_code, 1);
  assert.deepEqual(omitted.missing, ['T-UI']);
  const skipped = R.assess({ results: base.concat({ id: 'T-UI', verdict: 'SKIPPED' }), phases: ['check'], transport: 'live', ledgerUnresolved: [] });
  assert.equal(skipped.exit_code, 1);
  assert.deepEqual(skipped.blocking_skips, ['T-UI']);
  const all = R.assess({ results: base.concat({ id: 'T-UI', verdict: 'PASS' }), phases: ['check'], transport: 'live', ledgerUnresolved: [] });
  assert.equal(all.exit_code, 0);
});

test('an unknown publication in the ledger blocks success even if every test passed', () => {
  const results = [{ id: 'T-LIVE-1', verdict: 'PASS' }];
  const s = R.assess({ results, phases: ['check'], transport: 'dry', ledgerUnresolved: [{ id: 'P1' }] });
  assert.equal(s.exit_code, 1);
  assert.equal(s.unresolved_in_ledger, 1);
});

test('no selected phase, or a reconcile left unresolved, cannot pass', () => {
  assert.equal(R.assess({ results: [], phases: [], transport: 'dry', ledgerUnresolved: [] }).exit_code, 1);
  assert.equal(R.assess({ results: [{ id: 'RECONCILE', verdict: 'UNRESOLVED' }], phases: ['reconcile'], transport: 'dry', ledgerUnresolved: [] }).exit_code, 1);
  assert.equal(R.assess({ results: [{ id: 'RECONCILE', verdict: 'RESOLVED' }], phases: ['reconcile'], transport: 'dry', ledgerUnresolved: [] }).exit_code, 0);
});
