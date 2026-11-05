'use strict';

// Tests of the mutation harness itself. A harness that reports false kills is
// worse than none, so each classification is proved here on a tiny throwaway
// project. Run: node --test scripts/mutation/harness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const L = require('./lib.js');
const { sourceFiles } = require('./run.js');
const catalog = require('./mutations.js');

const RUN = path.join(__dirname, 'run.js');

function project(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-selftest-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"t"}');
  fs.writeFileSync(path.join(root, 'src', 'x.js'), "exports.add = (a, b) => a + b; // marker\nexports.twin = 1;\nexports.twin2 = 1;\n");
  fs.writeFileSync(path.join(root, 'test', 'x.test.js'), "const t = require('node:test');\nconst a = require('node:assert');\nconst { add } = require('../src/x.js');\nt('add works', () => a.equal(add(1, 2), 3));\n");
  fs.writeFileSync(path.join(root, 'test', 'other.test.js'), "const t = require('node:test');\nconst a = require('node:assert');\nconst { add } = require('../src/x.js');\nt('unrelated check', () => a.equal(add(0, 0), 0));\n");
  for (const [file, text] of Object.entries(extra || {})) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function harness(root, mutations, flags) {
  const catalogFile = path.join(root, 'catalog.cjs');
  fs.writeFileSync(catalogFile, `module.exports = [${mutations.join(',')}];`);
  const out = path.join(root, 'evidence');
  const p = spawnSync(process.execPath, [RUN, `--root=${root}`, `--out=${out}`, `--mutations=${catalogFile}`, ...(flags || [])], { encoding: 'utf8', timeout: 120000 });
  const file = path.join(out, 'report.json');
  return { code: p.status, stdout: p.stdout, stderr: p.stderr, report: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

const m = (id, find, replace, expect, tests) => `{ id: ${JSON.stringify(id)}, invariant: 'i', defect: 'd', file: 'src/x.js', find: ${JSON.stringify(find)}, replace: ${JSON.stringify(replace)}, tests: ${JSON.stringify(tests || ['test/x.test.js'])}, expect: ${expect || '/add works/'} }`;
const classes = (r) => Object.fromEntries(r.report.results.map((x) => [x.id, x.classification]));

test('catalog: valid, at least eight mutations, each targeted and explained', () => {
  assert.deepEqual(L.validateCatalog(catalog), []);
  assert.ok(catalog.length >= 8);
  for (const entry of catalog) assert.ok(entry.defect.length > 10 && entry.invariant.length > 5, entry.id);
  assert.ok(L.validateCatalog([{ id: 'x' }]).length > 0);
  assert.match(L.validateCatalog([{ id: 'x', invariant: 'i', defect: 'd', file: '../y', find: 'a', replace: 'b', tests: ['t'], expect: /x/ }])[0], /inside the project/);
  assert.match(L.validateCatalog([{ id: 'x', invariant: 'i', defect: 'd', file: 'y', find: 'a', replace: 'a', tests: ['t'], expect: /x/ }])[0], /same/);
});

test('the real catalog: targets and tests exist, and the real copy holds no frontend or runtime data', () => {
  const repo = path.join(__dirname, '..', '..');
  for (const entry of catalog) {
    assert.ok(fs.existsSync(path.join(repo, entry.file)), entry.file);
    for (const file of entry.tests) assert.ok(fs.existsSync(path.join(repo, file)), file);
  }
  const files = sourceFiles(repo);
  assert.ok(files.includes(path.join('src', 'sheetops-core.js')));
  for (const f of files) assert.doesNotMatch(f, /^(frontend|var|\.git|\.claude)\b|node_modules|scripts\/mutation/, f);
});

test('applyMutation: exactly one occurrence, or nothing is changed', () => {
  assert.equal(L.applyMutation('a b c', { find: 'b', replace: 'X' }).text, 'a X c');
  assert.deepEqual([L.applyMutation('a c', { find: 'b', replace: 'X' }).ok, L.applyMutation('a c', { find: 'b', replace: 'X' }).occurrences], [false, 0]);
  assert.deepEqual([L.applyMutation('b b', { find: 'b', replace: 'X' }).ok, L.applyMutation('b b', { find: 'b', replace: 'X' }).occurrences], [false, 2]);
  // Replacement text with $ is taken literally.
  assert.equal(L.applyMutation('a b', { find: 'b', replace: '$& $1' }).text, 'a $& $1');
});

test('classifyRun: only a named, relevant failure is KILLED', () => {
  const c = (run) => L.classifyRun(Object.assign({ exitCode: 1, signal: null, timedOut: false, output: '' }, run), /relevant/).classification;
  assert.equal(c({ output: 'not ok 1 - the relevant test\nok 2 - other\n' }), 'KILLED');
  assert.equal(c({ output: '  not ok 1 - nested relevant one\n' }), 'KILLED');
  assert.equal(c({ output: 'not ok 1 - something else\n' }), 'ERROR');
  assert.equal(c({ output: 'not ok 1 - /tmp/x/test/relevant.test.js\n' }), 'ERROR');
  assert.equal(c({ output: 'garbage' }), 'ERROR');
  assert.equal(c({ exitCode: 0, output: 'ok 1 - fine\n' }), 'SURVIVED');
  assert.equal(c({ exitCode: 0, output: '' }), 'ERROR');
  assert.equal(c({ exitCode: 0, output: 'not ok 1 - the relevant test\n' }), 'ERROR');
  assert.equal(c({ timedOut: true, output: 'not ok 1 - the relevant test\n' }), 'ERROR');
  assert.equal(c({ signal: 'SIGKILL', exitCode: null, output: 'not ok 1 - the relevant test\n' }), 'ERROR');
});

test('summarize and exit code: INVALID is out of the denominator; only all-KILLED exits 0', () => {
  const rows = (...c) => c.map((classification) => ({ classification }));
  const s = L.summarize(rows('KILLED', 'KILLED', 'SURVIVED', 'ERROR', 'INVALID'));
  assert.deepEqual([s.KILLED, s.SURVIVED, s.ERROR, s.INVALID, s.applied], [2, 1, 1, 1, 4]);
  assert.equal(s.mutation_score, 0.5);
  assert.equal(L.summarize(rows('INVALID')).mutation_score, null);
  const code = (baselinePassed, sourceUnchanged, ...c) => L.exitCodeFor({ baselinePassed, sourceUnchanged, summary: L.summarize(rows(...c)) });
  assert.equal(code(true, true, 'KILLED', 'KILLED'), 0);
  for (const other of ['SURVIVED', 'INVALID', 'ERROR', 'NOT_RUN']) assert.equal(code(true, true, 'KILLED', other), 1, other);
  assert.equal(code(false, true, 'KILLED'), 1);
  assert.equal(code(true, false, 'KILLED'), 1);
  assert.equal(code(true, true), 1, 'no mutation ran');
});

test('the copy excludes frontend, var, git, dependencies and anything shaped like a credential', () => {
  const root = project({
    'frontend/src/a.ts': 'x', 'var/live/a.json': 'x', '.git/config': 'x', 'test/node_modules/a.js': 'x',
    'scripts/.env': 'x', 'scripts/service-account.json': 'x', 'scripts/a.key.json': 'x', 'scripts/mutation/self.js': 'x', 'scripts/keep.js': 'x', 'other/z.js': 'x',
  });
  const files = sourceFiles(root);
  assert.ok(files.includes(path.join('scripts', 'keep.js')));
  assert.ok(files.includes(path.join('src', 'x.js')));
  for (const f of files) assert.doesNotMatch(f, /frontend|^var|\.git|node_modules|\.env|service-account|key\.json|mutation|^other/, f);
  fs.rmSync(root, { recursive: true, force: true });
});

test('end to end: each classification, the real project untouched, and no work directory left', () => {
  const root = project();
  const before = fs.readFileSync(path.join(root, 'src', 'x.js'), 'utf8');
  const tmp = path.join(root, 'tmp');
  const r = harness(root, [
    m('killed', 'a + b', 'a - b'),
    m('survived', '// marker', '// changed'),
    m('invalid-absent', 'not in the file', 'x'),
    m('invalid-ambiguous', '= 1', '= 2'),
    m('error-syntax', 'a + b', 'a + + + ('),
    m('error-unrelated', 'a + b', 'a - b', '/no such test/'),
    m('error-crash', '// marker', "throw new Error('load crash');"),
  ]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(classes(r), {
    killed: 'KILLED', survived: 'SURVIVED', 'invalid-absent': 'INVALID', 'invalid-ambiguous': 'INVALID',
    'error-syntax': 'ERROR', 'error-unrelated': 'ERROR', 'error-crash': 'ERROR',
  });
  const s = r.report.summary;
  assert.deepEqual([s.KILLED, s.SURVIVED, s.INVALID, s.ERROR, s.applied], [1, 1, 2, 3, 5]);
  assert.equal(s.mutation_score, 0.2);
  assert.equal(r.report.source_unchanged, true);
  const killed = r.report.results.find((x) => x.id === 'killed');
  assert.deepEqual(killed.failed_tests, ['add works']);
  assert.match(killed.failure_excerpt, /add works/);
  assert.equal(killed.exit_code, 1);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'x.js'), 'utf8'), before, 'the real file was not changed');
  assert.ok(fs.existsSync(path.join(root, 'evidence', 'logs', 'killed.log')));
  assert.ok(fs.existsSync(path.join(root, 'evidence', 'logs', 'baseline.log')));
  assert.ok(!fs.existsSync(tmp));
  fs.rmSync(root, { recursive: true, force: true });
});

test('all KILLED exits 0; a failing baseline runs no mutation and exits 1', () => {
  const good = project();
  const ok = harness(good, [m('killed', 'a + b', 'a - b')]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(ok.report.baseline.passed, true);
  fs.rmSync(good, { recursive: true, force: true });

  const bad = project({ 'test/x.test.js': "const t = require('node:test');\nconst a = require('node:assert');\nt('add works', () => a.equal(1, 2));\n" });
  const failed = harness(bad, [m('killed', 'a + b', 'a - b')]);
  assert.equal(failed.code, 1);
  assert.equal(failed.report.baseline.passed, false);
  assert.deepEqual(classes(failed), { killed: 'NOT_RUN' }, 'a pre-existing failure is never counted as a kill');
  fs.rmSync(bad, { recursive: true, force: true });
});

test('a hanging mutant times out as ERROR, and its process group is killed', () => {
  const root = project();
  // A duration no other process uses, to find a child left behind.
  const duration = `29${process.pid}.5`;
  const r = harness(root, [m('hang', '// marker', `require('node:child_process').spawn('sleep', ['${duration}'], { stdio: 'ignore' }); for (;;);`)], ['--timeout-ms=3000']);
  assert.equal(classes(r).hang, 'ERROR');
  assert.equal(r.report.results[0].timed_out, true);
  const left = spawnSync('pgrep', ['-x', '-f', `sleep ${duration}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'no child process is left running');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the network is blocked inside test processes', () => {
  const root = project({
    'test/x.test.js': "const t = require('node:test');\nconst a = require('node:assert');\nconst { add } = require('../src/x.js');\nt('add works', () => { a.equal(add(1, 2), 3); a.throws(() => require('node:net').connect(443, 'example.com'), /network access is blocked/); });\n",
  });
  const r = harness(root, [m('killed', 'a + b', 'a - b')]);
  assert.equal(r.report.baseline.passed, true, r.stdout);
  fs.rmSync(root, { recursive: true, force: true });
});

test('options: an unknown option or mutation ID stops the harness with exit 2', () => {
  const root = project();
  assert.equal(spawnSync(process.execPath, [RUN, '--nope'], { encoding: 'utf8' }).status, 2);
  const r = harness(root, [m('killed', 'a + b', 'a - b')], ['--only=missing']);
  assert.equal(r.code, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
