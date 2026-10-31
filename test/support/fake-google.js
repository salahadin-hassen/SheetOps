'use strict';

// An in-memory stand-in for the Drive v3 and Sheets v4 calls SheetOps makes.
// It follows the documented behavior the workflow relies on: values come back
// unformatted with trailing empty cells and rows omitted, appends land after
// the last row with data, and spreadsheets.batchUpdate is validated in order
// and applied all-or-nothing. It is a test double; the live M2 tests check the
// real APIs.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

class NetworkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isEmpty = (value) => value === undefined || value === null || value === '';

function columnNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnLetter(count) {
  let letters = '';
  let n = count;
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Parses 'Tab'!A1:Z, 'Tab'!A2:A, 'Tab'!A1 and 'Tab'!A7:Z7.
function parseRange(text) {
  const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(text);
  if (!match) throw new Error(`Unsupported range ${text}`);
  return {
    tab: match[1].replace(/''/g, "'"),
    startCol: columnNumber(match[2]),
    startRow: Number(match[3]),
    endCol: match[4] ? columnNumber(match[4]) : columnNumber(match[2]),
    endRow: match[5] ? Number(match[5]) : (match[4] ? Infinity : Number(match[3])),
  };
}

function errorBody(code, status, message) {
  return { error: { code, message, status } };
}

class FakeGoogle {
  constructor({ spreadsheetId, folderId, title }) {
    this.spreadsheetId = spreadsheetId;
    this.title = title || 'SheetOps demo (synthetic)';
    this.folderId = folderId;
    this.tabs = new Map();
    this.files = [];
    this.faults = [];
    this.hooks = [];
    this.deferred = [];
    this.landed = [];
    this.log = [];
    this.listingPaged = false;
    // Google documents that a request referring to a missing sheet, or adding
    // a duplicate sheet ID or title, invalidates the whole batchUpdate. Setting
    // this to false models a Google that did not enforce that, to test what
    // the fixed-range writes still protect.
    this.enforceSheetChecks = true;
  }

  addTab(title, header, { sheetId, rowCount = 1000, columnCount = 26 } = {}) {
    this.tabs.set(title, { sheetId: sheetId === undefined ? this.tabs.size : sheetId, rowCount, columnCount, rows: [header.slice()] });
  }

  addFile(file) {
    this.files.push(Object.assign({ mimeType: 'text/csv' }, file));
  }

  // fault: { kind, node?, type, status, body, times }. Types:
  // 'status' answers with that status; 'timeout' fails in transit;
  // 'dns' fails before connecting (the request is never sent);
  // 'crash' kills the sender mid-request (the outcome cannot be known);
  // 'apply_then_timeout' applies the request, then loses the response;
  // 'timeout_apply_later' loses the request in transit and applies it right
  // after the next request from node `applyAfter`, like a delayed delivery.
  inject(fault) {
    this.faults.push(Object.assign({ times: 1 }, fault));
  }

  // Runs fn(this) once, just before the next request from that node: an edit
  // made by a person while the run is between two calls.
  before(node, fn) {
    this.hooks.push({ node, fn });
  }

  // Data rows of a tab as objects keyed by the header row.
  table(title) {
    const [header, ...rows] = this.tabs.get(title).rows;
    return rows.filter((row) => row.some((cell) => !isEmpty(cell))).map((row) => {
      const out = {};
      header.forEach((column, i) => { out[column] = isEmpty(row[i]) ? '' : row[i]; });
      return out;
    });
  }

  request({ method, url, body, node }) {
    const kind = this.classify(method, url);
    const hookIndex = this.hooks.findIndex((hook) => hook.node === node);
    if (hookIndex >= 0) this.hooks.splice(hookIndex, 1)[0].fn(this);
    this.log.push({ kind, method, url, node, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    const fault = this.faults.find((f) => f.times > 0 && f.kind === kind && (!f.node || f.node === node));
    if (fault) {
      fault.times -= 1;
      if (fault.type === 'status') return { status: fault.status, statusMessage: fault.statusMessage || '', body: fault.body };
      if (fault.type === 'timeout') throw new NetworkError('ECONNABORTED', 'timeout of 20000ms exceeded');
      if (fault.type === 'dns') throw new NetworkError('ENOTFOUND', 'getaddrinfo ENOTFOUND sheets.googleapis.invalid');
      // The sender itself dies mid-request: no answer, no error the workflow can catch.
      if (fault.type === 'crash') throw new Error('n8n process killed during the request');
      if (fault.type === 'apply_then_timeout') {
        this.handle(kind, method, url, body);
        throw new NetworkError('ECONNABORTED', 'timeout of 60000ms exceeded');
      }
      if (fault.type === 'timeout_apply_later') {
        this.deferred.push({ after: fault.applyAfter, kind, method, url, body });
        throw new NetworkError('ECONNABORTED', 'timeout of 60000ms exceeded');
      }
    }
    const reply = this.handle(kind, method, url, body);
    for (const late of this.deferred.filter((d) => d.after === node)) {
      this.deferred.splice(this.deferred.indexOf(late), 1);
      late.reply = this.handle(late.kind, late.method, late.url, late.body);
      this.landed.push(late);
    }
    return reply;
  }

  classify(method, url) {
    if (url.startsWith(`${DRIVE_FILES}?`) && method === 'GET') return 'DRIVE_LIST';
    if (url.startsWith(`${DRIVE_FILES}/`) && method === 'GET') return 'DRIVE_GET';
    const sheet = `${SHEETS}/${this.spreadsheetId}`;
    if (!url.startsWith(sheet)) throw new Error(`Unexpected URL ${url}`);
    const rest = url.slice(sheet.length);
    if (rest.startsWith('?') && method === 'GET') return 'SHEETS_META';
    if (rest.startsWith(':batchUpdate') && method === 'POST') return 'BATCH_UPDATE';
    if (rest.startsWith('/values:batchGet') && method === 'GET') return 'VALUES_BATCH_GET';
    if (rest.startsWith('/values/') && /:append\?/.test(rest) && method === 'POST') return 'VALUES_APPEND';
    if (rest.startsWith('/values/') && method === 'GET') return 'VALUES_GET';
    if (rest.startsWith('/values/') && method === 'PUT') return 'VALUES_UPDATE';
    throw new Error(`Unexpected ${method} ${url}`);
  }

  handle(kind, method, url, body) {
    const parsed = new URL(url);
    switch (kind) {
      case 'DRIVE_LIST': {
        const q = parsed.searchParams.get('q') || '';
        if (!q.includes(`'${this.folderId}' in parents`)) return { status: 404, body: errorBody(404, 'NOT_FOUND', 'File not found') };
        const files = this.files.map((f) => {
          const meta = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, createdTime: f.createdTime };
          if (!f.mimeType.startsWith('application/vnd.google-apps.')) meta.size = String(f.size === undefined ? Buffer.byteLength(f.content || '') : f.size);
          return meta;
        });
        return { status: 200, body: Object.assign({ files }, this.listingPaged ? { nextPageToken: 'page-2' } : {}) };
      }
      case 'DRIVE_GET': {
        const id = decodeURIComponent(parsed.pathname.split('/').pop());
        const file = this.files.find((f) => f.id === id);
        if (!file) return { status: 404, body: errorBody(404, 'NOT_FOUND', `File not found: ${id}`) };
        if (file.mimeType.startsWith('application/vnd.google-apps.')) {
          return { status: 403, body: errorBody(403, 'PERMISSION_DENIED', 'Only files with binary content can be downloaded') };
        }
        return { status: 200, body: file.content, text: true };
      }
      case 'SHEETS_META': {
        // includeGridData=true returns every cell's userEnteredValue, as the
        // live-test snapshots request.
        const grid = parsed.searchParams.get('includeGridData') === 'true';
        const cell = (value) => {
          if (isEmpty(value)) return {};
          if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
          if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
          if (value && typeof value === 'object' && typeof value.formula === 'string') return { userEnteredValue: { formulaValue: value.formula } };
          return { userEnteredValue: { stringValue: String(value) } };
        };
        return {
          status: 200,
          body: Object.assign(grid ? { properties: { title: this.title } } : {}, {
            sheets: Array.from(this.tabs.entries()).map(([title, tab]) => Object.assign({
              // Like the JSON API, a sheetId of 0 and hidden: false are left out.
              properties: Object.assign(tab.sheetId === 0 ? {} : { sheetId: tab.sheetId }, {
                title, sheetType: 'GRID', gridProperties: { rowCount: tab.rowCount, columnCount: tab.columnCount },
              }, tab.hidden ? { hidden: true } : {}),
            }, grid ? { data: [{ rowData: tab.rows.map((row) => ({ values: (row || []).map(cell) })) }] } : {})),
          }),
        };
      }
      case 'VALUES_GET': {
        const range = decodeURIComponent(parsed.pathname.split('/values/')[1]);
        return { status: 200, body: this.readRange(range) };
      }
      case 'VALUES_BATCH_GET':
        return {
          status: 200,
          body: { spreadsheetId: this.spreadsheetId, valueRanges: parsed.searchParams.getAll('ranges').map((r) => this.readRange(r)) },
        };
      case 'VALUES_APPEND': {
        const range = parseRange(decodeURIComponent(parsed.pathname.split('/values/')[1].replace(/:append$/, '')));
        const tab = this.tabs.get(range.tab);
        if (!tab) return { status: 400, body: errorBody(400, 'INVALID_ARGUMENT', `Unable to parse range: ${range.tab}`) };
        const values = body.values;
        const at = this.lastDataRow(tab);
        tab.rows.splice(at, 0, ...values.map((row) => row.map((cell) => (isEmpty(cell) ? '' : cell))));
        tab.rowCount += values.length;
        const first = at + 1;
        const last = at + values.length;
        const width = Math.max(...values.map((row) => row.length));
        return {
          status: 200,
          body: {
            spreadsheetId: this.spreadsheetId,
            tableRange: `'${range.tab}'!A1:${columnLetter(width)}${at}`,
            updates: {
              spreadsheetId: this.spreadsheetId,
              updatedRange: `'${range.tab}'!A${first}:${columnLetter(width)}${last}`,
              updatedRows: values.length,
              updatedColumns: width,
              updatedCells: values.length * width,
            },
          },
        };
      }
      case 'VALUES_UPDATE': {
        const range = parseRange(decodeURIComponent(parsed.pathname.split('/values/')[1]));
        const tab = this.tabs.get(range.tab);
        if (!tab || range.endRow > tab.rowCount || range.endCol > tab.columnCount) {
          return { status: 400, body: errorBody(400, 'INVALID_ARGUMENT', `Range ${range.tab} exceeds grid limits`) };
        }
        body.values.forEach((row, r) => row.forEach((cell, c) => this.setCell(tab, range.startRow - 1 + r, range.startCol - 1 + c, isEmpty(cell) ? '' : cell)));
        return { status: 200, body: { spreadsheetId: this.spreadsheetId, updatedRange: decodeURIComponent(parsed.pathname.split('/values/')[1]) } };
      }
      case 'BATCH_UPDATE':
        return this.batchUpdate(body);
      default:
        throw new Error(`Unhandled ${kind}`);
    }
  }

  readRange(text) {
    const range = parseRange(text);
    const tab = this.tabs.get(range.tab);
    if (!tab) return { range: text, majorDimension: 'ROWS' };
    const rows = [];
    const lastRow = Math.min(tab.rows.length, range.endRow);
    for (let r = range.startRow - 1; r < lastRow; r += 1) {
      const row = (tab.rows[r] || []).slice(range.startCol - 1, range.endCol);
      while (row.length > 0 && isEmpty(row[row.length - 1])) row.pop();
      rows.push(row.map((cell) => (isEmpty(cell) ? '' : cell)));
    }
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
    const out = { range: text, majorDimension: 'ROWS' };
    if (rows.length > 0) out.values = rows;
    return out;
  }

  lastDataRow(tab) {
    for (let r = tab.rows.length - 1; r >= 0; r -= 1) {
      if ((tab.rows[r] || []).some((cell) => !isEmpty(cell))) return r + 1;
    }
    return 0;
  }

  setCell(tab, row, col, value) {
    while (tab.rows.length <= row) tab.rows.push([]);
    const cells = tab.rows[row];
    while (cells.length <= col) cells.push('');
    cells[col] = value;
  }

  // Validated request by request on a copy, then committed as a whole.
  batchUpdate(body) {
    const draft = new Map(Array.from(this.tabs.entries()).map(([title, tab]) => [title, Object.assign({}, tab, { rows: tab.rows.map((row) => row.slice()) })]));
    const bySheetId = (sheetId) => Array.from(draft.values()).find((tab) => tab.sheetId === sheetId);
    const invalid = (i, why) => ({ status: 400, body: errorBody(400, 'INVALID_ARGUMENT', `Invalid requests[${i}]: ${why}`) });
    const cellValue = (cell) => {
      const v = cell && cell.userEnteredValue;
      if (!v) return '';
      if (typeof v.stringValue === 'string') return v.stringValue;
      if (typeof v.numberValue === 'number') return v.numberValue;
      if (typeof v.boolValue === 'boolean') return v.boolValue;
      if (typeof v.formulaValue === 'string') return { formula: v.formulaValue };
      return '';
    };
    const requests = (body && body.requests) || [];
    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i];
      const kind = Object.keys(request)[0];
      const spec = request[kind];
      if (kind === 'appendDimension') {
        const tab = bySheetId(spec.sheetId);
        if (!tab || spec.dimension !== 'ROWS' || !(spec.length > 0)) return invalid(i, 'appendDimension');
        tab.rowCount += spec.length;
      } else if (kind === 'updateCells') {
        const range = spec.range || {};
        const tab = bySheetId(range.sheetId);
        if (!tab) return invalid(i, `No grid with id: ${range.sheetId}`);
        if (spec.fields !== 'userEnteredValue') return invalid(i, 'unsupported fields mask');
        if (range.endRowIndex > tab.rowCount || range.endColumnIndex > tab.columnCount) return invalid(i, 'range exceeds grid limits');
        const rows = spec.rows || [];
        if (rows.length > range.endRowIndex - range.startRowIndex) return invalid(i, 'more rows than the range');
        for (let r = range.startRowIndex; r < range.endRowIndex; r += 1) {
          for (let c = range.startColumnIndex; c < range.endColumnIndex; c += 1) {
            const row = rows[r - range.startRowIndex];
            this.setCell(tab, r, c, cellValue(row && row.values ? row.values[c - range.startColumnIndex] : undefined));
          }
        }
      } else if (kind === 'appendCells') {
        const tab = bySheetId(spec.sheetId);
        if (!tab) return invalid(i, `No grid with id: ${spec.sheetId}`);
        if (spec.fields !== 'userEnteredValue') return invalid(i, 'unsupported fields mask');
        const at = this.lastDataRow(tab);
        if (at + spec.rows.length > tab.rowCount) tab.rowCount = at + spec.rows.length;
        spec.rows.forEach((row, r) => (row.values || []).forEach((cell, c) => this.setCell(tab, at + r, c, cellValue(cell))));
      } else if (kind === 'deleteSheet') {
        const tab = bySheetId(spec.sheetId);
        if (!tab) {
          if (this.enforceSheetChecks) return invalid(i, `No sheet with id: ${spec.sheetId}`);
          continue;
        }
        draft.delete(Array.from(draft.entries()).find(([, value]) => value === tab)[0]);
      } else if (kind === 'addSheet') {
        const props = spec.properties || {};
        if (!Number.isInteger(props.sheetId) || props.sheetId < 0 || typeof props.title !== 'string') return invalid(i, 'addSheet properties');
        if (bySheetId(props.sheetId) || draft.has(props.title)) {
          if (this.enforceSheetChecks) return invalid(i, `A sheet with the id ${props.sheetId} or title "${props.title}" already exists`);
          continue;
        }
        const grid = props.gridProperties || {};
        draft.set(props.title, { sheetId: props.sheetId, rowCount: grid.rowCount || 1000, columnCount: grid.columnCount || 26, hidden: Boolean(props.hidden), rows: [] });
      } else {
        return invalid(i, `unknown request ${kind}`);
      }
    }
    this.tabs = draft;
    return { status: 200, body: { spreadsheetId: this.spreadsheetId, replies: requests.map(() => ({})) } };
  }
}

module.exports = { FakeGoogle, NetworkError };
