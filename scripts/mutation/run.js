'use strict';

// Reproducible mutation testing for SheetOps. See README.md.
//
//   node scripts/mutation/run.js [--only=ID,ID] [--out=DIR] [--timeout-ms=N]
//                                [--root=DIR] [--mutations=FILE]
//
// It copies a fixed list of project paths to a temporary directory outside the
// repository, then for each mutation copies that snapshot, changes one thing,
// runs the mutation's tests there and deletes the copy. The real tree is only
// read, and a fingerprint proves it did not change during the run.
//
// Exit codes: 0 baseline clean and every mutation KILLED; 1 anything else;
// 2 the harness could not start.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('./lib.js');

// An allowlist: frontend/, .git, node_modules, var/ and credentials are out
// because they are never named here. scripts/mutation is left out as well.
const COPY = ['package.json', 'src', 'scripts', 'test', 'fixtures', 'workflow', 'docs/data-contract.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'var', 'frontend', 'mutation']);
const SKIP_FILE = /(^\.env)|(\.key\.json$)|(service[-_]?account.*\.json$)|(credentials?.*\.json$)/i;
const BUILDER = 'workflow/build.js';

function parseArgs(argv) {
  const args = { root: path.join(__dirname, '..', '..'), out: null, only: null, timeoutMs: 180000, mutations: path.join(__dirname, 'mutations.js') };
  for (const a of argv) {
    const value = a.slice(a.indexOf('=') + 1);
    if (a.startsWith('--root=')) args.root = path.resolve(value);
    else if (a.startsWith('--out=')) args.out = path.resolve(value);
    else if (a.startsWith('--only=')) args.only = value.split(',').filter(Boolean);
    else if (a.startsWith('--mutations=')) args.mutations = path.resolve(value);
    else if (a.startsWith('--timeout-ms=')) args.timeoutMs = Number(value);
    else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1) throw new Error('--timeout-ms must be a positive whole number');
  return args;
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function listFiles(root, entry, found = []) {
  const full = path.join(root, entry);
  if (!fs.existsSync(full)) return found;
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) return found;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) {
      if (!SKIP_DIRS.has(name)) listFiles(root, path.join(entry, name), found);
    }
  } else if (!SKIP_FILE.test(path.basename(entry))) found.push(entry);
  return found;
}

const sourceFiles = (root) => COPY.flatMap((entry) => listFiles(root, entry));

function fingerprint(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(root, file)));
  }
  return hash.digest('hex');
}

function copyFiles(fromRoot, toRoot, files) {
  for (const file of files) {
    const target = path.join(toRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fromRoot, file), target);
    fs.chmodSync(target, 0o644);
  }
}

// ---------------------------------------------------------------------------

let activeChild = null;
const killGroup = (child) => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
};

// Runs a command in its own process group, so a timeout or our own exit also
// ends anything it started.
function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let output = '';
    let timedOut = false;
    const keep = (chunk) => {
      output += chunk;
      if (output.length > 8000000) output = output.slice(-4000000);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      killGroup(child);
      activeChild = null;
      resolve({ exitCode, signal, timedOut, output, duration_ms: Date.now() - started });
    };
    child.on('error', (err) => { output += `\nspawn failed: ${err.message}\n`; finish(127, null); });
    child.on('close', finish);
  });
}

function testEnv(work) {
  const home = path.join(work, 'home');
  const tmp = path.join(work, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Only what the tests need, so no credential or n8n setting leaks in.
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    N8N_BIN: '/nonexistent/n8n-blocked-by-mutation-harness',
    NODE_OPTIONS: `--require "${path.join(__dirname, 'net-guard.cjs')}"`,
  };
}

const runTests = (cwd, tests, env, timeoutMs) => runProcess(process.execPath,
  ['--test', '--test-reporter=tap', '--test-concurrency=1', ...tests], { cwd, env, timeoutMs });

// ---------------------------------------------------------------------------

async function runMutation(m, ctx) {
  const entry = { id: m.id, invariant: m.invariant, description: m.defect, target_file: m.file, tests_executed: m.tests, expected_failure: String(m.expect), exit_code: null, classification: 'ERROR', reason: '', failed_tests: [], failure_excerpt: '', duration_ms: 0 };
  const target = path.join(ctx.snapshot, m.file);
  const missing = m.tests.filter((t) => !fs.existsSync(path.join(ctx.snapshot, t)));
  if (!fs.existsSync(target) || missing.length > 0) {
    return Object.assign(entry, { classification: 'INVALID', reason: fs.existsSync(target) ? `test files not found: ${missing.join(', ')}` : 'the target file is not in the snapshot' });
  }
  const applied = L.applyMutation(fs.readFileSync(target, 'utf8'), m);
  if (!applied.ok) return Object.assign(entry, { classification: 'INVALID', reason: applied.reason, occurrences: applied.occurrences });

  const dir = fs.mkdtempSync(path.join(ctx.work, 'mutant-'));
  const log = [];
  try {
    copyFiles(ctx.snapshot, dir, ctx.files);
    fs.writeFileSync(path.join(dir, m.file), applied.text);
    const env = testEnv(dir);
    // A syntax error would fail every test and prove nothing.
    if (m.file.endsWith('.js')) {
      const syntax = await runProcess(process.execPath, ['--check', m.file], { cwd: dir, env, timeoutMs: 30000 });
      log.push(`--- node --check ---\n${syntax.output}`);
      if (syntax.exitCode !== 0) return Object.assign(entry, { exit_code: syntax.exitCode, reason: 'the mutated file does not parse', failure_excerpt: syntax.output.slice(0, 1500) });
    }
    // The workflow JSON embeds the core and glue. Rebuilding keeps it in step, so
    // "the committed JSON is stale" can never pass for catching a logic defect.
    if (fs.existsSync(path.join(dir, BUILDER))) {
      const build = await runProcess(process.execPath, [BUILDER], { cwd: dir, env, timeoutMs: 60000 });
      log.push(`--- rebuild workflow ---\n${build.output}`);
      if (build.exitCode !== 0) return Object.assign(entry, { exit_code: build.exitCode, reason: 'the workflow could not be rebuilt', failure_excerpt: build.output.slice(0, 1500) });
    }
    const run = await runTests(dir, m.tests, env, ctx.timeoutMs);
    log.push(`--- tests ---\n${run.output}`);
    const result = L.classifyRun(run, m.expect);
    return Object.assign(entry, {
      exit_code: run.exitCode, signal: run.signal, timed_out: run.timedOut, duration_ms: run.duration_ms,
      classification: result.classification, reason: result.reason, failed_tests: result.failed_tests,
      passed_tests: result.passed_tests, failure_excerpt: L.failureExcerpt(run.output, result.failed_tests),
    });
  } finally {
    // Kept for every result, so a crash can be diagnosed afterwards.
    fs.writeFileSync(path.join(ctx.logs, `${m.id}.log`), log.join('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeReport(file, report) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function main(argv) {
  const args = parseArgs(argv);
  const catalog = require(args.mutations);
  const problems = L.validateCatalog(catalog);
  if (problems.length > 0) throw new Error(`Invalid mutation catalog:\n  ${problems.join('\n  ')}`);
  const mutations = args.only ? catalog.filter((m) => args.only.includes(m.id)) : catalog;
  const unknown = (args.only || []).filter((id) => !catalog.some((m) => m.id === id));
  if (unknown.length > 0) throw new Error(`Unknown mutation IDs: ${unknown.join(', ')}`);

  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sheetops-mutation-work-'));
  if (isInside(work, args.root)) throw new Error(`The work directory ${work} must be outside the project`);
  const removeWork = () => {
    // Only this run's own directory, by the name it was created with.
    if (path.basename(work).startsWith('sheetops-mutation-work-') && !isInside(work, args.root)) fs.rmSync(work, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (activeChild) killGroup(activeChild);
      removeWork();
      process.exit(1);
    });
  }

  const out = args.out || fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sheetops-mutation-evidence-'));
  if (isInside(out, path.join(args.root, 'var'))) throw new Error('Evidence must stay outside var/');
  const logs = path.join(out, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const reportFile = path.join(out, 'report.json');

  const files = sourceFiles(args.root);
  const before = fingerprint(args.root, files);
  const snapshot = path.join(work, 'snapshot');
  copyFiles(args.root, snapshot, files);

  const report = {
    tool: 'scripts/mutation/run.js', scope: 'selected high-risk mutations; not a measure of complete coverage',
    started_at: new Date().toISOString(), node: process.version, source_fingerprint: before, files_copied: files.length,
    baseline: null, results: [], summary: null, source_unchanged: null, exit_code: null,
  };

  try {
    const tests = Array.from(new Set(mutations.flatMap((m) => m.tests))).sort();
    const present = tests.filter((t) => fs.existsSync(path.join(snapshot, t)));
    console.log(`Baseline: ${present.length} test files on an unmodified copy...`);
    const baselineDir = fs.mkdtempSync(path.join(work, 'baseline-'));
    copyFiles(snapshot, baselineDir, files);
    const baseRun = await runTests(baselineDir, present, testEnv(baselineDir), args.timeoutMs * 2);
    fs.writeFileSync(path.join(logs, 'baseline.log'), baseRun.output);
    fs.rmSync(baselineDir, { recursive: true, force: true });
    const parsed = L.parseFailures(baseRun.output);
    const baselinePassed = baseRun.exitCode === 0 && !baseRun.timedOut && parsed.failed.length === 0 && parsed.passed > 0 && present.length === tests.length;
    report.baseline = { passed: baselinePassed, test_files: present, missing_test_files: tests.filter((t) => !present.includes(t)), exit_code: baseRun.exitCode, tests_passed: parsed.passed, tests_failed: parsed.failed, duration_ms: baseRun.duration_ms };
    console.log(`Baseline: ${baselinePassed ? 'PASS' : 'FAIL'}, ${parsed.passed} results passed, ${parsed.failed.length} failed`);

    for (const m of mutations) {
      let entry;
      if (!baselinePassed) {
        entry = { id: m.id, invariant: m.invariant, description: m.defect, target_file: m.file, tests_executed: m.tests, exit_code: null, classification: 'NOT_RUN', reason: 'the baseline failed, so a failure here would prove nothing', failed_tests: [], failure_excerpt: '' };
      } else {
        try {
          entry = await runMutation(m, { snapshot, work, files, logs, timeoutMs: args.timeoutMs });
        } catch (err) {
          entry = { id: m.id, invariant: m.invariant, description: m.defect, target_file: m.file, tests_executed: m.tests, exit_code: null, classification: 'ERROR', reason: `harness error: ${err.message}`, failed_tests: [], failure_excerpt: String(err.stack || '').slice(0, 1500) };
        }
        console.log(`${entry.classification.padEnd(9)} ${m.id}${entry.classification === 'KILLED' ? '' : `: ${entry.reason}`}`);
      }
      report.results.push(entry);
      report.summary = L.summarize(report.results);
      writeReport(reportFile, report);
    }

    report.source_unchanged = fingerprint(args.root, sourceFiles(args.root)) === before;
    report.summary = L.summarize(report.results);
    report.exit_code = L.exitCodeFor({ baselinePassed, sourceUnchanged: report.source_unchanged, summary: report.summary });
    report.finished_at = new Date().toISOString();
    writeReport(reportFile, report);

    const s = report.summary;
    console.log(`\nKILLED ${s.KILLED}  SURVIVED ${s.SURVIVED}  INVALID ${s.INVALID}  ERROR ${s.ERROR}  NOT_RUN ${s.NOT_RUN}`);
    console.log(`Mutation score: ${s.mutation_score_text} of applied mutations. This is a selected list, not complete coverage.`);
    if (!report.source_unchanged) console.log('WARNING: the project source changed during the run; the result describes the snapshot.');
    console.log(`Report: ${reportFile}`);
    return report.exit_code;
  } finally {
    removeWork();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

module.exports = { main, parseArgs, sourceFiles };
