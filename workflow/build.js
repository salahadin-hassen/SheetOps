'use strict';

// Generates the importable n8n workflow from src/sheetops-core.js and the glue
// files in workflow/nodes/. The JSON is a build product: change this file or a
// glue file, then run `npm run build:workflow`. A test fails if the committed
// JSON is stale.
//
// Node types and parameter names match n8n 2.41 (nodes-base 2.41.5); they were
// read from the installed node definitions, not guessed.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(__dirname, 'sheetops.workflow.json');
const CREDENTIAL_NAME = 'SheetOps Google service account';
const READ_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const PUBLISH_TIMEOUT_MS = 60000;

function readCore() {
  return fs.readFileSync(path.join(ROOT, 'src', 'sheetops-core.js'), 'utf8');
}

function readGlue(file) {
  return fs.readFileSync(path.join(__dirname, 'nodes', `${file}.js`), 'utf8');
}

function buildWorkflow() {
  const core = readCore();
  const nodes = [];
  const connections = {};
  // Stable IDs keep the build reproducible.
  const id = () => `5be7c0de-0000-4000-8000-${String(nodes.length + 1).padStart(12, '0')}`;

  const add = (node) => {
    nodes.push(Object.assign({ id: id() }, node));
    return node.name;
  };
  const connect = (from, targets) => {
    connections[from] = { main: targets.map((target) => (target ? [{ node: target, type: 'main', index: 0 }] : [])) };
  };

  const setNode = (name, position, fields, includeOtherFields) => add({
    name,
    type: 'n8n-nodes-base.set',
    typeVersion: 3.4,
    position,
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: fields.map(([field, type, value], i) => ({
          id: `${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${i + 1}`, name: field, value, type,
        })),
      },
      includeOtherFields,
      options: {},
    },
  });

  const codeNode = (name, position, glue, withCore) => add({
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `${withCore ? `${core}\n` : ''}// ---- n8n glue for "${name}" (workflow/nodes/${glue}.js) ----\n${readGlue(glue)}\nreturn main();\n`,
    },
  });

  const httpNode = (name, position, spec) => {
    const response = {};
    if (spec.fullResponse) response.fullResponse = true;
    if (spec.neverError) response.neverError = true;
    if (spec.responseFormat) response.responseFormat = spec.responseFormat;
    if (spec.outputPropertyName) response.outputPropertyName = spec.outputPropertyName;
    const options = { timeout: spec.timeout };
    if (Object.keys(response).length > 0) options.response = { response };
    const parameters = {
      method: spec.method,
      url: spec.url,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
    };
    if (spec.body) Object.assign(parameters, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: spec.body });
    parameters.options = options;
    const node = {
      name,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position,
      parameters,
      // No ID and no secret: on import, n8n links the credential with this
      // exact name and type, if the instance has one.
      credentials: { googleApi: { id: null, name: CREDENTIAL_NAME } },
    };
    // Only idempotent calls are retried automatically.
    if (spec.retry) Object.assign(node, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 });
    if (spec.continueOnFail) node.onError = 'continueRegularOutput';
    return add(node);
  };

  const switchNode = (name, position, outputs, expression) => add({
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position,
    parameters: { mode: 'expression', numberOutputs: outputs, output: expression },
  });

  const fromPrepare = (key) => `={{ $('Prepare run').first().json.requests.${key} }}`;
  const httpBody = '={{ JSON.stringify($json.http.body) }}';

  add({
    name: 'How to set up',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [380, -160],
    parameters: {
      width: 520,
      height: 300,
      content: [
        '## SheetOps: supplier price list reconciliation',
        '1. Create a **Google Service Account API** credential named exactly',
        `   \`${CREDENTIAL_NAME}\`, with "Set up for use in HTTP Request node" on and these scopes:`,
        '   `https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly`',
        '2. Paste the spreadsheet ID and the inbox folder ID into **Settings**.',
        '3. Run once by hand. For a manual reprocess or override, edit **Manual run options**.',
        'Rules and statuses: docs/data-contract.md. Do not edit the Review tab while Run Log shows STARTED.',
      ].join('\n'),
    },
  });

  add({
    name: 'Every 2 hours',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 200],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 8-18/2 * * *' }] } },
  });
  add({ name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 420], parameters: {} });
  setNode('Scheduled run', [220, 200], [['mode', 'string', 'scheduled']], false);
  setNode('Manual run options', [220, 420], [
    ['mode', 'string', 'manual'],
    ['target_batch_id', 'string', ''],
    ['reprocess_latest', 'boolean', false],
    ['confirm_mass_discontinue', 'boolean', false],
  ], false);
  setNode('Settings', [440, 300], [
    ['spreadsheet_id', 'string', 'PASTE_SPREADSHEET_ID'],
    ['inbox_folder_id', 'string', 'PASTE_FOLDER_ID'],
    ['supplier', 'string', 'demo-supplier'],
    ['currency', 'string', 'ETB'],
  ], true);
  codeNode('Prepare run', [660, 300], 'prepare-run', true);
  httpNode('List inbox', [880, 300], { method: 'GET', url: '={{ $json.http.url }}', timeout: READ_TIMEOUT_MS, retry: true });
  httpNode('Read Run Log', [1100, 300], { method: 'GET', url: fromPrepare('read_run_log'), timeout: READ_TIMEOUT_MS, retry: true });
  codeNode('Select batch', [1320, 300], 'select-batch', true);
  switchNode('Route', [1540, 300], 3, '={{ $json.route }}');
  httpNode('Append STARTED row', [1760, 200], { method: 'POST', url: '={{ $json.http.url }}', body: httpBody, timeout: READ_TIMEOUT_MS });
  httpNode('Append BLOCKED row', [1760, 520], { method: 'POST', url: '={{ $json.http.url }}', body: httpBody, timeout: READ_TIMEOUT_MS });
  switchNode('Download needed?', [1980, 200], 2, "={{ $('Select batch').first().json.selection.action === 'PROCESS' ? 0 : 1 }}");
  httpNode('Download CSV', [2200, 80], {
    method: 'GET', url: "={{ $('Select batch').first().json.download_url }}", timeout: DOWNLOAD_TIMEOUT_MS,
    retry: true, continueOnFail: true, responseFormat: 'text', outputPropertyName: 'csv',
  });
  httpNode('Read sheet metadata', [2420, 200], { method: 'GET', url: fromPrepare('sheet_meta'), timeout: READ_TIMEOUT_MS, retry: true, continueOnFail: true });
  httpNode('Read working tabs', [2640, 200], { method: 'GET', url: fromPrepare('read_working_tabs'), timeout: READ_TIMEOUT_MS, retry: true, continueOnFail: true });
  codeNode('Plan and build', [2860, 200], 'plan-and-build', true);
  switchNode('Publish or record failure', [3080, 200], 3, '={{ $json.route }}');
  // Never retried: a retry after a lost response could apply twice.
  httpNode('Publish', [3960, 80], {
    method: 'POST', url: '={{ $json.http.url }}', body: httpBody, timeout: PUBLISH_TIMEOUT_MS,
    continueOnFail: true, fullResponse: true, neverError: true, responseFormat: 'json',
  });
  codeNode('Check publish', [4180, 80], 'check-publish', true);
  switchNode('Publish result', [4400, 80], 3, '={{ $json.route }}');
  add({
    name: 'Wait 20 seconds',
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: [4620, -60],
    webhookId: '5be7c0de-0000-4000-9000-000000000001',
    parameters: { resume: 'timeInterval', amount: 20, unit: 'seconds' },
  });
  // Every failure after the STARTED row exists reads that exact row first.
  httpNode('Read run row', [4840, 200], { method: 'GET', url: '={{ $json.run_row.read_url }}', timeout: READ_TIMEOUT_MS, retry: true, continueOnFail: true });
  codeNode('Resolve failure', [5060, 200], 'resolve-failure', true);
  switchNode('Write FAILED?', [5280, 200], 2, '={{ $json.route }}');
  httpNode('Write FAILED row', [5500, 340], { method: 'PUT', url: '={{ $json.http.url }}', body: httpBody, timeout: READ_TIMEOUT_MS, retry: true });
  codeNode('Done', [5720, 300], 'done', false);
  // The final Review check (§8), added in v2.5 after the nodes above so their
  // IDs stay stable. Reading is idempotent, so it is retried like other reads.
  httpNode('Re-read Review', [3300, -60], { method: 'GET', url: fromPrepare('read_review'), timeout: READ_TIMEOUT_MS, retry: true, continueOnFail: true });
  codeNode('Check Review', [3520, -60], 'check-review', true);
  switchNode('Review unchanged?', [3740, -60], 2, '={{ $json.route }}');

  connect('Every 2 hours', ['Scheduled run']);
  connect('Run manually', ['Manual run options']);
  connect('Scheduled run', ['Settings']);
  connect('Manual run options', ['Settings']);
  connect('Settings', ['Prepare run']);
  connect('Prepare run', ['List inbox']);
  connect('List inbox', ['Read Run Log']);
  connect('Read Run Log', ['Select batch']);
  connect('Select batch', ['Route']);
  connect('Route', ['Append STARTED row', 'Append BLOCKED row', 'Done']);
  connect('Append STARTED row', ['Download needed?']);
  connect('Append BLOCKED row', ['Done']);
  connect('Download needed?', ['Download CSV', 'Read sheet metadata']);
  connect('Download CSV', ['Read sheet metadata']);
  connect('Read sheet metadata', ['Read working tabs']);
  connect('Read working tabs', ['Plan and build']);
  connect('Plan and build', ['Publish or record failure']);
  connect('Publish or record failure', ['Re-read Review', 'Read run row', 'Publish']);
  connect('Re-read Review', ['Check Review']);
  connect('Check Review', ['Review unchanged?']);
  connect('Review unchanged?', ['Publish', 'Read run row']);
  connect('Publish', ['Check publish']);
  connect('Check publish', ['Publish result']);
  connect('Publish result', ['Done', 'Read run row', 'Wait 20 seconds']);
  connect('Wait 20 seconds', ['Read run row']);
  connect('Read run row', ['Resolve failure']);
  connect('Resolve failure', ['Write FAILED?']);
  connect('Write FAILED?', ['Done', 'Write FAILED row']);
  connect('Write FAILED row', ['Done']);

  return {
    name: 'SheetOps: supplier price list reconciliation',
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'Africa/Addis_Ababa',
      saveManualExecutions: true,
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveExecutionProgress: true,
      executionTimeout: 300,
    },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

function serialize(workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

if (require.main === module) {
  const text = serialize(buildWorkflow());
  fs.writeFileSync(OUTPUT, text);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${text.length} bytes)`);
}

module.exports = { buildWorkflow, serialize, OUTPUT, CREDENTIAL_NAME };
