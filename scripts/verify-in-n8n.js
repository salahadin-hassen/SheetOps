'use strict';

// Replays simulated SheetOps runs in the real n8n engine, without Google.
//
// For each scenario, the simulator (test/support/n8n-sim.js) runs the workflow
// against the fake Google and records every node's output. The replay copy of
// the workflow swaps each HTTP node for a Code node that returns the recorded
// response and captures the request n8n would have sent. Everything else, i.e.
// the Set, Switch and Wait nodes, the real Code-node source, expressions and
// $() references, runs inside n8n. The script then compares every node's
// output, and every request, with the simulator's.
//
// Two test-only patches make outputs comparable: `$execution.id` and `$now`
// become constants in the replay copy. A separate check confirms those
// built-ins (and `isExecuted`) behave as the glue code expects.
//
// Usage: npm run verify:n8n
// Runs n8n with its own user folder in var/n8n-verify (gitignored; set
// SHEETOPS_VERIFY_DIR to use another folder), its own task-runner port, so it
// can run beside the dedicated server from scripts/start-n8n.sh, and telemetry and version checks off. No network calls.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildWorkflow } = require('../workflow/build.js');
const { runWorkflow } = require('../test/support/n8n-sim.js');
const { FakeGoogle } = require('../test/support/fake-google.js');
const { core, week2 } = require('../test/support/helpers.js');

const ROOT = path.join(__dirname, '..');
const USER_FOLDER = process.env.SHEETOPS_VERIFY_DIR ? path.resolve(process.env.SHEETOPS_VERIFY_DIR) : path.join(ROOT, 'var', 'n8n-verify');
const WORKFLOW_DIR = path.join(USER_FOLDER, 'replay-workflows');
const N8N = process.env.N8N_BIN || 'n8n';
const NOW = '2026-10-19T07:00:00.000Z';
const SPREADSHEET_ID = 'SHEET_ID_1234567890abcdef';
const FOLDER_ID = 'FOLDER_ID_123456';
const REPLAY_FIELD = '__replay_request';
// Scenarios with a prior run simulate it first, 20 minutes earlier: the replayed
// execution is then the recovery run.
const PRIOR_NOW = '2026-10-19T06:40:00.000Z';
const PRIOR_VERSION = 1000000500;

const w = week2();
const WEEK2_FILE = {
  id: 'drv-week2', name: 'demo-supplier_2026-10-19.csv',
  modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T05:58:00.000Z', content: w.csvText,
};
const batch = core.describeSourceFile(WEEK2_FILE, w.config);
const priorRow = (status) => Object.assign(core.buildStartedRow({ run_id: '0', mode: 'scheduled', started_at: '2026-10-18T07:00:00.000Z' }, batch), { status });
const week1 = core.describeSourceFile({ id: 'drv-week1', name: 'demo-supplier_2026-10-12.csv', modifiedTime: '2026-10-12T06:00:00.000Z', createdTime: '2026-10-12T05:58:00.000Z' }, w.config);
const week1Row = Object.assign(core.buildStartedRow({ run_id: '0', mode: 'scheduled', started_at: '2026-10-12T07:00:00.000Z' }, week1), { status: 'SUCCESS' });

const SCENARIOS = [
  { name: 'happy-path' },
  { name: 'publish-refused-403', fault: { kind: 'BATCH_UPDATE', type: 'status', status: 403, body: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } } },
  { name: 'lost-response-confirmed', fault: { kind: 'BATCH_UPDATE', type: 'apply_then_timeout' } },
  { name: 'unknown-not-applied-503', fault: { kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' } },
  { name: 'publish-lands-late', fault: { kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Read run row' } },
  {
    name: 'run-log-sorted',
    runLog: [week1Row],
    setup: (google) => google.before('Read working tabs', (g) => {
      const rows = g.tabs.get('Run Log').rows;
      rows.splice(1, 2, rows[2], rows[1]);
    }),
  },
  {
    name: 'late-original-after-recovery',
    version: PRIOR_VERSION,
    // The recovery is an explicit operator reprocess (automatic recovery is off).
    manual: { target_batch_id: batch.batch_id },
    prior: { fault: { kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Publish' } },
  },
  {
    name: 'late-original-before-recovery-publish',
    version: PRIOR_VERSION,
    manual: { target_batch_id: batch.batch_id },
    // Lands after the recovery's final Review check: only the version check can stop it.
    prior: { fault: { kind: 'BATCH_UPDATE', type: 'timeout_apply_later', applyAfter: 'Re-read Review' } },
  },
  {
    // An approval saved between the tab read and the final Review read (§8):
    // the run aborts with REVIEW_CHANGED and sends no publish.
    name: 'review-changed-abort',
    catalog: w.expected.catalog,
    review: w.expected.review,
    runLog: [priorRow('SUCCESS_WITH_EXCEPTIONS')],
    manual: { reprocess_latest: true },
    setup: (google) => google.before('Re-read Review', (g) => {
      const row = g.tabs.get('Review').rows.find((cells) => cells[0] === `RV|TEA-001|${batch.batch_id}`);
      row[core.REVIEW_COLUMNS.indexOf('decision')] = 'APPROVE';
    }),
  },
  {
    // A formula that shows APPROVE is not an approval, and the publish must not
    // store its result as typed text (§8).
    name: 'review-formula-abort',
    catalog: w.expected.catalog,
    review: w.expected.review.map((item) => (item.sku === 'TEA-001' ? Object.assign({}, item, { decision: { formula: '=UPPER("approve")', value: 'APPROVE' } }) : item)),
    runLog: [priorRow('SUCCESS_WITH_EXCEPTIONS')],
    manual: { reprocess_latest: true },
  },
  // Latin-1 bytes for "é": rejected as a whole through the real Extract From File node.
  { name: 'invalid-encoding-rejected', files: [Object.assign({}, WEEK2_FILE, { content: Buffer.concat([Buffer.from(w.csvText, 'utf8'), Buffer.from([0xe9])]) })] },
  { name: 'download-failed', fault: { kind: 'DRIVE_GET', type: 'timeout', times: 3 } },
  { name: 'bad-filename', files: [{ id: 'drv-xlsx', name: 'prices.xlsx', mimeType: 'application/vnd.ms-excel', modifiedTime: NOW, createdTime: NOW, content: 'PK' }] },
  { name: 'blocked-halted', runLog: [priorRow('HALTED_REVIEW')] },
  // A STARTED row three hours old: its age is not evidence, so the run blocks.
  { name: 'blocked-unresolved-old-started', runLog: [Object.assign(priorRow('STARTED'), { started_at: '2026-10-19T04:00:00.000Z' })] },
  { name: 'idle-committed', runLog: [priorRow('SUCCESS_WITH_EXCEPTIONS')] },
];

function configuredWorkflow(manual) {
  const workflow = buildWorkflow();
  for (const a of workflow.nodes.find((n) => n.name === 'Settings').parameters.assignments.assignments) {
    if (a.name === 'spreadsheet_id') a.value = SPREADSHEET_ID;
    if (a.name === 'inbox_folder_id') a.value = FOLDER_ID;
  }
  for (const a of workflow.nodes.find((n) => n.name === 'Manual run options').parameters.assignments.assignments) {
    if (manual && a.name in manual) a.value = manual[a.name];
  }
  return workflow;
}

function newGoogle(scenario) {
  const google = new FakeGoogle({ spreadsheetId: SPREADSHEET_ID, folderId: FOLDER_ID });
  const tab = (title, columns, sheetId, rows) => {
    google.addTab(title, Array.from(columns), { sheetId });
    for (const row of rows) google.tabs.get(title).rows.push(core.rowToValues(columns, row));
  };
  tab('Catalog', core.CATALOG_COLUMNS, 0, scenario.catalog || w.catalogBefore);
  tab('Review', core.REVIEW_COLUMNS, 101, scenario.review || []);
  tab('Changes', core.CHANGES_COLUMNS, 102, []);
  tab('Exceptions', core.EXCEPTIONS_COLUMNS, 103, []);
  tab('Run Log', core.RUNLOG_COLUMNS, 104, scenario.runLog || []);
  for (const file of scenario.files || [WEEK2_FILE]) google.addFile(file);
  if (scenario.version) google.addTab('_sheetops_version', [], { sheetId: scenario.version, rowCount: 1, columnCount: 1 });
  if (scenario.fault) google.inject(scenario.fault);
  if (scenario.setup) scenario.setup(google);
  return google;
}

// An n8n expression ("={{ ... }}") turned into plain Code-node JavaScript.
function expressionToJs(expression) {
  const inner = /^=\{\{([\s\S]*)\}\}$/.exec(expression.trim());
  if (!inner) throw new Error(`Unsupported expression ${expression}`);
  return inner[1].trim().replace(/\$json\b/g, '$input.first().json');
}

function replayWorkflow(base, sim, id, name) {
  const workflow = JSON.parse(JSON.stringify(base));
  workflow.id = id;
  workflow.name = `SheetOps replay: ${name}`;
  // The CLI starts from the manual trigger; drop the schedule path.
  workflow.nodes = workflow.nodes.filter((n) => !['Every 2 hours', 'Scheduled run'].includes(n.name));
  delete workflow.connections['Every 2 hours'];
  delete workflow.connections['Scheduled run'];
  workflow.nodes = workflow.nodes.map((node) => {
    if (node.type === 'n8n-nodes-base.code') {
      const jsCode = node.parameters.jsCode
        .split('String($execution.id)').join("'1'")
        .split('$now.toUTC().toISO()').join(`'${NOW}'`);
      return Object.assign({}, node, { parameters: Object.assign({}, node.parameters, { jsCode }) });
    }
    if (node.type === 'n8n-nodes-base.wait') {
      return Object.assign({}, node, { parameters: Object.assign({}, node.parameters, { amount: 1 }) });
    }
    if (node.type !== 'n8n-nodes-base.httpRequest') return node;
    const p = node.parameters;
    const recorded = sim.outputs.has(node.name) ? sim.outputs.get(node.name) : null;
    const body = p.sendBody ? `JSON.parse(${expressionToJs(p.jsonBody)})` : 'null';
    const jsCode = [
      `// Replay stand-in for the HTTP node "${node.name}".`,
      `const recorded = ${JSON.stringify(recorded)};`,
      `if (recorded === null) throw new Error('Replay: "${node.name}" was not expected to run');`,
      `const request = { method: ${JSON.stringify(p.method)}, url: ${expressionToJs(p.url)}, body: ${body} };`,
      `return recorded.map((item) => Object.assign({ json: Object.assign({}, item.json, { ${REPLAY_FIELD}: request }) }, item.binary ? { binary: item.binary } : {}));`,
    ].join('\n');
    return {
      id: node.id, name: node.name, type: 'n8n-nodes-base.code', typeVersion: 2, position: node.position,
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode },
    };
  });
  return workflow;
}

function builtInsWorkflow() {
  return {
    id: 'SheetOpsBuiltIns',
    name: 'SheetOps replay: built-ins',
    nodes: [
      { id: 'b0000000-0000-4000-8000-000000000001', name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'b0000000-0000-4000-8000-000000000002', name: 'Check built-ins', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0],
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: [
            'return [{ json: {',
            '  execution_id: String($execution.id),',
            '  now_iso: $now.toUTC().toISO(),',
            "  trigger_ran: $('Run manually').isExecuted,",
            "  unconnected_ran: $('Never runs').isExecuted,",
            '  module_type: typeof module,',
            '  buffer_type: typeof Buffer,',
            '} }];',
          ].join('\n'),
        },
      },
      { id: 'b0000000-0000-4000-8000-000000000003', name: 'Never runs', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 200], parameters: {} },
    ],
    connections: { 'Run manually': { main: [[{ node: 'Check built-ins', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    active: false,
  };
}

function n8n(args) {
  const env = Object.assign({}, process.env, {
    N8N_USER_FOLDER: USER_FOLDER,
    N8N_RUNNERS_BROKER_PORT: '5697',
    N8N_PORT: '5698',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
  });
  const result = spawnSync(N8N, args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 240000 });
  if (result.error) throw result.error;
  return result;
}

// The CLI prints a few log lines, then the execution as pretty-printed JSON
// starting with a line that holds only "{".
function parseExecution(stdout) {
  const start = stdout.search(/^\{\s*$/m);
  if (start < 0) throw new Error(`No JSON in n8n output:\n${stdout.slice(0, 2000)}`);
  return JSON.parse(stdout.slice(start));
}

function realOutputs(execution) {
  const runData = execution.data.resultData.runData;
  const outputs = new Map();
  for (const [name, runs] of Object.entries(runData)) {
    const main = (runs[0].data && runs[0].data.main) || [];
    outputs.set(name, [].concat(...main.map((items) => items || [])).map((item) => item.json));
  }
  return outputs;
}

function compare(base, sim, google, execution) {
  const problems = [];
  const real = realOutputs(execution);
  // Switch and Wait nodes pass items through, so the capture field can appear
  // downstream; only real HTTP nodes are compared as requests.
  const httpNodes = new Set(base.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').map((n) => n.name));
  const check = (label, actual, expected) => {
    try {
      assert.deepStrictEqual(actual, expected);
    } catch (err) {
      problems.push(`${label}: ${err.message.split('\n').slice(0, 12).join('\n')}`);
    }
  };
  check('executed nodes', Array.from(real.keys()).sort(), sim.order.slice().sort());
  for (const name of sim.order) {
    if (!real.has(name)) continue;
    const simItems = sim.outputs.get(name).map((item) => item.json);
    let realItems = real.get(name);
    const requests = realItems.map((json) => json[REPLAY_FIELD]).filter(Boolean);
    realItems = realItems.map((json) => {
      const copy = Object.assign({}, json);
      delete copy[REPLAY_FIELD];
      return copy;
    });
    check(`output of "${name}"`, realItems, simItems);
    if (httpNodes.has(name)) {
      const sent = google.log.filter((entry) => entry.node === name).pop();
      check(`request of "${name}"`, requests[0], { method: sent.method, url: sent.url, body: sent.body === undefined ? null : sent.body });
    }
  }
  return problems;
}

function main() {
  fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
  for (const file of fs.readdirSync(WORKFLOW_DIR)) fs.unlinkSync(path.join(WORKFLOW_DIR, file));
  const base = configuredWorkflow();
  const runs = SCENARIOS.map((scenario, i) => {
    const google = newGoogle(scenario);
    if (scenario.prior) {
      google.inject(scenario.prior.fault);
      const prior = runWorkflow(base, { google, now: PRIOR_NOW, executionId: '0', trigger: 'Run manually' });
      if (prior.error) throw new Error(`Prior run failed in ${scenario.name}: ${prior.error.message}`);
    }
    const workflow = scenario.manual ? configuredWorkflow(scenario.manual) : base;
    const sim = runWorkflow(workflow, { google, now: NOW, executionId: '1', trigger: 'Run manually' });
    if (sim.error) throw new Error(`Simulator failed in ${scenario.name}: ${sim.error.message}`);
    const id = `SheetOpsReplay${String(i + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(WORKFLOW_DIR, `${id}.json`), JSON.stringify(replayWorkflow(workflow, sim, id, scenario.name)));
    return { scenario, sim, google, id };
  });
  fs.writeFileSync(path.join(WORKFLOW_DIR, 'SheetOpsBuiltIns.json'), JSON.stringify(builtInsWorkflow()));
  // The production export itself, unchanged apart from an ID, to prove n8n accepts it.
  const production = Object.assign(JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow', 'sheetops.workflow.json'), 'utf8')), { id: 'SheetOpsMain0001' });
  fs.writeFileSync(path.join(WORKFLOW_DIR, 'SheetOpsMain0001.json'), JSON.stringify(production));

  const imported = n8n(['import:workflow', '--separate', `--input=${WORKFLOW_DIR}`]);
  if (imported.status !== 0) throw new Error(`Import failed (exit ${imported.status}):\n${imported.stdout}\n${imported.stderr}`);
  console.log(`Imported the production workflow and ${runs.length + 1} replay workflows into ${path.relative(ROOT, USER_FOLDER)}`);

  let failures = 0;
  const exportFile = path.join(USER_FOLDER, 'production-roundtrip.json');
  const exported = n8n(['export:workflow', '--id=SheetOpsMain0001', `--output=${exportFile}`]);
  if (exported.status !== 0) throw new Error(`Export failed:\n${exported.stdout}\n${exported.stderr}`);
  const roundTrip = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  const back = Array.isArray(roundTrip) ? roundTrip[0] : roundTrip;
  const shape = (wf) => wf.nodes.map((n) => [n.name, n.type, n.typeVersion, JSON.stringify(n.credentials || null), JSON.stringify(n.parameters)]).sort();
  try {
    assert.deepStrictEqual(shape(back), shape(production));
    assert.deepStrictEqual(back.connections, production.connections);
    console.log(`PASS  production import: ${back.nodes.length} nodes, connections and parameters survive an import/export round trip`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  production import round trip: ${err.message.split('\n').slice(0, 20).join('\n      ')}`);
  }

  const builtIns = n8n(['execute', '--id=SheetOpsBuiltIns', '--rawOutput']);
  if (builtIns.status !== 0) throw new Error(`Built-ins check failed:\n${builtIns.stdout.slice(-3000)}\n${builtIns.stderr.slice(-3000)}`);
  const info = realOutputs(parseExecution(builtIns.stdout)).get('Check built-ins')[0];
  const builtInsOk = /^\d+$/.test(info.execution_id) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(info.now_iso)
    && info.trigger_ran === true && info.unconnected_ran === false;
  if (!builtInsOk) failures += 1;
  console.log(`${builtInsOk ? 'PASS' : 'FAIL'}  built-ins: ${JSON.stringify(info)}`);

  for (const { scenario, sim, google, id } of runs) {
    const started = Date.now();
    const result = n8n(['execute', `--id=${id}`, '--rawOutput']);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status !== 0) {
      failures += 1;
      console.log(`FAIL  ${scenario.name} (${seconds} s): n8n exited ${result.status}\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-2000)}`);
      continue;
    }
    const problems = compare(base, sim, google, parseExecution(result.stdout));
    if (problems.length > 0) failures += 1;
    const late = google.landed.length > 0 ? `; late original publish: HTTP ${google.landed[0].reply.status}` : '';
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${scenario.name} (${seconds} s): ${sim.order.length} nodes; final outcome ${sim.outputs.get('Done')[0].json.run_status || sim.outputs.get('Done')[0].json.action}${late}`);
    for (const problem of problems) console.log(`      ${problem.replace(/\n/g, '\n      ')}`);
  }
  console.log(failures === 0 ? 'All replays match the simulator.' : `${failures} replay check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
