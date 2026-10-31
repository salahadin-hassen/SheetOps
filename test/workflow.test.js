'use strict';

// FR-015: static checks on the importable workflow. It must be up to date with
// the core, contain no secrets, reference only existing nodes, and retry only
// idempotent calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflow, serialize, OUTPUT, CREDENTIAL_NAME } = require('../workflow/build.js');

const committed = fs.readFileSync(OUTPUT, 'utf8');
const workflow = JSON.parse(committed);
const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'sheetops-core.js'), 'utf8');
const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
const ofType = (type) => workflow.nodes.filter((node) => node.type === `n8n-nodes-base.${type}`);

test('the committed workflow JSON is exactly what the builder produces now', () => {
  assert.equal(committed, serialize(buildWorkflow()), 'run `npm run build:workflow` and commit the result');
});

test('every Code node except Done starts with the exact core source', () => {
  for (const node of ofType('code')) {
    const code = node.parameters.jsCode;
    assert.ok(code.endsWith('return main();\n'), node.name);
    if (node.name === 'Done') assert.ok(!code.includes('const SheetOps = {'), 'Done carries no core');
    else assert.ok(code.startsWith(core), `${node.name} must embed the current core`);
  }
});

test('the export contains no secrets, no credential IDs and only placeholder settings', () => {
  for (const pattern of [/-----BEGIN/, /PRIVATE KEY/, /ya29\./, /"access_token"/, /"refresh_token"/, /client_secret/i, /AIza[0-9A-Za-z_-]{20,}/, /"privateKey"/]) {
    assert.doesNotMatch(committed, pattern);
  }
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.deepEqual(node.credentials, { googleApi: { id: null, name: CREDENTIAL_NAME } }, node.name);
    } else {
      assert.equal(node.credentials, undefined, node.name);
    }
  }
  const settings = Object.fromEntries(byName.get('Settings').parameters.assignments.assignments.map((a) => [a.name, a.value]));
  assert.deepEqual(settings, { spreadsheet_id: 'PASTE_SPREADSHEET_ID', inbox_folder_id: 'PASTE_FOLDER_ID', supplier: 'demo-supplier', currency: 'ETB' });
  assert.equal(workflow.active, false, 'never exported active');
});

test('node names and IDs are unique and every reference resolves', () => {
  assert.equal(byName.size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
  const incoming = new Set();
  for (const [from, { main }] of Object.entries(workflow.connections)) {
    assert.ok(byName.has(from), `connection from unknown node ${from}`);
    for (const links of main) for (const link of links) {
      assert.ok(byName.has(link.node), `connection to unknown node ${link.node}`);
      incoming.add(link.node);
    }
  }
  for (const node of workflow.nodes) {
    const isStart = /Trigger$/.test(node.type) || node.type === 'n8n-nodes-base.stickyNote';
    assert.equal(incoming.has(node.name), !isStart, `${node.name} incoming connection`);
  }
  const text = JSON.stringify(workflow.nodes.map((n) => n.parameters));
  for (const match of text.matchAll(/\$\('([^']+)'\)/g)) assert.ok(byName.has(match[1]), `reference to unknown node ${match[1]}`);
  for (const node of ofType('switch')) {
    assert.equal(workflow.connections[node.name].main.length, node.parameters.numberOutputs, `${node.name} outputs`);
  }
});

test('HTTP nodes: Google credential, bounded timeouts, retries only on idempotent calls', () => {
  const neverRetried = ['Append STARTED row', 'Append BLOCKED row', 'Publish'];
  for (const node of ofType('httpRequest')) {
    const p = node.parameters;
    assert.deepEqual([p.authentication, p.nodeCredentialType], ['predefinedCredentialType', 'googleApi'], node.name);
    assert.ok(p.options.timeout > 0 && p.options.timeout <= 60000, `${node.name} timeout`);
    if (neverRetried.includes(node.name)) assert.ok(!node.retryOnFail, `${node.name} must not retry`);
    else assert.deepEqual([node.retryOnFail, node.maxTries, node.waitBetweenTries], [true, 3, 5000], node.name);
  }
  const publish = byName.get('Publish');
  assert.deepEqual(publish.parameters.options.response.response, { fullResponse: true, neverError: true, responseFormat: 'json' });
  assert.equal(publish.onError, 'continueRegularOutput');
  assert.equal(workflow.settings.executionOrder, 'v1');
  assert.equal(workflow.settings.executionTimeout, 300);
});

test('the failure path: every failure reads the run row first; FAILED is written only through Resolve failure', () => {
  const into = (target) => Object.entries(workflow.connections)
    .filter(([, { main }]) => main.some((links) => links.some((link) => link.node === target))).map(([from]) => from).sort();
  assert.deepEqual(into('Write FAILED row'), ['Write FAILED?']);
  assert.deepEqual(into('Write FAILED?'), ['Resolve failure']);
  assert.deepEqual(into('Resolve failure'), ['Read run row']);
  assert.deepEqual(into('Read run row'), ['Publish or record failure', 'Publish result', 'Review unchanged?', 'Wait 20 seconds']);
  // The final Review check (§8): a plan that writes Review is published only
  // after "Check Review" passes; rejected and halted plans publish directly.
  const outputs = (name) => workflow.connections[name].main.map((links) => links.map((link) => link.node));
  assert.deepEqual(outputs('Publish or record failure'), [['Re-read Review'], ['Read run row'], ['Publish']]);
  assert.deepEqual(outputs('Re-read Review'), [['Check Review']]);
  assert.deepEqual(outputs('Check Review'), [['Review unchanged?']]);
  assert.deepEqual(outputs('Review unchanged?'), [['Publish'], ['Read run row']]);
  assert.deepEqual(into('Publish'), ['Publish or record failure', 'Review unchanged?']);
  assert.deepEqual([byName.get('Re-read Review').parameters.method, byName.get('Re-read Review').retryOnFail], ['GET', true]);
  // Output 2 of "Publish result" is the unknown outcome: it only waits, then reads.
  assert.deepEqual(workflow.connections['Publish result'].main.map((links) => links.map((link) => link.node)),
    [['Done'], ['Read run row'], ['Wait 20 seconds']]);
  assert.deepEqual(workflow.connections['Wait 20 seconds'].main, [[{ node: 'Read run row', type: 'main', index: 0 }]]);
  assert.deepEqual([byName.get('Wait 20 seconds').parameters.amount, byName.get('Wait 20 seconds').parameters.unit], [20, 'seconds']);
  assert.equal(byName.get('Read run row').parameters.url, '={{ $json.run_row.read_url }}');
  assert.equal(byName.get('Write FAILED row').parameters.method, 'PUT');
});

test('every execution is saved, so diagnostics such as PUBLISH_OUTCOME_UNKNOWN stay in n8n', () => {
  const s = workflow.settings;
  assert.deepEqual([s.saveDataSuccessExecution, s.saveDataErrorExecution, s.saveManualExecutions], ['all', 'all', true]);
});

test('the version is read before the tabs, so a plan can never pair fresh version with stale data', () => {
  assert.deepEqual(workflow.connections['Read sheet metadata'].main, [[{ node: 'Read working tabs', type: 'main', index: 0 }]]);
  assert.deepEqual(workflow.connections['Read working tabs'].main, [[{ node: 'Plan and build', type: 'main', index: 0 }]]);
  assert.match(byName.get('Read sheet metadata').parameters.url, /sheet_meta/);
});
