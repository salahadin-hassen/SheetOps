'use strict';

// Building blocks for the live tests (docs/setup.md §5).
//
// Every Google call goes through n8n, because the service-account key exists
// only inside n8n's credential store: the harness never sees it. A "relay"
// workflow sends a list of requests with the SheetOps credential and returns
// the full responses. Requests given to one relay run are sent concurrently:
// the HTTP Request node (v4.2) starts every item's request before awaiting any
// (Promise.allSettled in HttpRequestV3.node.js), unless batching is set.
//
// The dry transport replaces n8n and Google with the n8n simulator and the
// fake Google, so the whole live suite can be checked offline first.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const core = require('../../src/sheetops-core.js');
const { FakeGoogle, NetworkError } = require('../../test/support/fake-google.js');
const { runWorkflow: simulate } = require('../../test/support/n8n-sim.js');
const { buildWorkflow, CREDENTIAL_NAME } = require('../../workflow/build.js');

const ROOT = path.join(__dirname, '..', '..');
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MANAGED = Object.values(core.TABS);
const SNAPSHOT_FIELDS = 'properties.title,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),data(rowData(values(userEnteredValue))))';

// ---------------------------------------------------------------------------
// Secret scan: nothing that looks like a key or token is ever saved.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [/ya29\.[0-9A-Za-z_-]+/g, /Bearer\s+[0-9A-Za-z._-]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, /"private_key"\s*:\s*"[^"]*"/g];

function redact(text) {
  let found = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      found += 1;
      return '[REDACTED]';
    });
  }
  return { text: out, found };
}

// ---------------------------------------------------------------------------
// Snapshots: every cell of every tab, with its type, plus tab properties.
// ---------------------------------------------------------------------------

function snapshotRequest(spreadsheetId) {
  return { method: 'GET', url: `${SHEETS}/${spreadsheetId}?includeGridData=true&fields=${encodeURIComponent(SNAPSHOT_FIELDS)}` };
}

function apiCell(cell) {
  const v = cell && cell.userEnteredValue;
  if (!v) return null;
  if (typeof v.stringValue === 'string') return { s: v.stringValue };
  if (typeof v.numberValue === 'number') return { n: v.numberValue };
  if (typeof v.boolValue === 'boolean') return { b: v.boolValue };
  if (typeof v.formulaValue === 'string') return { f: v.formulaValue };
  return { other: v };
}

function trimRows(rows) {
  const out = rows.map((row) => {
    const copy = row.slice();
    while (copy.length > 0 && copy[copy.length - 1] === null) copy.pop();
    return copy;
  });
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
  return out;
}

function normalizeSnapshot(body) {
  const tabs = {};
  for (const sheet of body.sheets || []) {
    const p = sheet.properties || {};
    const grid = p.gridProperties || {};
    const rowData = (sheet.data && sheet.data[0] && sheet.data[0].rowData) || [];
    tabs[p.title] = {
      sheetId: p.sheetId === undefined ? 0 : p.sheetId,
      hidden: p.hidden === true,
      rowCount: grid.rowCount,
      columnCount: grid.columnCount,
      rows: trimRows(rowData.map((row) => ((row && row.values) || []).map(apiCell))),
    };
  }
  return { title: body.properties && body.properties.title, tabs };
}

const rawCell = (c) => {
  if (c === null || c === undefined) return '';
  if ('s' in c) return c.s;
  if ('n' in c) return c.n;
  if ('b' in c) return c.b;
  if ('f' in c) return c.f;
  return '';
};

// A tab as the values API returns it with UNFORMATTED_VALUE.
function tabValues(snapshot, title) {
  const tab = snapshot.tabs[title];
  return tab ? tab.rows.map((row) => row.map(rawCell)) : [];
}

function tabObjects(snapshot, title) {
  const [header, ...rows] = tabValues(snapshot, title);
  return rows.filter((row) => row.some((cell) => cell !== '')).map((row) => {
    const out = {};
    header.forEach((column, i) => { out[column] = row[i] === undefined ? '' : row[i]; });
    return out;
  });
}

// The inputs the workflow would read in steps 5 and 6.
function sheetInputs(snapshot) {
  const idColumn = (title) => {
    const values = tabValues(snapshot, title);
    let last = 0;
    values.forEach((row, i) => { if (i > 0 && row[0] !== undefined && row[0] !== '') last = i; });
    return { header: values[0] || [], ids: values.slice(1, last + 1).map((row) => row[0]), rows: last };
  };
  const sheetMeta = {};
  for (const [title, tab] of Object.entries(snapshot.tabs)) sheetMeta[title] = { sheetId: tab.sheetId, rowCount: tab.rowCount, columnCount: tab.columnCount };
  return {
    sheet: {
      catalog: tabValues(snapshot, core.TABS.catalog),
      review: tabValues(snapshot, core.TABS.review),
      changes: idColumn(core.TABS.changes),
      exceptions: idColumn(core.TABS.exceptions),
      runLog: tabValues(snapshot, core.TABS.runLog),
    },
    sheetMeta,
  };
}

function versionOf(snapshot) {
  const tab = snapshot.tabs[core.VERSION_TAB];
  return tab ? tab.sheetId : null;
}

// The version tab exactly as a publish creates it (buildPublishRequest's
// addSheet): hidden, one row by one column, no values. A test checks that the
// core still creates it this way.
const VERSION_TAB_SHAPE = Object.freeze({ hidden: true, rowCount: 1, columnCount: 1 });
const COLUMNS = { Catalog: core.CATALOG_COLUMNS, Review: core.REVIEW_COLUMNS, Changes: core.CHANGES_COLUMNS, Exceptions: core.EXCEPTIONS_COLUMNS, 'Run Log': core.RUNLOG_COLUMNS };

// Classifies the target spreadsheet. Exactly two states are accepted:
//   uninitialized: the five business tabs, no version tab;
//   initialized:   the five business tabs plus a valid _sheetops_version tab.
// Anything else throws, listing every problem. Nothing is ignored.
function classifySpreadsheet(snapshot) {
  const problems = [];
  const tabs = (snapshot && snapshot.tabs) || {};
  if (!/synthetic/i.test((snapshot && snapshot.title) || '')) problems.push(`the spreadsheet title "${snapshot && snapshot.title}" does not contain "synthetic"`);
  for (const title of Object.keys(tabs)) {
    if (MANAGED.includes(title) || title === core.VERSION_TAB) continue;
    if (/sheet\s*ops/i.test(title) && /version/i.test(title)) problems.push(`incorrectly named version tab "${title}" (must be exactly "${core.VERSION_TAB}")`);
    else problems.push(`unexpected tab "${title}"`);
  }
  const ids = new Map();
  for (const [title, tab] of Object.entries(tabs)) {
    if (!Number.isInteger(tab.sheetId) || tab.sheetId < 0) problems.push(`tab "${title}" has an invalid sheet ID ${tab.sheetId}`);
    else if (ids.has(tab.sheetId)) problems.push(`tabs "${ids.get(tab.sheetId)}" and "${title}" share sheet ID ${tab.sheetId}`);
    else ids.set(tab.sheetId, title);
  }
  for (const title of MANAGED) {
    const tab = tabs[title];
    if (!tab) { problems.push(`missing business tab "${title}"`); continue; }
    if (tab.hidden) problems.push(`business tab "${title}" is hidden`);
    if (JSON.stringify(tabValues(snapshot, title)[0] || []) !== JSON.stringify(Array.from(COLUMNS[title]))) problems.push(`"${title}" header differs from the SheetOps columns`);
    if (tab.columnCount < COLUMNS[title].length) problems.push(`"${title}" has ${tab.columnCount} columns; ${COLUMNS[title].length} are needed`);
  }
  const version = tabs[core.VERSION_TAB];
  if (version) {
    if (version.hidden !== VERSION_TAB_SHAPE.hidden) problems.push(`the ${core.VERSION_TAB} tab is not hidden`);
    if (version.rowCount !== VERSION_TAB_SHAPE.rowCount || version.columnCount !== VERSION_TAB_SHAPE.columnCount) {
      problems.push(`the ${core.VERSION_TAB} tab is ${version.rowCount}x${version.columnCount}, not 1x1`);
    }
    if (version.rows.some((row) => row.some((cell) => cell !== null))) problems.push(`the ${core.VERSION_TAB} tab holds values`);
    if (!(Number.isInteger(version.sheetId) && version.sheetId > core.VERSION_BASE && version.sheetId < core.VERSION_MAX)) {
      problems.push(`the ${core.VERSION_TAB} tab has sheet ID ${version.sheetId}, outside the range SheetOps creates (${core.VERSION_BASE + 1}-${core.VERSION_MAX - 1})`);
    }
  }
  if (problems.length > 0) throw new Error(`Refusing to touch this spreadsheet: ${problems.join('; ')}`);
  return version ? { state: 'initialized', version: version.sheetId } : { state: 'uninitialized', version: null };
}

function guardSpreadsheet(snapshot) {
  return classifySpreadsheet(snapshot);
}

function duplicates(values) {
  const seen = new Set();
  const dup = new Set();
  for (const value of values) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }
  return Array.from(dup);
}

function historyDuplicates(snapshot) {
  return {
    changes: duplicates(tabObjects(snapshot, core.TABS.changes).map((r) => r.event_id)),
    exceptions: duplicates(tabObjects(snapshot, core.TABS.exceptions).map((r) => r.exception_id)),
  };
}

// ---------------------------------------------------------------------------
// The oracle: what Google should hold after applying a body to a snapshot,
// computed by the fake Google (which also checks the fake against Google).
// ---------------------------------------------------------------------------

function fakeFromSnapshot(snapshot, options) {
  const o = options || {};
  const google = new FakeGoogle({ spreadsheetId: o.spreadsheetId || 'SNAPSHOT_SHEET_000000', folderId: o.folderId || 'SNAPSHOT_FOLDER_00', title: snapshot.title });
  for (const [title, tab] of Object.entries(snapshot.tabs)) {
    google.tabs.set(title, {
      sheetId: tab.sheetId, rowCount: tab.rowCount, columnCount: tab.columnCount, hidden: tab.hidden,
      rows: tab.rows.map((row) => row.map((c) => (c && 'f' in c ? { formula: c.f } : rawCell(c)))),
    });
  }
  if (o.enforceSheetChecks === false) google.enforceSheetChecks = false;
  return google;
}

function snapshotOfFake(google) {
  return normalizeSnapshot(google.handle('SHEETS_META', 'GET', snapshotRequest(google.spreadsheetId).url).body);
}

function applyToSnapshot(snapshot, body) {
  const google = fakeFromSnapshot(snapshot);
  const reply = google.batchUpdate(body);
  return { status: reply.status, snapshot: reply.status === 200 ? snapshotOfFake(google) : snapshot };
}

// Differences between two snapshots, as readable paths (empty = equal).
function diffSnapshots(a, b) {
  const out = [];
  const titles = new Set(Object.keys(a.tabs).concat(Object.keys(b.tabs)));
  for (const title of titles) {
    const x = a.tabs[title];
    const y = b.tabs[title];
    if (!x || !y) { out.push(`tab "${title}" ${x ? 'missing after' : 'added'}`); continue; }
    for (const key of ['sheetId', 'hidden', 'rowCount', 'columnCount']) if (x[key] !== y[key]) out.push(`"${title}".${key}: ${x[key]} → ${y[key]}`);
    const rows = Math.max(x.rows.length, y.rows.length);
    for (let r = 0; r < rows; r += 1) {
      if (JSON.stringify(x.rows[r] || []) !== JSON.stringify(y.rows[r] || [])) out.push(`"${title}" row ${r + 1}: ${JSON.stringify(x.rows[r] || [])} → ${JSON.stringify(y.rows[r] || [])}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test publications built with the real core, as the workflow builds them.
// ---------------------------------------------------------------------------

function testRun(runId, startedAt, fileName, fileId) {
  const batch = core.describeSourceFile({ id: fileId, name: fileName, modifiedTime: startedAt, createdTime: startedAt }, {});
  const run = { run_id: runId, mode: 'live-test', started_at: startedAt, finished_at: startedAt, queue_remaining: 0 };
  return { run, batch };
}

// A price list built from the current catalog: every ACTIVE SKU moves by
// `pct` percent (well under the 25% review limit), plus extra rows.
function shiftedCsv(snapshot, pct, extraLines) {
  const lines = ['sku,name,unit,unit_price'];
  for (const row of tabObjects(snapshot, core.TABS.catalog)) {
    if (row.status !== 'ACTIVE') continue;
    const cents = Math.round(Number(row.unit_price) * 100);
    const moved = Math.round((cents * (100 + pct)) / 100);
    lines.push([row.sku, `"${String(row.name).replace(/"/g, '""')}"`, row.unit, (moved / 100).toFixed(2)].join(','));
  }
  return lines.concat(extraLines || []).join('\n') + '\n';
}

function buildPublish(snapshot, { run, batch, csvText, runRowNumber }) {
  const { sheet, sheetMeta } = sheetInputs(snapshot);
  const plan = core.processBatch({ config: {}, batch, csvText, run, sheet, stale_runs: [] });
  const body = core.buildPublishRequest({ plan, sheetMeta, runRowNumber });
  return { plan, body, version: core.publicationVersion(sheetMeta, run.started_at) };
}

// The reset that puts a test baseline in place. It is only ever built from a
// snapshot that classifySpreadsheet() accepted, and it is itself fenced: it
// deletes the version tab it read, so it is rejected if anything moved the
// version since. It never deletes or recreates a business tab, so their sheet
// IDs are preserved. `version`:
//   'none'  → the baseline is uninitialized (the version tab is removed);
//   'fresh' → a new version tab, with an ID from the core's own rule
//             (publicationVersion) and above every ID this suite has seen.
// `startedRows` are Run Log rows (objects) written below the header.
function resetRequest(snapshot, { spreadsheetId, catalogRows, startedRows, version, now, minVersion }) {
  classifySpreadsheet(snapshot);
  if (!['none', 'fresh'].includes(version)) throw new Error(`Unknown baseline version mode ${version}`);
  const requests = [];
  const current = snapshot.tabs[core.VERSION_TAB];
  if (current) requests.push({ deleteSheet: { sheetId: current.sheetId } });
  let intendedVersion = null;
  if (version === 'fresh') {
    const { sheetMeta } = sheetInputs(snapshot);
    const rule = core.publicationVersion(sheetMeta, now);
    intendedVersion = Math.max(rule.to, (minVersion || 0) + 1);
    if (!(intendedVersion > core.VERSION_BASE && intendedVersion < core.VERSION_MAX)) throw new Error(`No valid fresh version ID (${intendedVersion})`);
    if (Object.values(snapshot.tabs).some((tab) => tab.sheetId === intendedVersion)) throw new Error(`Fresh version ID ${intendedVersion} is already in use`);
    requests.push({ addSheet: { properties: { sheetId: intendedVersion, title: core.VERSION_TAB, hidden: VERSION_TAB_SHAPE.hidden, gridProperties: { rowCount: VERSION_TAB_SHAPE.rowCount, columnCount: VERSION_TAB_SHAPE.columnCount } } } });
  }
  const contents = {
    Catalog: (catalogRows || []).map((row) => core.rowToValues(core.CATALOG_COLUMNS, row)),
    Review: [],
    Changes: [],
    Exceptions: [],
    'Run Log': (startedRows || []).map((row) => core.rowToValues(core.RUNLOG_COLUMNS, row)),
  };
  for (const title of MANAGED) {
    const tab = snapshot.tabs[title];
    const rows = [Array.from(COLUMNS[title])].concat(contents[title]);
    if (rows.length > tab.rowCount) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: rows.length - tab.rowCount } });
    requests.push({
      updateCells: {
        range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: Math.max(tab.rowCount, rows.length), startColumnIndex: 0, endColumnIndex: tab.columnCount },
        rows: rows.map((row) => ({ values: row.map(writeCell) })),
        fields: 'userEnteredValue',
      },
    });
  }
  return {
    request: { method: 'POST', url: `${SHEETS}/${spreadsheetId}:batchUpdate`, body: { requests, includeSpreadsheetInResponse: false } },
    intended: {
      state: version === 'fresh' ? 'initialized' : 'uninitialized',
      version: intendedVersion,
      sheetIds: Object.fromEntries(MANAGED.map((title) => [title, snapshot.tabs[title].sheetId])),
      rows: Object.fromEntries(MANAGED.map((title) => [title, trimRows([Array.from(COLUMNS[title])].concat(contents[title]).map((row) => row.map(normalCell)))])),
    },
  };
}

function writeCell(value) {
  if (value === '' || value === null || value === undefined) return {};
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

function normalCell(value) {
  if (value === '' || value === null || value === undefined) return null;
  return typeof value === 'number' ? { n: value } : { s: String(value) };
}

// Checks a snapshot read back after a reset against what the reset intended,
// cell by cell and type by type, without relying on the fake Google.
function baselineProblems(snapshot, intended) {
  const problems = [];
  let state;
  try {
    state = classifySpreadsheet(snapshot);
  } catch (err) {
    return [err.message];
  }
  if (state.state !== intended.state) problems.push(`state is ${state.state}, expected ${intended.state}`);
  if (state.version !== intended.version) problems.push(`version is ${state.version}, expected ${intended.version}`);
  for (const title of MANAGED) {
    const tab = snapshot.tabs[title];
    if (tab.sheetId !== intended.sheetIds[title]) problems.push(`"${title}" sheet ID changed from ${intended.sheetIds[title]} to ${tab.sheetId}`);
    const expected = intended.rows[title];
    const rows = Math.max(expected.length, tab.rows.length);
    for (let r = 0; r < rows; r += 1) {
      if (JSON.stringify(tab.rows[r] || []) !== JSON.stringify(expected[r] || [])) problems.push(`"${title}" row ${r + 1} is ${JSON.stringify(tab.rows[r] || [])}, expected ${JSON.stringify(expected[r] || [])}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The publication ledger: a write-ahead record of every write the runner sends
// to a test spreadsheet, kept on disk across runs (var/live/, gitignored).
// An entry is created before the write is sent, so a crash leaves it unknown.
//
// Outcomes, and the only evidence that establishes each:
//   not_submitted  no request could have reached Google: the STARTED row was
//                  written but its publish never sent, the n8n execution built
//                  no request, or the connection failed before it was made
//                  (ENOTFOUND, EAI_AGAIN, ECONNREFUSED);
//   rejected       Google answered 4xx (except 408): nothing was applied;
//   committed      Google answered 2xx, or the commit marker (the run's own
//                  Run Log row with its final status, written in the same
//                  atomic request) is in the spreadsheet;
//   unknown        anything else: 5xx, 408, timeouts, lost connections, a
//                  crash. Time passing never changes an unknown outcome.
// An operator may declare an unknown publication not applied; the entry then
// stays unknown, carries the declaration, and is reported as unverified.
// ---------------------------------------------------------------------------

const NOT_CONNECTED = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/;
// n8n replaces those codes with these fixed messages (n8n-workflow 2.41,
// errors/abstract/node.error.js, COMMON_ERRORS), so both forms are recognised.
const NOT_CONNECTED_MESSAGES = [
  ['ENOTFOUND', 'The connection cannot be established, this usually occurs due to an incorrect host (domain) value'],
  ['ECONNREFUSED', 'The service refused the connection - perhaps it is offline'],
  ['EAI_AGAIN', 'The DNS server returned an error, perhaps the server is offline'],
];

function outcomeOfReply(reply) {
  if (Number.isInteger(reply.status)) {
    if (reply.status >= 200 && reply.status < 300) return { outcome: 'committed', basis: `Google answered HTTP ${reply.status}` };
    if (core.classifyPublishFailure({ httpStatus: reply.status }) === 'REJECTED') return { outcome: 'rejected', basis: `Google answered HTTP ${reply.status}` };
    return { outcome: 'unknown', basis: `Google answered HTTP ${reply.status}, which does not establish the outcome` };
  }
  const text = String(reply.error || '');
  const match = NOT_CONNECTED.exec(text);
  if (match) return { outcome: 'not_submitted', basis: `the connection failed before it was made (${match[1]})` };
  const message = NOT_CONNECTED_MESSAGES.find(([, m]) => text.includes(m));
  if (message) return { outcome: 'not_submitted', basis: `the connection failed before it was made (n8n's message for ${message[0]})` };
  return { outcome: 'unknown', basis: `no answer from Google (${text || 'no response recorded'})` };
}

class Ledger {
  constructor(file, spreadsheetId, clock) {
    this.file = file;
    this.spreadsheetId = spreadsheetId;
    this.clock = clock;
    this.entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).entries : [];
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  add(fields) {
    const entry = Object.assign({
      id: `P${String(this.entries.length + 1).padStart(4, '0')}`,
      spreadsheet_id: this.spreadsheetId,
      created_at: this.clock(),
      run_id: null, run_row: null, batch_id: null, expected_status: null, planned_from: null, planned_to: null,
      operator: null, history: [],
    }, fields);
    entry.history = [{ at: this.clock(), outcome: entry.outcome, basis: entry.basis }];
    this.entries.push(entry);
    this.save();
    return entry;
  }

  update(id, patch) {
    const entry = this.entries.find((e) => e.id === id);
    Object.assign(entry, patch);
    if (patch.outcome || patch.basis) entry.history.push({ at: this.clock(), outcome: entry.outcome, basis: entry.basis });
    this.save();
    return entry;
  }

  forSheet() {
    return this.entries.filter((e) => e.spreadsheet_id === this.spreadsheetId);
  }

  byRun(runId) {
    return this.forSheet().filter((e) => e.run_id === String(runId)).pop() || null;
  }
}

// What the spreadsheet shows about one publication. Its commit marker is its
// own Run Log row with the final status it writes, in the same atomic request
// as its data, so the marker present means the publication applied.
function markerEvidence(snapshot, entry) {
  const rows = tabObjects(snapshot, core.TABS.runLog).filter((r) => String(r.run_id) === entry.run_id);
  const version = versionOf(snapshot);
  if (rows.length === 0) return { state: 'row_missing', version, text: `its Run Log row (run ${entry.run_id}) is not in the spreadsheet` };
  if (rows.length > 1) return { state: 'contradictory', version, text: `run ${entry.run_id} has ${rows.length} Run Log rows` };
  const row = rows[0];
  if (row.status === entry.expected_status && String(row.batch_id) === entry.batch_id) {
    return { state: 'committed', version, text: `its row shows ${row.status} for ${row.batch_id}${version === entry.planned_to ? `, and the version tab is ${version}, the one it creates` : ''}` };
  }
  if (row.status === 'STARTED') return { state: 'no_marker', version, text: `its row still shows STARTED and the version is ${version}` };
  return { state: 'contradictory', version, text: `its row shows ${row.status}, not the ${entry.expected_status} it would write` };
}

// The parts of a built publish request the ledger records.
function publicationFacts(body, plan) {
  const del = body.requests.find((r) => r.deleteSheet);
  const add = body.requests.find((r) => r.addSheet);
  return {
    planned_from: del ? del.deleteSheet.sheetId : null,
    planned_to: add ? add.addSheet.properties.sheetId : null,
    expected_status: plan ? plan.status : null,
  };
}

// ---------------------------------------------------------------------------
// Workflow copies for the recovery tests: the production workflow with the
// settings filled in, the CLI start path, and an optional fault on Publish.
// ---------------------------------------------------------------------------

function workflowCopy({ id, name, settings, credentialId, fault, manual }) {
  const workflow = buildWorkflow();
  workflow.id = id;
  workflow.name = name;
  workflow.nodes = workflow.nodes.filter((n) => !['Every 2 hours', 'Scheduled run'].includes(n.name));
  delete workflow.connections['Every 2 hours'];
  delete workflow.connections['Scheduled run'];
  for (const a of workflow.nodes.find((n) => n.name === 'Settings').parameters.assignments.assignments) {
    if (a.name === 'spreadsheet_id') a.value = settings.spreadsheet_id;
    if (a.name === 'inbox_folder_id') a.value = settings.inbox_folder_id;
  }
  for (const a of workflow.nodes.find((n) => n.name === 'Manual run options').parameters.assignments.assignments) {
    if (manual && a.name in manual) a.value = manual[a.name];
  }
  for (const node of workflow.nodes) {
    if (node.credentials && node.credentials.googleApi && credentialId) node.credentials.googleApi.id = credentialId;
  }
  const publish = workflow.nodes.find((n) => n.name === 'Publish');
  if (fault && fault.timeoutMs) publish.parameters.options.timeout = fault.timeoutMs;
  if (fault && fault.unreachable) publish.parameters.url = "={{ $json.http.url.replace('https://sheets.googleapis.com', 'https://sheets.googleapis.invalid') }}";
  return workflow;
}

function relayWorkflow({ id, requests, credentialId }) {
  const http = (name, method, position, withBody) => {
    const parameters = {
      method,
      url: '={{ $json.url }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleApi',
    };
    if (withBody) Object.assign(parameters, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}' });
    parameters.options = { timeout: 60000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } };
    return {
      id: `5be7c0de-1111-4000-8000-00000000000${position}`, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [660, position * 160], parameters, onError: 'continueRegularOutput',
      credentials: { googleApi: { id: credentialId || null, name: CREDENTIAL_NAME } },
    };
  };
  const items = requests.map((r, index) => ({ json: Object.assign({ index }, r) }));
  return {
    id,
    name: `SheetOps live relay ${id}`,
    nodes: [
      { id: '5be7c0de-1111-4000-8000-000000000001', name: 'Run manually', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 160], parameters: {} },
      {
        id: '5be7c0de-1111-4000-8000-000000000002', name: 'Requests', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 160],
        parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `return ${JSON.stringify(items)};\n` },
      },
      {
        id: '5be7c0de-1111-4000-8000-000000000003', name: 'By method', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [440, 160],
        parameters: { mode: 'expression', numberOutputs: 3, output: "={{ ['GET', 'POST', 'PUT'].indexOf($json.method) }}" },
      },
      http('Send GET', 'GET', 4, false),
      http('Send POST', 'POST', 5, true),
      http('Send PUT', 'PUT', 6, true),
    ],
    connections: {
      'Run manually': { main: [[{ node: 'Requests', type: 'main', index: 0 }]] },
      Requests: { main: [[{ node: 'By method', type: 'main', index: 0 }]] },
      'By method': { main: [[{ node: 'Send GET', type: 'main', index: 0 }], [{ node: 'Send POST', type: 'main', index: 0 }], [{ node: 'Send PUT', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    active: false,
  };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function liveTransport({ evidenceDir, userFolder: folder }) {
  // Tests of the plumbing pass var/n8n-verify, which holds no credential.
  const userFolder = folder || path.join(ROOT, 'var', 'n8n');
  const workflowDir = path.join(ROOT, 'var', 'live', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    N8N_USER_FOLDER: userFolder,
    N8N_RUNNERS_BROKER_PORT: '5699',
    EXECUTIONS_TIMEOUT: '300',
    GENERIC_TIMEZONE: 'Africa/Addis_Ababa',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
  });
  let counter = 0;
  let credentialId = null;

  const cli = (args) => {
    const result = spawnSync(process.env.N8N_BIN || 'n8n', args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 400000 });
    if (result.error) throw result.error;
    const out = redact(result.stdout || '');
    const err = redact(result.stderr || '');
    if (out.found + err.found > 0) {
      fs.writeFileSync(path.join(evidenceDir, `ALERT-redacted-${Date.now()}.txt`), `${out.found + err.found} secret-like strings were redacted from n8n ${args[0]} output.\n`);
    }
    return { status: result.status, stdout: out.text, stderr: err.text };
  };

  const execute = (workflow) => {
    const file = path.join(workflowDir, `${workflow.id}.json`);
    fs.writeFileSync(file, JSON.stringify(workflow));
    const imported = cli(['import:workflow', `--input=${file}`]);
    if (imported.status !== 0) throw new Error(`n8n import failed:\n${imported.stdout.slice(-2000)}\n${imported.stderr.slice(-2000)}`);
    const run = cli(['execute', `--id=${workflow.id}`, '--rawOutput']);
    const start = run.stdout.search(/^\{\s*$/m);
    if (start < 0) throw new Error(`n8n execute printed no JSON (exit ${run.status}):\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`);
    const execution = JSON.parse(run.stdout.slice(start));
    const runData = execution.data.resultData.runData;
    const outputs = new Map();
    const timing = new Map();
    for (const [name, runs] of Object.entries(runData)) {
      outputs.set(name, [].concat(...((runs[0].data && runs[0].data.main) || []).map((items) => items || [])).map((item) => item.json));
      timing.set(name, { startTime: runs[0].startTime, executionTime: runs[0].executionTime });
    }
    const error = execution.data.resultData.error ? { node: execution.data.resultData.lastNodeExecuted, message: execution.data.resultData.error.message } : null;
    return { outputs, timing, error, order: Object.keys(runData) };
  };

  return {
    kind: 'live',
    setCredentialId(id) { credentialId = id; },
    // Any n8n process (server, worker or CLI execution) running right now. The
    // runner's own CLI calls are synchronous, so none of them is ever listed.
    activeN8n() {
      const out = spawnSync('pgrep', ['-af', 'n8n'], { encoding: 'utf8' }).stdout || '';
      return out.split('\n').filter((line) => /\bn8n\b/.test(line) && /\b(start|worker|execute|webhook)\b/.test(line));
    },
    now: () => new Date().toISOString(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async send(requests) {
      counter += 1;
      const result = execute(relayWorkflow({ id: `SheetOpsLiveRelay${String(counter).padStart(3, '0')}`, requests, credentialId }));
      const byNode = { GET: result.outputs.get('Send GET') || [], POST: result.outputs.get('Send POST') || [], PUT: result.outputs.get('Send PUT') || [] };
      const used = { GET: 0, POST: 0, PUT: 0 };
      return requests.map((r) => {
        const json = byNode[r.method][used[r.method]++] || {};
        const timing = result.timing.get(`Send ${r.method}`) || {};
        return {
          status: Number.isInteger(json.statusCode) ? json.statusCode : null,
          body: json.body,
          date: json.headers && json.headers.date,
          error: json.error ? (json.error.message || JSON.stringify(json.error)) : null,
          node_start: timing.startTime,
          node_ms: timing.executionTime,
        };
      });
    },
    async runWorkflow(workflow) {
      const result = execute(Object.assign({}, workflow, { id: workflow.id }));
      const done = result.outputs.get('Done');
      return Object.assign(result, { done: done ? done[0] : null });
    },
  };
}

// Offline stand-in: the fake Google, the n8n simulator and a virtual clock.
// Concurrent requests are applied one after another, in order.
function dryTransport({ google, start, hooks }) {
  const h = hooks || {};
  let clock = Date.parse(start || '2026-11-02T07:00:00.000Z');
  let executions = 0;
  const pendingFaults = [];
  return {
    kind: 'dry',
    google,
    setCredentialId() {},
    activeN8n: () => (h.activeN8n ? h.activeN8n() : []),
    now: () => new Date(clock).toISOString(),
    wait: async (ms) => { clock += ms; },
    // The dry stand-ins for the live Publish patches.
    injectPublishFault(fault) { pendingFaults.push(fault); },
    async send(requests) {
      clock += 1000;
      if (h.beforeSend) h.beforeSend(requests, google);
      const replies = requests.map((r) => {
        try {
          const reply = google.request({ method: r.method, url: r.url, body: r.body, node: 'relay' });
          return { status: reply.status, body: reply.body, date: null, error: null, node_start: clock, node_ms: 1 };
        } catch (err) {
          if (!(err instanceof NetworkError)) throw err;
          return { status: null, body: undefined, date: null, error: err.message, node_start: clock, node_ms: 1 };
        }
      });
      if (h.afterSend) h.afterSend(requests, replies, google);
      return replies;
    },
    async runWorkflow(workflow) {
      clock += 5000;
      executions += 1;
      for (const fault of pendingFaults.splice(0)) google.inject(fault);
      const result = simulate(workflow, { google, now: new Date(clock).toISOString(), executionId: String(1000 + executions), trigger: 'Run manually' });
      const done = result.outputs.get('Done');
      return Object.assign(result, { done: done ? done[0].json : null, outputs: new Map(Array.from(result.outputs.entries()).map(([k, v]) => [k, v.map((i) => i.json)])) });
    },
  };
}

module.exports = {
  ROOT,
  SHEETS,
  redact,
  snapshotRequest,
  normalizeSnapshot,
  tabValues,
  tabObjects,
  sheetInputs,
  versionOf,
  VERSION_TAB_SHAPE,
  classifySpreadsheet,
  guardSpreadsheet,
  baselineProblems,
  outcomeOfReply,
  Ledger,
  markerEvidence,
  publicationFacts,
  historyDuplicates,
  fakeFromSnapshot,
  snapshotOfFake,
  applyToSnapshot,
  diffSnapshots,
  testRun,
  shiftedCsv,
  buildPublish,
  resetRequest,
  workflowCopy,
  relayWorkflow,
  liveTransport,
  dryTransport,
  assert,
};
