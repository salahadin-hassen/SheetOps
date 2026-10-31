'use strict';

// Generates the console's offline demo data: the five SheetOps tabs exactly as
// the real workflow leaves them in each scenario. Nothing here is written by
// hand. Each scenario runs the generated n8n workflow (workflow/build.js),
// with the real core (src/sheetops-core.js), in the offline n8n simulator
// against the fake Google (test/support), on the synthetic week-2 fixture.
//
// Usage: node scripts/generate-demo-data.cjs [--check]
//   --check  exit 1 if src/data/demo-data.json differs from a fresh generation.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'demo-data.json');
const { core, week2 } = require(path.join(ROOT, 'test', 'support', 'helpers.js'));
const { FakeGoogle } = require(path.join(ROOT, 'test', 'support', 'fake-google.js'));
const { runWorkflow } = require(path.join(ROOT, 'test', 'support', 'n8n-sim.js'));
const { buildWorkflow } = require(path.join(ROOT, 'workflow', 'build.js'));

const w = week2();
const SPREADSHEET_ID = 'SYNTH_SHEET_1234567890';
const FOLDER_ID = 'SYNTH_FOLDER_123456';
const RUN_1001_AT = '2026-10-19T07:00:00.000Z';
const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
const WEEK2_FILE = {
  id: 'drv-week2', name: 'demo-supplier_2026-10-19.csv',
  modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T05:58:00.000Z', content: w.csvText,
};
const TAB_COLUMNS = {
  Catalog: core.CATALOG_COLUMNS,
  Review: core.REVIEW_COLUMNS,
  Changes: core.CHANGES_COLUMNS,
  Exceptions: core.EXCEPTIONS_COLUMNS,
  'Run Log': core.RUNLOG_COLUMNS,
};

function workflow(manual) {
  const wf = buildWorkflow();
  const assign = (node, values) => {
    for (const a of wf.nodes.find((n) => n.name === node).parameters.assignments.assignments) if (a.name in values) a.value = values[a.name];
  };
  assign('Settings', { spreadsheet_id: SPREADSHEET_ID, inbox_folder_id: FOLDER_ID });
  if (manual) assign('Manual run options', manual);
  return wf;
}

function newGoogle() {
  const google = new FakeGoogle({ spreadsheetId: SPREADSHEET_ID, folderId: FOLDER_ID });
  const sheetIds = { Catalog: 0, Review: 101, Changes: 102, Exceptions: 103, 'Run Log': 104 };
  for (const [title, columns] of Object.entries(TAB_COLUMNS)) google.addTab(title, Array.from(columns), { sheetId: sheetIds[title] });
  for (const row of w.catalogBefore) google.tabs.get('Catalog').rows.push(core.rowToValues(core.CATALOG_COLUMNS, row));
  google.addFile(WEEK2_FILE);
  return google;
}

function run(google, { id, now, trigger = 'Every 2 hours', manual }) {
  const result = runWorkflow(workflow(manual), { google, now, executionId: id, trigger });
  if (result.error) throw new Error(`run ${id} failed in the simulator: ${result.error.message}`);
  return result.outputs.get('Done')[0].json;
}

// What a console can read: the five tabs, and nothing from n8n.
function snapshot(google) {
  return {
    spreadsheetTitle: google.title,
    tabs: Object.fromEntries(Object.keys(TAB_COLUMNS).map((tab) => [tab, google.table(tab)])),
  };
}

const scenarios = [];
const add = (id, title, description, checkedAt, google, expect) => {
  scenarios.push(Object.assign({ id, title, description, checkedAt, expect }, snapshot(google)));
};

{
  const google = newGoogle();
  add('before-first-run', 'Before the first run',
    'The synthetic spreadsheet with its starting catalog; no run has happened yet.',
    minutesAfter(RUN_1001_AT, -5), google, { runs: 0 });
}
{
  const google = newGoogle();
  const done = run(google, { id: '1001', now: RUN_1001_AT });
  add('week2-published', 'Week 2 published',
    'Run 1001 processed the week-2 list: changes applied, 3 held for review, 9 exceptions.',
    minutesAfter(RUN_1001_AT, 10), google, { lastRun: '1001', status: done.run_status });
}
{
  const google = newGoogle();
  run(google, { id: '1001', now: RUN_1001_AT });
  // An operator approves TEA-001 in the Google Sheet after run 1002 read Review
  // and before its final Review check (contract §8, v2.5).
  const tea = `RV|TEA-001|${WEEK2_FILE.id}@${WEEK2_FILE.modifiedTime}`;
  google.before('Re-read Review', (g) => {
    const row = g.tabs.get('Review').rows.find((cells) => cells[0] === tea);
    row[core.REVIEW_COLUMNS.indexOf('decision')] = 'APPROVE';
  });
  const at = minutesAfter(RUN_1001_AT, 120);
  const done = run(google, { id: '1002', now: at, trigger: 'Run manually', manual: { reprocess_latest: true } });
  if (done.code !== 'REVIEW_CHANGED') throw new Error(`expected REVIEW_CHANGED, got ${done.code}`);
  add('review-changed', 'Review changed during a run',
    'TEA-001 was approved in the Google Sheet while manual reprocess 1002 was planning. The final Review check stopped the publish: run 1002 is FAILED with REVIEW_CHANGED and the approval is kept.',
    minutesAfter(at, 5), google, { lastRun: '1002', status: done.run_status, code: done.code });
}
{
  const google = newGoogle();
  run(google, { id: '1001', now: RUN_1001_AT });
  // A manual reprocess whose publish gets no answer: Review is populated and a
  // run shows STARTED, so operators must not edit Review in the sheet.
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' });
  const at = minutesAfter(RUN_1001_AT, 120);
  const done = run(google, { id: '1002', now: at, trigger: 'Run manually', manual: { reprocess_latest: true } });
  add('review-during-run', 'Review while a run shows STARTED',
    'After run 1001 published, manual reprocess 1002 got no answer to its publish. Three minutes later its row still shows STARTED, inside the 15-minute processing window.',
    minutesAfter(at, 3), google, { lastRun: '1002', status: done.run_status, code: done.code });
}
{
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 403, body: { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } });
  const done = run(google, { id: '1001', now: RUN_1001_AT });
  add('publish-refused', 'Publish refused (HTTP 403)',
    'Google refused run 1001\'s publish. Nothing was applied; the run is FAILED with PUBLISH_REJECTED.',
    minutesAfter(RUN_1001_AT, 5), google, { lastRun: '1001', status: done.run_status, code: done.code });
}
for (const [id, title, minutes, description] of [
  ['run-started', 'Run started, no result yet', 3, 'Run 1001\'s publish got no answer. Three minutes later its row still shows STARTED: inside the 15-minute processing window.'],
  ['outcome-unknown', 'Outcome unknown', 21, 'Run 1001\'s publish got no answer (HTTP 503). Twenty-one minutes later its row still shows STARTED: an unresolved publication.'],
]) {
  const google = newGoogle();
  google.inject({ kind: 'BATCH_UPDATE', type: 'status', status: 503, body: 'Service Unavailable' });
  const done = run(google, { id: '1001', now: RUN_1001_AT });
  add(id, title, description, minutesAfter(RUN_1001_AT, minutes), google, { lastRun: '1001', status: done.run_status, code: done.code });
}

const data = {
  generatedBy: 'frontend/scripts/generate-demo-data.cjs',
  source: 'Synthetic week-2 fixture, processed by src/sheetops-core.js in the offline n8n simulator (test/support). No Google, no n8n server.',
  scenarios,
};
const text = `${JSON.stringify(data, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (current !== text) { console.error('demo-data.json is stale: run npm run data'); process.exit(1); }
  console.log('demo-data.json matches a fresh generation');
} else {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}: ${scenarios.map((s) => s.id).join(', ')}`);
}
