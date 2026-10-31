'use strict';

// Google API request building and response checking (contract §12). The
// responses below follow the documented shapes of the Drive v3 and Sheets v4
// APIs; the live M2 tests confirm them against Google.

const test = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('./support/helpers.js');

const SETTINGS = {
  spreadsheet_id: 'SHEET_ID_1234567890abcdef',
  inbox_folder_id: 'FOLDER_ID_123456',
  supplier: 'demo-supplier',
  currency: 'ETB',
};
const SHEET = 'https://sheets.googleapis.com/v4/spreadsheets/SHEET_ID_1234567890abcdef';
// Contract §10: cells as stored, dates as serial numbers.
const READ = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';

test('request URLs are built and encoded exactly', () => {
  assert.deepEqual(core.buildGoogleRequests(SETTINGS), {
    list_inbox: 'https://www.googleapis.com/drive/v3/files'
      + "?q='FOLDER_ID_123456'%20in%20parents%20and%20trashed%20%3D%20false%20and%20mimeType%20!%3D%20'application%2Fvnd.google-apps.folder'"
      + '&fields=nextPageToken%2Cfiles(id%2Cname%2CmimeType%2Csize%2CmodifiedTime%2CcreatedTime)'
      + '&pageSize=51&supportsAllDrives=true&includeItemsFromAllDrives=true',
    read_run_log: `${SHEET}/values/'Run%20Log'!A1%3AZ?${READ}`,
    append_run_row: `${SHEET}/values/'Run%20Log'!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    sheet_meta: `${SHEET}?fields=sheets.properties(sheetId%2Ctitle%2CgridProperties(rowCount%2CcolumnCount))`,
    read_working_tabs: `${SHEET}/values:batchGet`
      + "?ranges='Catalog'!A1%3AL&ranges='Review'!A1%3AP"
      + "&ranges='Changes'!A1%3AK1&ranges='Changes'!A2%3AA"
      + "&ranges='Exceptions'!A1%3AK1&ranges='Exceptions'!A2%3AA"
      + "&ranges='Run%20Log'!A1%3AZ"
      + `&${READ}`,
    read_review: `${SHEET}/values/'Review'!A1%3AP?${READ}`,
    batch_update: `${SHEET}:batchUpdate`,
  });
  assert.equal(core.googleDownloadUrl('drv-week2'), 'https://www.googleapis.com/drive/v3/files/drv-week2?alt=media&supportsAllDrives=true');
  assert.throws(() => core.googleDownloadUrl('../etc'), (err) => err.code === 'PLAN_INVALID');
});

test("this run's row: one exact range for the check read and the FAILED write", () => {
  const row = core.buildRunRowRequests({ settings: SETTINGS, runRowNumber: 15 });
  assert.deepEqual(row, {
    number: 15,
    range: "'Run Log'!A15:Z15",
    read_url: `${SHEET}/values/'Run%20Log'!A15%3AZ15?${READ}`,
    update_url: `${SHEET}/values/'Run%20Log'!A15%3AZ15?valueInputOption=RAW`,
  });
  assert.equal(core.RUNLOG_COLUMNS.length, 26, 'A to Z covers every Run Log column');
  for (const bad of [1, 0, 2.5, '15', undefined]) {
    assert.throws(() => core.buildRunRowRequests({ settings: SETTINGS, runRowNumber: bad }), (err) => err.code === 'PLAN_INVALID', String(bad));
  }
});

test('settings are checked before any request is built', () => {
  const bad = (patch) => assert.throws(() => core.buildGoogleRequests(Object.assign({}, SETTINGS, patch)),
    (err) => err instanceof core.SheetOpsError && err.code === 'SETTINGS_INVALID', JSON.stringify(patch));
  bad({ spreadsheet_id: 'PASTE_SPREADSHEET_ID' });
  bad({ inbox_folder_id: 'PASTE_FOLDER_ID' });
  bad({ spreadsheet_id: 'short' });
  bad({ inbox_folder_id: "x' or name contains '" });
  bad({ supplier: 'Demo Supplier' });
  bad({ currency: 'etb' });
  assert.deepEqual(core.checkSettings(Object.assign({}, SETTINGS, { spreadsheet_id: '  SHEET_ID_1234567890abcdef  ' })), SETTINGS);
});

test('Drive listings: files are returned, a next page marks the listing incomplete', () => {
  const files = [{ id: 'drv-a', name: 'demo-supplier_2026-10-12.csv', mimeType: 'text/csv', size: '512', modifiedTime: '2026-10-12T06:00:00.000Z', createdTime: '2026-10-12T05:00:00.000Z' }];
  assert.deepEqual(core.parseDriveListing({ files }), { files, complete: true });
  assert.deepEqual(core.parseDriveListing({ files, nextPageToken: 'next' }), { files, complete: false });
  assert.deepEqual(core.parseDriveListing({ files: [] }), { files: [], complete: true });
  for (const response of [{}, { files: 'x' }, { error: { message: 'forbidden' } }, null]) {
    assert.throws(() => core.parseDriveListing(response), (err) => err.code === 'INVALID_LISTING');
  }
});

test('value ranges: an empty range has no values key; malformed values are refused', () => {
  assert.deepEqual(core.parseValueRange({ range: "'Run Log'!A1:Z1000", majorDimension: 'ROWS' }, 'Run Log'), []);
  assert.deepEqual(core.parseValueRange({ range: 'x', values: [['a', 1], []] }, 'x'), [['a', 1], []]);
  assert.throws(() => core.parseValueRange({ values: ['a'] }, 'x'), (err) => err.code === 'READ_FAILED');
  assert.throws(() => core.parseValueRange({ error: 'socket hang up' }, 'x'), (err) => err.code === 'READ_FAILED' && /socket hang up/.test(err.detail));
});

test('the working-tab read is split into catalog, review, ID columns and Run Log', () => {
  const response = {
    spreadsheetId: 'SHEET_ID_1234567890abcdef',
    valueRanges: [
      { range: 'Catalog!A1:L1000', values: [['sku'], ['FLR-001']] },
      { range: 'Review!A1:P1000' },
      { range: 'Changes!A1:K1', values: [['event_id', 'batch_id']] },
      { range: 'Changes!A2:A1000', values: [['EV|1'], ['EV|2']] },
      { range: 'Exceptions!A1:K1', values: [['exception_id']] },
      { range: 'Exceptions!A2:A1000' },
      { range: "'Run Log'!A1:Z1000", values: [['run_id'], ['1001']] },
    ],
  };
  assert.deepEqual(core.parseWorkingTabs(response), {
    catalog: [['sku'], ['FLR-001']],
    review: [],
    changes: { header: ['event_id', 'batch_id'], ids: ['EV|1', 'EV|2'], rows: 2 },
    exceptions: { header: ['exception_id'], ids: [], rows: 0 },
    runLog: [['run_id'], ['1001']],
  });
  assert.throws(() => core.parseWorkingTabs({ valueRanges: response.valueRanges.slice(1) }), (err) => err.code === 'READ_FAILED');
});

test('spreadsheet metadata: every managed tab must exist; an omitted sheetId means 0', () => {
  const tab = (title, sheetId, rows, cols) => ({ properties: Object.assign(sheetId === undefined ? {} : { sheetId }, { title, gridProperties: { rowCount: rows, columnCount: cols } }) });
  const response = { sheets: [tab('Catalog', undefined, 1000, 12), tab('Review', 11, 1000, 16), tab('Changes', 12, 1000, 11), tab('Exceptions', 13, 1000, 11), tab('Run Log', 14, 1000, 26), tab('Notes', 15, 10, 5)] };
  const meta = core.parseSheetMeta(response);
  assert.deepEqual(meta.Catalog, { sheetId: 0, rowCount: 1000, columnCount: 12 });
  assert.deepEqual(meta['Run Log'], { sheetId: 14, rowCount: 1000, columnCount: 26 });
  assert.throws(() => core.parseSheetMeta({ sheets: response.sheets.filter((s) => s.properties.title !== 'Review') }),
    (err) => err.code === 'OUTPUT_SCHEMA_MISMATCH' && /"Review"/.test(err.detail));
});

test('the appended Run Log row number comes from updates.updatedRange', () => {
  const appended = (updatedRange) => ({ spreadsheetId: 'x', tableRange: "'Run Log'!A1:Z14", updates: { updatedRange, updatedRows: 1 } });
  assert.equal(core.parseAppendedRowNumber(appended("'Run Log'!A15:Z15")), 15);
  for (const range of ["'Run Log'!A15:Z16", "'Run Log'!B15:Z15", "'Run Log'!A1:Z1", '']) {
    assert.throws(() => core.parseAppendedRowNumber(appended(range)), (err) => err.code === 'RUNLOG_INVALID', range);
  }
});

test('publish responses: a status means Google answered; no status means unknown', () => {
  const cases = [
    [{ statusCode: 200, body: { spreadsheetId: 'x', replies: [{}] } }, 'APPLIED', 200, ''],
    [{ statusCode: 400, body: { error: { code: 400, message: 'Invalid requests[1].updateCells: GridCoordinate.sheetId', status: 'INVALID_ARGUMENT' } } },
      'REJECTED', 400, 'Invalid requests[1].updateCells: GridCoordinate.sheetId'],
    [{ statusCode: 403, body: { error: { message: 'The caller does not have permission' } } }, 'REJECTED', 403, 'The caller does not have permission'],
    [{ statusCode: 429, body: { error: { message: 'Quota exceeded' } } }, 'REJECTED', 429, 'Quota exceeded'],
    [{ statusCode: 408, statusMessage: 'Request Timeout', body: '' }, 'UNKNOWN', 408, 'Request Timeout'],
    [{ statusCode: 503, body: 'Service Unavailable' }, 'UNKNOWN', 503, 'Service Unavailable'],
    [{ error: { message: 'timeout of 60000ms exceeded', code: 'ECONNABORTED' } }, 'UNKNOWN', undefined, 'timeout of 60000ms exceeded'],
    [{ error: { code: 'ECONNRESET' } }, 'UNKNOWN', undefined, 'ECONNRESET'],
    [{}, 'UNKNOWN', undefined, 'no response'],
  ];
  for (const [json, outcome, httpStatus, message] of cases) {
    assert.deepEqual(core.interpretPublishResponse(json), { outcome, httpStatus, message }, JSON.stringify(json));
  }
});
