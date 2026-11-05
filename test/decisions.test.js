'use strict';

// Owner decisions of November 2026 (contract §1, §8, §10): Changes order,
// bounded Exceptions.raw_value, strict UTF-8, typed Review decisions only.
// Core tests plus the real workflow JSON in the simulator against a fake Google.
// SIMULATED: no network, no Google, no n8n. Live checks: docs/setup.md §5.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { core, week2, sheetState, makeBatch, tableValues, WEEK2_BATCH_ID } = require('./support/helpers.js');
const { FakeGoogle } = require('./support/fake-google.js');
const { runWorkflow } = require('./support/n8n-sim.js');
const { buildWorkflow } = require('../workflow/build.js');

const w = week2();
const SPREADSHEET_ID = 'SHEET_ID_1234567890abcdef';
const FOLDER_ID = 'FOLDER_ID_123456';
const NOW = '2026-10-19T07:00:00.000Z';
const LATER = (minutes) => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
const FILE = {
  id: 'drv-week2', name: 'demo-supplier_2026-10-19.csv',
  modifiedTime: '2026-10-19T06:00:00.000Z', createdTime: '2026-10-19T05:58:00.000Z', content: w.csvText,
};
const META = Object.fromEntries(['Catalog', 'Review', 'Changes', 'Exceptions', 'Run Log'].map((t, i) => [t, { sheetId: i, rowCount: 200, columnCount: 30 }]));
const MAX = core.DEFAULT_CONFIG.max_exception_text_length;
const HEADER = 'sku,name,unit,unit_price\n';

const cat = (sku, price) => ({
  sku, name: `Item ${sku}`, unit: 'each', unit_price: price, currency: 'ETB', status: 'ACTIVE', previous_price: '',
  first_seen: '2026-10-05', last_seen: '2026-10-12', last_changed: '2026-10-05', pending_review: '', last_issue: '',
});
const base64 = (buffer) => Buffer.from(buffer).toString('base64');
const process = (input, state) => core.processBatch(Object.assign({
  config: {}, batch: makeBatch(), run: { run_id: 'r1', started_at: '2026-10-26T07:00:00.000Z' }, sheet: sheetState(state || { catalog: [cat('AB-1', 100)] }),
}, input));

function configured(manual) {
  const workflow = buildWorkflow();
  const assign = (name, values) => {
    for (const a of workflow.nodes.find((n) => n.name === name).parameters.assignments.assignments) if (a.name in values) a.value = values[a.name];
  };
  assign('Settings', { spreadsheet_id: SPREADSHEET_ID, inbox_folder_id: FOLDER_ID });
  if (manual) assign('Manual run options', manual);
  return workflow;
}
function newGoogle(files) {
  const google = new FakeGoogle({ spreadsheetId: SPREADSHEET_ID, folderId: FOLDER_ID });
  const tab = (title, columns, sheetId, rows) => {
    google.addTab(title, Array.from(columns), { sheetId });
    for (const row of rows) google.tabs.get(title).rows.push(core.rowToValues(columns, row));
  };
  tab('Catalog', core.CATALOG_COLUMNS, 0, w.catalogBefore);
  tab('Review', core.REVIEW_COLUMNS, 101, []);
  tab('Changes', core.CHANGES_COLUMNS, 102, []);
  tab('Exceptions', core.EXCEPTIONS_COLUMNS, 103, []);
  tab('Run Log', core.RUNLOG_COLUMNS, 104, []);
  for (const file of files || [FILE]) google.addFile(file);
  return google;
}
function run(google, opts) {
  const o = Object.assign({ now: NOW, id: '1' }, opts);
  const result = runWorkflow(configured(o.manual), { google, now: o.now, executionId: o.id, trigger: o.manual ? 'Run manually' : 'Every 2 hours' });
  const done = result.outputs.get('Done');
  return Object.assign(result, { done: done ? done[0].json : null });
}
const published = (google) => google.log.some((e) => e.kind === 'BATCH_UPDATE');
const reprocess = { reprocess_latest: true };
const COL = core.REVIEW_COLUMNS.indexOf('decision');
const teaRow = (google) => google.tabs.get('Review').rows.find((row) => row[0] === `RV|TEA-001|${WEEK2_BATCH_ID}`);
const teaUnit = (google) => google.table('Catalog').find((r) => r.sku === 'TEA-001').unit;

// ---- Decision 1: Changes order --------------------------------------------

test('decision 1: within a SKU REVIEW_SUPERSEDED comes first, and the order does not depend on the file order', () => {
  const item = {
    review_id: 'RV|AB-1|drv-old@2026-10-19T06:00:00.000Z', sku: 'AB-1', status: 'PENDING', reasons: 'LARGE_PRICE_CHANGE',
    current_name: 'Item AB-1', current_unit: 'each', current_price: 100, proposed_name: 'Item AB-1', proposed_unit: 'each', proposed_price: 200,
    change_pct: '', first_seen: '2026-10-19', last_seen: '2026-10-19', source_row: 2, decision: '', note: '',
  };
  const state = { catalog: [cat('AB-1', 100), cat('CD-2', 100), cat('EF-3', 100)], review: [item] };
  const rows = ['AB-1,New name,box,300.00', 'CD-2,Item CD-2,each,110.00', 'EF-3,Item EF-3,each,100.00', 'GH-4,Added,each,5.00'];
  const order = (lines) => process({ csvText: HEADER + lines.join('\n') }, state).writes.changes;
  const changes = order(rows);
  assert.deepEqual(changes.map((c) => [c.sku, c.change_type]), [
    ['AB-1', 'REVIEW_SUPERSEDED'], ['AB-1', 'PRICE_CHANGED'], ['AB-1', 'UNIT_CHANGED'], ['AB-1', 'NAME_CHANGED'],
    ['CD-2', 'PRICE_CHANGED'], ['GH-4', 'NEW_ITEM'],
  ]);
  assert.deepEqual(order(rows.slice().reverse()).map((c) => c.event_id), changes.map((c) => c.event_id));
});

test('decision 1: the contract states the order the code uses', () => {
  const contract = fs.readFileSync(path.join(__dirname, '..', 'docs', 'data-contract.md'), 'utf8');
  assert.match(contract, /Rows are sorted by sku, then change type in this order: REVIEW_SUPERSEDED, NEW_ITEM, REACTIVATED, PRICE_CHANGED,\s+UNIT_CHANGED, NAME_CHANGED, DISCONTINUED/);
});

// ---- Decision 2: bounded raw_value ----------------------------------------

test('decision 2: up to the limit the value is verbatim; above it, a prefix, the marker and the original length', () => {
  assert.equal(MAX < 50000, true);
  assert.equal(core.boundedText('abc', MAX), 'abc');
  const exact = 'x'.repeat(MAX);
  assert.equal(core.boundedText(exact, MAX), exact);
  const out = core.boundedText(`${exact}y`, MAX);
  assert.equal(out.length, MAX);
  assert.ok(out.startsWith('xxxx'));
  assert.match(out, /x \[TRUNCATED\] original length 40001 characters$/);
});

test('decision 2: a surrogate pair is never split, and the length counts characters', () => {
  const marker = ' [TRUNCATED] original length 30000 characters';
  for (const shift of [0, 1]) {
    // Shift by one unit, so the cut falls on either half of a pair.
    const text = 'a'.repeat(shift) + '😀'.repeat(30000);
    const out = core.boundedText(text, MAX);
    assert.ok(out.length <= MAX);
    const prefix = out.slice(0, out.indexOf(' [TRUNCATED]'));
    assert.ok(text.startsWith(prefix));
    assert.ok(prefix.isWellFormed(), 'no lone surrogate');
    assert.ok(out.isWellFormed());
    assert.ok(out.endsWith(shift === 0 ? marker : marker.replace('30000', '30001')));
  }
});

test('decision 2: an oversized rejected value is bounded and traceable, and still rejected', () => {
  const huge = 'N'.repeat(60000);
  const plan = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\nCD-2,${huge},each,5.00` });
  const [e] = plan.writes.exceptions;
  assert.equal(e.code, 'NAME_TOO_LONG');
  assert.equal(e.action, 'NOT_ADDED');
  assert.deepEqual([e.source_file, e.source_row], ['demo-supplier_2026-10-26.csv', 3]);
  assert.ok(e.raw_value.length <= MAX);
  assert.ok(e.raw_value.startsWith('NNN'));
  assert.match(e.raw_value, /\[TRUNCATED\] original length 60000 characters$/);
  assert.ok(!plan.writes.catalog.some((c) => c.sku === 'CD-2'), 'the row is not accepted');
  const body = core.buildPublishRequest({ plan, sheetMeta: META, runRowNumber: 2 });
  const longest = Math.max(...JSON.stringify(body).split('"').map((part) => part.length));
  assert.ok(longest < 50000, 'no string in the publish reaches the cell limit');
});

test('decision 2: only the three Exceptions cells are bounded; a long operator note and the file itself are untouched', () => {
  const note = 'n'.repeat(MAX + 500);
  const item = {
    review_id: 'RV|AB-1|drv-old@2026-10-19T06:00:00.000Z', sku: 'AB-1', status: 'PENDING', reasons: 'LARGE_PRICE_CHANGE',
    current_name: 'Item AB-1', current_unit: 'each', current_price: 100, proposed_name: 'Item AB-1', proposed_unit: 'each', proposed_price: 200,
    change_pct: '', first_seen: '2026-10-19', last_seen: '2026-10-19', source_row: 2, decision: '', note,
  };
  const plan = process({ csvText: `${HEADER}AB-1,Item AB-1,each,200.00` }, { catalog: [cat('AB-1', 100)], review: [item] });
  assert.equal(plan.writes.review[0].note, note);
  // SheetOps only ever reads the supplier's file.
  const google = newGoogle();
  run(google);
  assert.equal(google.files[0].content, w.csvText);
  assert.ok(google.log.filter((e) => e.kind.startsWith('DRIVE')).every((e) => e.method === 'GET'));
});

// ---- Bounded sku_raw and message -------------------------------------------

const huge = (n) => 'Z'.repeat(n);
const bySku = (plan, code) => plan.writes.exceptions.find((e) => e.code === code);

test('sku_raw and message are bounded with the exact marker, the original length and full traceability', () => {
  const plan = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${huge(60000)},Name,each,5.00` });
  const e = bySku(plan, 'INVALID_SKU');
  const marker = ' [TRUNCATED] original length 60000 characters';
  assert.equal(e.sku_raw.length, MAX);
  assert.ok(e.sku_raw.endsWith(`ZZZ${marker}`));
  assert.ok(e.raw_value.endsWith(`ZZZ${marker}`));
  assert.equal(e.raw_value.length, MAX);
  assert.deepEqual([e.source_file, e.source_row, e.action], ['demo-supplier_2026-10-26.csv', 3, 'NOT_ADDED']);
  // The message keeps its meaning: the value is shortened where it is quoted.
  assert.ok(e.message.startsWith('SKU "ZZZ'));
  assert.ok(e.message.endsWith(`ZZZ${marker}" does not match the allowed pattern`));
  assert.ok(e.message.length <= MAX);
});

test('every message that quotes a supplier value keeps its explanation when the value is huge', () => {
  const cases = [
    [`AB-1,Item AB-1,${huge(60000)},5.00`, 'UNKNOWN_UNIT', /^Unit "Z+ \[TRUNCATED\] original length 60000 characters" is not one of each, /],
    [`AB-1,Item AB-1,each,${huge(60000)}`, 'INVALID_PRICE', /^Price "Z+ \[TRUNCATED\] original length 60000 characters" is not a positive amount/],
    [`AB-1,Item AB-1,each,1,${'1'.repeat(1)}`, 'FIELD_COUNT_MISMATCH', /^Row has 5 fields; the header has 4$/],
  ];
  for (const [row, code, pattern] of cases) {
    const e = bySku(process({ csvText: HEADER + row }), code);
    assert.match(e.message, pattern, code);
    assert.ok(e.message.length <= MAX, code);
  }
  const currency = process({ csvText: `sku,name,unit,unit_price,currency\nAB-1,Item AB-1,each,5.00,${huge(60000)}` });
  assert.match(bySku(currency, 'CURRENCY_MISMATCH').message, /^Currency "Z+ \[TRUNCATED\] original length 60000 characters" is not ETB$/);
  const ambiguous = process({ csvText: `${HEADER}AB-1,Item AB-1,each,"${'1'.repeat(60000)},5"` });
  assert.match(bySku(ambiguous, 'AMBIGUOUS_PRICE').message, /^Price "1+ \[TRUNCATED\] original length 60002 characters" may use a decimal comma; not guessed$/);
});

test('boundaries: at the limit nothing changes; one over is marked; a short message is unchanged', () => {
  const at = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${huge(MAX)},Name,each,5.00` });
  assert.equal(bySku(at, 'INVALID_SKU').sku_raw, huge(MAX));
  assert.ok(!bySku(at, 'INVALID_SKU').sku_raw.includes('[TRUNCATED]'));
  const over = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${huge(MAX + 1)},Name,each,5.00` });
  assert.match(bySku(over, 'INVALID_SKU').sku_raw, /\[TRUNCATED\] original length 40001 characters$/);
  const small = process({ csvText: `${HEADER}A,Name,each,5.00\nAB-1,Item AB-1,each,100.00` });
  assert.equal(bySku(small, 'INVALID_SKU').message, 'SKU "A" does not match the allowed pattern');
  // A value too long to quote whole but short enough for raw_value keeps raw_value verbatim.
  const between = process({ csvText: `${HEADER}AB-1,Item AB-1,${huge(39500)},5.00` });
  const e = bySku(between, 'UNKNOWN_UNIT');
  assert.equal(e.raw_value, huge(39500));
  assert.match(e.message, /\[TRUNCATED\] original length 39500 characters" is not one of/);
});

test('Unicode: no bounded cell ever ends in half a surrogate pair, and lengths count characters', () => {
  for (const shift of [0, 1]) {
    const value = 'a'.repeat(shift) + '😀'.repeat(30000);
    const plan = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${value},Name,each,5.00` });
    const e = bySku(plan, 'INVALID_SKU');
    for (const cell of [e.sku_raw, e.raw_value, e.message]) {
      assert.ok(cell.isWellFormed());
      assert.ok(cell.length <= MAX);
      assert.ok(cell.includes(`[TRUNCATED] original length ${30000 + shift} characters`));
    }
  }
});

test('a huge cell cannot change identity, deduplication or a decision', () => {
  const longPrefix = huge(50000);
  // Two different SKU cells with the same bounded prefix stay two rows with their own IDs.
  const plan = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${longPrefix}A,Name,each,5.00\n${longPrefix}B,Name,each,5.00` });
  const rows = plan.writes.exceptions.filter((e) => e.code === 'INVALID_SKU');
  assert.deepEqual(rows.map((e) => e.source_row), [3, 4]);
  assert.equal(new Set(rows.map((e) => e.exception_id)).size, 2);
  for (const e of rows) assert.ok(e.exception_id.length < 100, 'the ID holds no supplier text');
  assert.ok(!plan.writes.catalog.some((c) => c.sku.startsWith('Z')), 'an invalid SKU is never added');
  // Replaying with the same IDs present adds nothing.
  const again = process({ csvText: `${HEADER}AB-1,Item AB-1,each,100.00\n${longPrefix}A,Name,each,5.00\n${longPrefix}B,Name,each,5.00` },
    { catalog: [cat('AB-1', 100)], exceptionIds: plan.writes.exceptions.map((e) => e.exception_id) });
  assert.deepEqual(again.writes.exceptions, []);
  // A valid SKU with a huge rejected field is still present, so it is held, not discontinued.
  const held = process({ csvText: `${HEADER}AB-1,${huge(60000)},each,100.00` });
  assert.equal(held.writes.catalog.find((c) => c.sku === 'AB-1').status, 'ACTIVE');
  assert.equal(held.summary.rejected, 1);
  // Values that reach the catalog or Review are validated whole, never shortened.
  const name200 = 'N'.repeat(200);
  assert.equal(process({ csvText: `${HEADER}CD-2,${name200},each,1.00\nAB-1,Item AB-1,each,100.00` }).writes.catalog.find((c) => c.sku === 'CD-2').name, name200);
  assert.equal(process({ csvText: `${HEADER}CD-2,${'N'.repeat(201)},each,1.00\nAB-1,Item AB-1,each,100.00` }).summary.rejected, 1);
});

test('audit: nothing derived from the file can reach the cell limit in any other column', () => {
  // The worst last_issue: the most rows, each with every kind of field error, for one SKU.
  const rows = [];
  for (let i = 0; i < core.DEFAULT_CONFIG.max_data_rows; i += 1) rows.push('AB-1,,,bad,USD');
  const plan = process({ csvText: `sku,name,unit,unit_price,currency\n${rows.join('\n')}` });
  const issue = plan.writes.catalog.find((c) => c.sku === 'AB-1').last_issue;
  assert.match(issue, /MISSING_NAME/);
  assert.ok(issue.length < 50000, `last_issue is ${issue.length} characters`);
  for (const tab of ['catalog', 'review', 'changes', 'exceptions']) {
    for (const row of plan.writes[tab] || []) {
      for (const [column, value] of Object.entries(row)) assert.ok(String(value).length < 50000, `${tab}.${column}`);
    }
  }
  assert.ok(String(plan.run_row.error_message).length <= core.DEFAULT_CONFIG.max_message_length);
});

test('a message that quotes a huge file name is bounded too, and the file name itself stays whole', () => {
  const name = 'x'.repeat(60000);
  const batch = core.describeSourceFile({ id: 'drv-test', name, modifiedTime: '2026-10-26T06:00:00.000Z', createdTime: '2026-10-26T05:00:00.000Z' }, {});
  assert.equal(batch.reject_code, 'BAD_FILENAME');
  const plan = core.planFileRejection({ config: {}, batch, run: { run_id: 'r1' }, sheet: sheetState({}), code: batch.reject_code, message: batch.reject_message });
  const [e] = plan.writes.exceptions;
  assert.equal(e.message.length, MAX);
  assert.match(e.message, /\[TRUNCATED\] original length 60\d{3} characters$/);
  assert.equal(e.raw_value.length, MAX);
  assert.equal(e.source_file, name, 'source_file is the traceability link: not shortened');
  assert.ok(plan.run_row.error_message.length <= 500);
});

test('the Run Log message limit still holds and never splits a surrogate pair', () => {
  for (const shift of [0, 1]) {
    const failed = core.buildFailedRunRow({ run_id: 'r1' }, makeBatch(), 'X', 'a'.repeat(shift) + '😀'.repeat(400));
    assert.ok(failed.error_message.length <= 500);
    assert.ok(failed.error_message.endsWith('...'));
    assert.ok(failed.error_message.isWellFormed());
  }
});

test('workflow: oversized cells publish through the real workflow, within limits, with the file untouched', () => {
  const big = Buffer.from(`${HEADER}${huge(60000)},Name,each,5.00\n${w.csvText.split('\n').slice(1).join('\n')}`);
  const google = newGoogle([Object.assign({}, FILE, { content: big })]);
  const result = run(google);
  assert.equal(result.error, null);
  assert.equal(result.done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  const e = google.table('Exceptions').find((x) => x.code === 'INVALID_SKU');
  assert.equal(e.sku_raw.length, MAX);
  assert.deepEqual([e.source_file, e.source_row], [FILE.name, 2]);
  assert.deepEqual(google.files[0].content, big);
});

// ---- Decision 3: strict UTF-8 ---------------------------------------------

test('decision 3: every class of invalid sequence is refused at its first bad byte', () => {
  const invalid = [
    [[0x80], 0], [[0xbf], 0], [[0xc0, 0x80], 0], [[0xc1, 0xbf], 0], [[0xc3], 0], [[0xc3, 0x28], 0],
    [[0xe0, 0x80, 0x80], 0], [[0xe2, 0x82], 0], [[0xed, 0xa0, 0x80], 0], [[0xf0, 0x80, 0x80, 0x80], 0],
    [[0xf0, 0x9f, 0x98], 0], [[0xf4, 0x90, 0x80, 0x80], 0], [[0xf5, 0x80, 0x80, 0x80], 0], [[0xff], 0],
    [[0x61, 0x62, 0xe9, 0x63], 2],
  ];
  for (const [bytes, at] of invalid) assert.deepEqual(core.decodeUtf8Strict(Uint8Array.from(bytes)), { invalid_at: at }, bytes.join());
});

test('decision 3: the decoder agrees with a strict reference decoder on random bytes and text', () => {
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let seed = 7;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const samples = ['', 'plain', 'é', 'ሰላም', '😀', '﻿a,b', 'a�b', '\u{10ffff}\u{800}߿\u0080'];
  for (let i = 0; i < 3000; i += 1) {
    const bytes = Uint8Array.from({ length: next(8) }, () => (next(3) === 0 ? next(256) : [0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0xed, 0xf4][next(12)]));
    let expected = null;
    try { expected = strict.decode(bytes); } catch { /* invalid */ }
    const got = core.decodeUtf8Strict(bytes);
    if (expected === null) assert.notEqual(got.invalid_at, undefined, Array.from(bytes).join());
    else assert.equal(got.text, expected, Array.from(bytes).join());
  }
  for (const text of samples) assert.equal(core.decodeUtf8Strict(Buffer.from(text, 'utf8')).text, text);
  const long = 'ሰ😀a'.repeat(20000);
  assert.equal(core.decodeUtf8Strict(Buffer.from(long, 'utf8')).text, long);
});

test('decision 3: base64 is decoded exactly and malformed base64 is a failed download, not a rejected file', () => {
  for (let n = 0; n < 300; n += 1) {
    const bytes = Buffer.from(Array.from({ length: n }, (unused, i) => (i * 37 + n) % 256));
    assert.deepEqual(Buffer.from(core.decodeBase64(bytes.toString('base64'))), bytes);
  }
  for (const bad of ['abc', 'a===', 'ab=c', 'ab c', 'é===', null, undefined, 5]) assert.equal(core.decodeBase64(bad), null, String(bad));
  assert.throws(() => process({ csvBase64: 'not base64!' }), (err) => err.code === 'DOWNLOAD_FAILED');
});

test('decision 3: an invalid file is rejected whole, with nothing partly processed', () => {
  const good = 'AB-1,Item AB-1,each,250.00\nCD-2,New,each,5.00\n';
  const plan = process({ csvBase64: base64(Buffer.concat([Buffer.from(HEADER + good), Buffer.from('EF-3,Caf'), Buffer.from([0xe9]), Buffer.from(',each,1.00\n')])) });
  assert.equal(plan.status, 'REJECTED_FILE');
  assert.deepEqual([plan.writes.catalog, plan.writes.review, plan.writes.changes], [null, null, []]);
  assert.deepEqual(plan.row_outcomes, []);
  assert.equal(plan.writes.exceptions.length, 1);
  const [e] = plan.writes.exceptions;
  assert.deepEqual([e.code, e.severity, e.action, e.source_row], ['INVALID_ENCODING', 'ERROR', 'FILE_NOT_PROCESSED', 0]);
  assert.match(e.raw_value, /^byte \d+$/);
  assert.ok(!JSON.stringify(plan).includes('�'), 'no replacement character anywhere');
  assert.equal(plan.run_row.error_code, 'INVALID_ENCODING');
});

test('decision 3: BOM and non-ASCII text are accepted; a BOM changes nothing; an encoded U+FFFD is valid', () => {
  const csv = `${HEADER}AB-1,ጤፍ ዱቄት 😀,each,100.00\n`;
  const state = { catalog: [] };
  const plain = process({ csvBase64: base64(Buffer.from(csv)) }, state);
  const bom = process({ csvBase64: base64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)])) }, state);
  assert.equal(plain.writes.catalog[0].name, 'ጤፍ ዱቄት 😀');
  assert.deepEqual(bom.writes.catalog, plain.writes.catalog);
  assert.equal(bom.status, plain.status);
  const fffd = process({ csvBase64: base64(Buffer.from(`${HEADER}AB-1,a�b,each,1.00\n`)) }, state);
  assert.equal(fffd.writes.catalog[0].name, 'a�b');
});

test('decision 3: limits use the real byte count; an empty file is still FILE_EMPTY', () => {
  assert.equal(process({ csvBase64: '' }).run_row.error_code, 'FILE_EMPTY');
  const over = process({ csvBase64: base64(Buffer.alloc(core.DEFAULT_CONFIG.max_file_bytes + 1, 0xff)) });
  assert.equal(over.run_row.error_code, 'FILE_TOO_LARGE');
});

test('decision 3, workflow: Latin-1 bytes reject the file, change no business tab, and the rejection is reported once', () => {
  const google = newGoogle([Object.assign({}, FILE, { content: Buffer.concat([Buffer.from(w.csvText), Buffer.from([0xe9])]) })]);
  const result = run(google);
  assert.equal(result.error, null);
  assert.deepEqual([result.done.run_status], ['REJECTED_FILE']);
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
  assert.deepEqual(google.table('Review'), []);
  assert.deepEqual(google.table('Changes'), []);
  assert.deepEqual(google.table('Exceptions').map((e) => e.code), ['INVALID_ENCODING']);
  assert.ok(!google.log.some((e) => e.node === 'Re-read Review'), 'a rejected plan writes no Review');
  assert.equal(run(google, { now: LATER(120), id: '2' }).done.action, 'IDLE');
});

test('decision 3, workflow: the file reaches the core as bytes; the download is never decoded as text', () => {
  const wf = buildWorkflow();
  const download = wf.nodes.find((n) => n.name === 'Download CSV');
  assert.equal(download.parameters.options.response.response.responseFormat, 'file');
  assert.deepEqual(wf.connections['Download CSV'].main, [[{ node: 'Encode CSV', type: 'main', index: 0 }]]);
  const encode = wf.nodes.find((n) => n.name === 'Encode CSV');
  assert.deepEqual([encode.type, encode.parameters.operation], ['n8n-nodes-base.extractFromFile', 'binaryToPropery']);
  const plan = wf.nodes.find((n) => n.name === 'Plan and build').parameters.jsCode;
  assert.match(plan, /csvBase64: file\.csv_base64/);
  assert.doesNotMatch(plan, /csvText: download/);
  // A BOM and non-ASCII names pass through the whole workflow.
  const google = newGoogle([Object.assign({}, FILE, { content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(w.csvText)]) })]);
  assert.equal(run(google).done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.deepEqual(google.table('Catalog'), w.expected.catalog);
});

// ---- Decision 4: typed decisions only --------------------------------------

const cells = (...values) => ({ sheets: [{ data: [{ startColumn: COL, rowData: values.map((v) => (v === null ? {} : { values: [v] })) }] }] });
const typed = (s) => ({ userEnteredValue: { stringValue: s }, effectiveValue: { stringValue: s } });
const readOf = (...decisions) => ({
  values: [Array.from(core.REVIEW_COLUMNS)].concat(decisions.map((d) => {
    const row = Array(COL).fill('x');
    row[1] = 'AB-1';
    return d === undefined ? row : row.concat([d]);
  })),
});
const check = (decisionCells, finalRead) => core.checkReviewDecisionsLiteral({ finalRead, decisionCells });
const notLiteral = (pattern) => (err) => err.code === 'REVIEW_DECISION_NOT_LITERAL' && pattern.test(err.detail) && /Nothing was published/.test(err.detail);
const readFailed = (err) => err.code === 'REVIEW_READ_FAILED' && /Nothing was published/.test(err.detail);

test('decision 4: typed values of any kind pass, whatever they say', () => {
  assert.deepEqual(check(cells(typed('decision'), typed('APPROVE'), null, typed('approve '), typed('=UPPER("x")')),
    readOf('APPROVE', undefined, 'approve ', '=UPPER("x")')), { rows: 5 });
  check(cells(typed('decision'), { userEnteredValue: { numberValue: 5 } }, { userEnteredValue: { boolValue: false } }), readOf(5, false));
  check(cells(typed('decision')), readOf());
});

test('decision 4: a formula is refused whatever it evaluates to, including nothing at all', () => {
  const formula = (result) => ({ userEnteredValue: { formulaValue: '=F()' }, effectiveValue: { stringValue: result } });
  assert.throws(() => check(cells(typed('decision'), formula('APPROVE')), readOf('APPROVE')), notLiteral(/row 2 \(AB-1\) holds a formula/));
  // Shows nothing today, could show APPROVE tomorrow.
  assert.throws(() => check(cells(typed('decision'), { userEnteredValue: { formulaValue: '=IF(FALSE,"APPROVE","")' } }), readOf()), notLiteral(/row 2 holds a formula/));
  assert.throws(() => check(cells({ userEnteredValue: { formulaValue: '="decision"' } }), readOf()), notLiteral(/row 1/));
});

test('decision 4: a value with nothing typed behind it, as an array formula leaves, is refused', () => {
  assert.throws(() => check(cells(typed('decision'), { effectiveValue: { stringValue: 'APPROVE' } }), readOf('APPROVE')), notLiteral(/nobody typed/));
  assert.throws(() => check(cells(typed('decision'), null), readOf('APPROVE')), notLiteral(/nobody typed/));
  assert.throws(() => check(cells(typed('decision')), readOf('APPROVE')), notLiteral(/nobody typed/));
});

test('decision 4: anything ambiguous is refused, and an unusable read fails closed', () => {
  assert.throws(() => check(cells(typed('decision'), typed('APPROVE')), readOf('')), notLiteral(/does not match/));
  assert.throws(() => check(cells(typed('decision'), typed('note')), readOf('APPROVE')), notLiteral(/does not match/));
  assert.throws(() => check(cells(typed('decision'), { userEnteredValue: { errorValue: { type: 'REF' } } }), readOf('x')), notLiteral(/other than a typed/));
  assert.throws(() => check(cells(typed('decision'), { userEnteredValue: {} }), readOf('')), notLiteral(/other than a typed/));
  const ok = cells(typed('decision'));
  for (const bad of [undefined, { error: { message: 'boom' } }, {}, { sheets: [] }, { sheets: [{}] }, { sheets: [{ data: [] }] },
    { sheets: [{ data: [{ startColumn: 0, rowData: [] }] }] }, { sheets: [{ data: [{ rowData: [] }] }] },
    { sheets: [{ data: [{ startRow: 1, startColumn: COL }] }] }, { sheets: [{ data: [{ startColumn: COL, rowData: 'x' }] }] },
    { sheets: [{ data: [{ startColumn: COL }, { startColumn: COL }] }] }]) {
    assert.throws(() => check(bad, readOf()), readFailed, JSON.stringify(bad));
  }
  assert.throws(() => check(ok, { error: { message: 'boom' } }), readFailed);
});

test('decision 4, workflow: a typed APPROVE still applies, in any case', () => {
  for (const decision of ['APPROVE', ' approve ']) {
    const google = newGoogle();
    run(google);
    teaRow(google)[COL] = decision;
    const again = run(google, { manual: reprocess, now: LATER(240), id: '2' });
    assert.equal(again.done.run_status, 'SUCCESS_WITH_EXCEPTIONS', decision);
    assert.equal(teaUnit(google), 'box', decision);
  }
});

test('decision 4, workflow: a formula showing APPROVE applies nothing, sends no publish, and is not stored as typed text', () => {
  const google = newGoogle();
  run(google);
  const formula = { formula: '=UPPER("approve")', value: 'APPROVE' };
  teaRow(google)[COL] = formula;
  google.log = [];
  const aborted = run(google, { manual: reprocess, now: LATER(240), id: '2' });
  assert.deepEqual([aborted.done.run_status, aborted.done.code], ['FAILED', 'REVIEW_DECISION_NOT_LITERAL']);
  assert.match(aborted.done.message, /TEA-001.*holds a formula/);
  assert.ok(!published(google), 'no publish request was sent');
  assert.equal(teaUnit(google), 'pack');
  assert.deepEqual(teaRow(google)[COL], formula, 'the cell is left as it was: a later run cannot read it as typed');
  // Again: the cell is still a formula, so it still cannot count.
  assert.equal(run(google, { manual: reprocess, now: LATER(480), id: '3' }).done.code, 'REVIEW_DECISION_NOT_LITERAL');
  assert.equal(teaUnit(google), 'pack');
  // Once a person types it, it applies.
  teaRow(google)[COL] = 'APPROVE';
  assert.equal(run(google, { manual: reprocess, now: LATER(720), id: '4' }).done.run_status, 'SUCCESS_WITH_EXCEPTIONS');
  assert.equal(teaUnit(google), 'box');
});

test('decision 4, workflow: a spilled APPROVE, and a formula showing nothing, also stop the publish', () => {
  for (const value of [{ spilled: true, value: 'APPROVE' }, { formula: '=IF(FALSE,"APPROVE","")', value: '' }]) {
    const google = newGoogle();
    run(google);
    teaRow(google)[COL] = value;
    google.log = [];
    assert.equal(run(google, { manual: reprocess, now: LATER(240), id: '2' }).done.code, 'REVIEW_DECISION_NOT_LITERAL');
    assert.ok(!published(google));
  }
});

test('decision 4, workflow: a formula added while the run is planning is caught at the final check', () => {
  const google = newGoogle();
  run(google);
  google.before('Read Review decisions', () => { teaRow(google)[COL] = { formula: '=F()', value: '' }; });
  google.log = [];
  assert.equal(run(google, { manual: reprocess, now: LATER(240), id: '2' }).done.code, 'REVIEW_DECISION_NOT_LITERAL');
  assert.ok(!published(google));
});

test('decision 4, workflow: a failed decision-cell read publishes nothing, after three tries', () => {
  const google = newGoogle();
  google.inject({ kind: 'SHEETS_CELLS', type: 'status', status: 503, body: 'Service Unavailable', times: 3 });
  const aborted = run(google);
  assert.deepEqual([aborted.done.run_status, aborted.done.code], ['FAILED', 'REVIEW_READ_FAILED']);
  assert.equal(google.log.filter((e) => e.node === 'Read Review decisions').length, 3);
  assert.ok(!published(google));
  assert.deepEqual(google.table('Catalog'), w.catalogBefore);
});

test('decision 4: the check asks Google what the cell holds, for the decision column', () => {
  const requests = core.buildGoogleRequests({ spreadsheet_id: SPREADSHEET_ID, inbox_folder_id: FOLDER_ID, supplier: 'demo-supplier', currency: 'ETB' });
  const url = new URL(requests.read_review_decisions);
  assert.equal(url.searchParams.get('ranges'), "'Review'!O1:O");
  assert.match(url.searchParams.get('fields'), /userEnteredValue/);
  assert.equal(core.REVIEW_COLUMNS[14], 'decision');
  assert.equal(tableValues(core.REVIEW_COLUMNS, [])[0][14], 'decision');
  const wf = buildWorkflow();
  const check = wf.nodes.find((n) => n.name === 'Check Review').parameters.jsCode;
  assert.match(check, /checkReviewUnchanged\(/);
  assert.match(check, /checkReviewDecisionsLiteral\(/);
});
