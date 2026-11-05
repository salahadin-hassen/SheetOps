'use strict';

// A real process around the live runner's real cli(), for test/live-exit.test.js.
// Usage: node live-runner-cli.js <scenario> <evidence root>
// Scripted scenarios replace only what the phases record; `real-inconclusive`
// runs the real harness phase against the fake Google with a lost response.
// Everything runs in dry mode: no network, no n8n.

const { cli } = require('../../scripts/live/run-live-tests.js');

const pass = (ctx, ids) => { for (const id of ids) ctx.recorder.result(id, 'PASS', { summary: 'scripted' }); };
const push = (ctx, ...entries) => { ctx.recorder.results.push(...entries); };

function scripted({ harness }) {
  return {
    check: async (ctx) => { ctx.recorder.result('T-UI', 'SKIPPED', { summary: 'scripted' }); pass(ctx, ['T-LIVE-1']); },
    harness: async (ctx) => { pass(ctx, ['T-ATOM-1', 'T-ATOM-2', 'T-SEC-1', 'T-VERSION-1']); await harness(ctx); },
    recovery: async (ctx) => { pass(ctx, ['T-LOST-B', 'T-LOST-A']); },
  };
}
const v2 = (verdict) => (ctx) => ctx.recorder.result('T-VERSION-2', verdict, { summary: 'scripted', problems: ['trial 1 scripted'], trials: [{ trial: 1, verdict, statuses: [null, 200] }] });

const SCENARIOS = {
  'all-pass': scripted({ harness: v2('PASS') }),
  'one-fail': scripted({ harness: v2('FAIL') }),
  'one-inconclusive': scripted({ harness: v2('INCONCLUSIVE') }),
  'fail-and-inconclusive': Object.assign(scripted({ harness: v2('INCONCLUSIVE') }), {
    recovery: async (ctx) => { pass(ctx, ['T-LOST-B']); ctx.recorder.result('T-LOST-A', 'FAIL', { problems: ['scripted'] }); },
  }),
  'missing-result': scripted({ harness: () => {} }),
  'nothing-recorded': { check: async () => {}, harness: async () => {}, recovery: async () => {} },
  'phase-throws': scripted({ harness: () => { throw new Error('scripted crash'); } }),
  'unknown-verdict': scripted({ harness: (ctx) => push(ctx, { id: 'T-VERSION-2', verdict: 'PASS*', details: {} }) }),
  'no-verdict': scripted({ harness: (ctx) => push(ctx, { id: 'T-VERSION-2' }) }),
  'null-entry': scripted({ harness: (ctx) => { v2('PASS')(ctx); push(ctx, null); } }),
  'no-id': scripted({ harness: (ctx) => { v2('PASS')(ctx); push(ctx, { verdict: 'PASS' }); } }),
  'duplicate-pass': scripted({ harness: (ctx) => { v2('PASS')(ctx); v2('PASS')(ctx); } }),
  'contradictory-duplicate': scripted({ harness: (ctx) => { v2('INCONCLUSIVE')(ctx); v2('PASS')(ctx); } }),
  'unexpected-test': scripted({ harness: (ctx) => { v2('PASS')(ctx); push(ctx, { id: 'T-EXTRA', verdict: 'PASS' }); } }),
  'results-not-a-list': scripted({ harness: (ctx) => { ctx.recorder.results = 'all good'; } }),
};

const [scenario, root] = process.argv.slice(2);
const common = [`--evidence-root=${root}`];
const run = scenario === 'real-inconclusive'
  ? cli(['harness', '--dry-run', '--reps=2', ...common], {
    // Trial 1's first request is lost in transit, so its outcome stays unknown.
    beforeTrialSend: (ctx, i) => { if (i === 1) ctx.transport.google.inject({ kind: 'BATCH_UPDATE', type: 'timeout' }); },
  })
  : cli(['all', '--dry-run', ...common], { phases: SCENARIOS[scenario] });
run.then((code) => { process.exitCode = code; });
