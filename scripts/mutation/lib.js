'use strict';

// Pure logic of the mutation harness: applying one mutation, reading test
// output, classifying a result and scoring a run. No I/O beyond what callers
// pass in, so harness.test.js can check every classification directly.

const REQUIRED = ['id', 'invariant', 'defect', 'file', 'find', 'replace', 'tests', 'expect'];

// A catalog problem is a bug in the catalog, so it stops the run.
function validateCatalog(mutations) {
  const problems = [];
  const ids = new Set();
  if (!Array.isArray(mutations) || mutations.length === 0) return ['the catalog is empty'];
  for (const m of mutations) {
    const label = m && m.id ? m.id : '(no id)';
    for (const key of REQUIRED) if (!m || m[key] === undefined) problems.push(`${label}: missing ${key}`);
    if (!m) continue;
    if (ids.has(m.id)) problems.push(`${label}: duplicate id`);
    ids.add(m.id);
    if (typeof m.find !== 'string' || m.find === '') problems.push(`${label}: find must be non-empty text`);
    if (typeof m.replace !== 'string') problems.push(`${label}: replace must be text`);
    if (m.find === m.replace) problems.push(`${label}: find and replace are the same`);
    if (!Array.isArray(m.tests) || m.tests.length === 0) problems.push(`${label}: tests must list at least one file`);
    if (!(m.expect instanceof RegExp)) problems.push(`${label}: expect must be a RegExp`);
    if (typeof m.file === 'string' && (m.file.startsWith('/') || m.file.split('/').includes('..'))) problems.push(`${label}: file must stay inside the project`);
  }
  return problems;
}

function countOccurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

// Exact text only, and the target must appear exactly once.
function applyMutation(source, mutation) {
  const count = countOccurrences(source, mutation.find);
  if (count !== 1) {
    return { ok: false, occurrences: count, reason: count === 0 ? 'the expected text is not in the file: the source changed, so this mutation is obsolete' : `the expected text appears ${count} times: the target is ambiguous` };
  }
  const at = source.indexOf(mutation.find);
  return { ok: true, occurrences: 1, text: source.slice(0, at) + mutation.replace + source.slice(at + mutation.find.length) };
}

// Names of failed tests in node --test TAP output, at any nesting level.
function parseFailures(output) {
  const failed = [];
  let passed = 0;
  for (const line of output.split('\n')) {
    const match = /^\s*(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'not ok') failed.push(match[2].replace(/\s+# (TODO|SKIP).*$/, '').trim());
    else passed += 1;
  }
  return { failed: Array.from(new Set(failed)), passed };
}

// A test file that failed as a whole (it crashed or could not load) is named by its path.
const isFileLevelFailure = (name) => /\.test\.js$/.test(name);

// run: { exitCode, signal, timedOut, output }. KILLED needs a named test that
// the mutation was meant to break. Anything else unclear is ERROR, never KILLED.
function classifyRun(run, expect) {
  const { failed, passed } = parseFailures(run.output || '');
  const real = failed.filter((name) => !isFileLevelFailure(name));
  const result = (classification, reason) => ({ classification, reason, failed_tests: failed, passed_tests: passed });
  if (run.timedOut) return result('ERROR', 'the test process timed out and was killed');
  if (run.signal) return result('ERROR', `the test process died on ${run.signal}`);
  if (run.exitCode === 0) {
    if (failed.length > 0) return result('ERROR', 'exit code 0 but tests are reported as failed');
    if (passed === 0) return result('ERROR', 'exit code 0 but no test ran');
    return result('SURVIVED', 'every selected test still passes');
  }
  if (real.length === 0) {
    return result('ERROR', failed.length > 0 ? 'a test file crashed before reporting a failing test' : `exit code ${run.exitCode} with no failing test reported`);
  }
  if (real.some((name) => expect.test(name))) return result('KILLED', 'the relevant regression test failed');
  return result('ERROR', `tests failed, but none the mutation was meant to break (expected ${expect})`);
}

// The failing test's name and what follows it, for the report.
function failureExcerpt(output, failedTests, limit = 1500) {
  if (!output) return '';
  const name = failedTests.find((n) => !isFileLevelFailure(n)) || failedTests[0];
  let at = name ? output.indexOf(`- ${name}`) : -1;
  if (at === -1) at = Math.max(0, output.length - limit);
  return output.slice(at, at + limit);
}

function summarize(results) {
  const count = (c) => results.filter((r) => r.classification === c).length;
  const counts = { KILLED: count('KILLED'), SURVIVED: count('SURVIVED'), INVALID: count('INVALID'), ERROR: count('ERROR'), NOT_RUN: count('NOT_RUN') };
  // INVALID was never applied, so it is out of the denominator. ERROR was
  // applied but proved nothing, so it counts against the score.
  const applied = counts.KILLED + counts.SURVIVED + counts.ERROR;
  return Object.assign(counts, {
    total: results.length,
    applied,
    mutation_score: applied === 0 ? null : counts.KILLED / applied,
    mutation_score_text: applied === 0 ? 'n/a' : `${counts.KILLED}/${applied} (${((counts.KILLED / applied) * 100).toFixed(1)}%)`,
  });
}

// 0 only for a clean baseline, an unchanged source tree and every mutation KILLED.
function exitCodeFor({ baselinePassed, sourceUnchanged, summary }) {
  if (!baselinePassed || !sourceUnchanged) return 1;
  if (summary.total === 0 || summary.KILLED !== summary.total) return 1;
  return 0;
}

module.exports = { validateCatalog, applyMutation, countOccurrences, parseFailures, classifyRun, failureExcerpt, summarize, exitCodeFor };
