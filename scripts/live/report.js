'use strict';

// Decides what a live-test run established. The terminal summary, report.json
// and the exit code all come from one assessment, so they cannot disagree.
//
// Fail-closed: exit 0 needs every test the selected phases require, each with
// exactly one passing result, and nothing else wrong. Absent, malformed,
// duplicate or unexpected results never count as success. Each verdict keeps
// its own classification: INCONCLUSIVE is neither a pass nor a failure, but it
// is not a success either.

const REQUIRED_BY_PHASE = {
  check: ['T-UI', 'T-LIVE-1'],
  harness: ['T-ATOM-1', 'T-ATOM-2', 'T-SEC-1', 'T-VERSION-1', 'T-VERSION-2'],
  recovery: ['T-LOST-B', 'T-LOST-A'],
  reconcile: ['RECONCILE'],
};
const FULL_SUITE = ['check', 'harness', 'recovery'];
// Fewer trials than this is never a live concurrency verdict.
const MIN_LIVE_VERSION_TRIALS = 8;

const CATEGORY_OF = {
  PASS: 'passed',
  RESOLVED: 'passed',
  FAIL: 'failed',
  INCONCLUSIVE: 'inconclusive',
  ERROR: 'errors',
  SKIPPED: 'skipped',
  UNRESOLVED: 'unresolved',
};

// Terminal labels, in print order. PASSED, FAILED and INCONCLUSIVE always print,
// even at zero, so a reader never has to infer that one is absent.
const LINES = [
  ['PASSED', 'passed'],
  ['FAILED', 'failed'],
  ['INCONCLUSIVE', 'inconclusive'],
  ['ERROR', 'errors'],
  ['UNRESOLVED', 'unresolved'],
  ['SKIPPED', 'skipped'],
  ['MISSING', 'missing'],
  ['MALFORMED', 'malformed'],
];

function requiredTests(phases, transport) {
  const required = [];
  for (const phase of phases) required.push(...(REQUIRED_BY_PHASE[phase] || []));
  // A dry run has no n8n database or UI, so T-UI cannot run there.
  return transport === 'dry' ? required.filter((id) => id !== 'T-UI') : required;
}

function assess({ results, phases, transport, ledgerUnresolved }) {
  const required = requiredTests(phases, transport);
  const groups = { passed: [], failed: [], inconclusive: [], errors: [], unresolved: [], skipped: [], missing: [], malformed: [] };
  const seen = new Set();
  const allowedSkip = (id) => transport === 'dry' && id === 'T-UI' && phases.includes('check');

  if (!Array.isArray(results)) groups.malformed.push('the results are not a list');
  if (required.length === 0) groups.malformed.push('no required tests: nothing was selected to run');

  for (const [i, entry] of (Array.isArray(results) ? results : []).entries()) {
    const id = entry && entry.id;
    const verdict = entry && entry.verdict;
    if (typeof id !== 'string' || id === '') { groups.malformed.push(`result ${i}: no test ID`); continue; }
    const category = Object.prototype.hasOwnProperty.call(CATEGORY_OF, verdict) ? CATEGORY_OF[verdict] : null;
    if (!category) { groups.malformed.push(`${id}: unknown verdict ${JSON.stringify(verdict)}`); continue; }
    // An ERROR may name a phase; every other verdict must belong to a required test.
    if (category !== 'errors' && !required.includes(id) && !allowedSkip(id)) {
      groups.malformed.push(`${id}: ${verdict} from a test this run does not require`);
      continue;
    }
    if (transport === 'live' && id === 'T-VERSION-2' && verdict === 'PASS') {
      const trials = entry.details && Array.isArray(entry.details.trials) ? entry.details.trials.filter((t) => t && t.verdict === 'PASS').length : 0;
      if (trials < MIN_LIVE_VERSION_TRIALS) {
        seen.add(id);
        groups.malformed.push(`${id}: PASS with ${trials} recorded trials; a live verdict needs at least ${MIN_LIVE_VERSION_TRIALS}`);
        continue;
      }
    }
    if (seen.has(id)) groups.malformed.push(`${id}: more than one result`);
    seen.add(id);
    groups[category].push(id);
  }
  groups.missing = required.filter((id) => !seen.has(id));

  const blockingSkips = groups.skipped.filter((id) => !allowedSkip(id));
  const unresolvedInLedger = Array.isArray(ledgerUnresolved) ? ledgerUnresolved.length : 0;
  const ok = groups.failed.length === 0 && groups.inconclusive.length === 0 && groups.errors.length === 0
    && groups.unresolved.length === 0 && groups.missing.length === 0 && groups.malformed.length === 0
    && blockingSkips.length === 0 && unresolvedInLedger === 0;

  const full = FULL_SUITE.every((p) => phases.includes(p));
  const partialOutcome = full ? 'ALL_REQUIRED_PASSED' : 'PARTIAL_PASSED';
  return Object.assign({
    outcome: ok ? partialOutcome : 'NOT_PASSED',
    verification: full ? 'FULL' : 'PARTIAL',
    exit_code: ok ? 0 : 1,
    scope: full ? 'full suite' : `partial: ${phases.join(', ')} only`,
    required,
    unresolved_in_ledger: unresolvedInLedger,
    blocking_skips: blockingSkips,
  }, groups);
}

function summaryLines(summary, { transport, declared }) {
  const lines = ['', 'Summary'];
  for (const [label, key] of LINES) lines.push(`${label.padEnd(13)}${String(summary[key].length).padStart(2)}  ${summary[key].join(', ')}`.trimEnd());
  if (summary.unresolved_in_ledger > 0) lines.push(`${summary.unresolved_in_ledger} publication(s) in the ledger have an unknown outcome.`);
  if (summary.blocking_skips.length > 0) lines.push(`Skipped but required: ${summary.blocking_skips.join(', ')}`);
  lines.push('');
  if (summary.exit_code === 0) {
    if (summary.verification === 'FULL') lines.push(`Result: ALL REQUIRED TESTS PASSED (${summary.scope}).`);
    else {
      lines.push(`Result: PARTIAL VERIFICATION PASSED (${summary.scope.replace(/^partial: /, '')}).`);
      lines.push('The full live suite has not been verified by this run.');
    }
    if (declared > 0) lines.push(`This result rests on ${declared} operator declaration(s) that no evidence verifies.`);
  } else {
    const counts = LINES.slice(1).filter(([, key]) => key !== 'skipped' && summary[key].length > 0).map(([label, key]) => `${summary[key].length} ${label}`);
    if (summary.blocking_skips.length > 0) counts.push(`${summary.blocking_skips.length} SKIPPED`);
    if (summary.unresolved_in_ledger > 0) counts.push(`${summary.unresolved_in_ledger} unknown publication(s)`);
    lines.push(`Result: NOT PASSED (${summary.scope}): ${counts.join(', ')}.`);
  }
  if (transport === 'dry') lines.push('Dry run against the fake Google: this is not evidence about real Google behaviour.');
  return lines;
}

module.exports = { assess, summaryLines, requiredTests, REQUIRED_BY_PHASE, MIN_LIVE_VERSION_TRIALS };
