'use strict';

/*
 * SheetOps deterministic core.
 *
 * Pure functions only: no clock reads, no randomness, no network, no require().
 * Times, Drive metadata and sheet contents all arrive as inputs, so the same
 * inputs always produce the same plan. The file runs unchanged under
 * `node --test` and inside an n8n Code node. n8n's Code node also defines
 * `module`, so the export block at the bottom runs there too; that is harmless
 * because n8n uses the code's return value.
 *
 * Specification: docs/data-contract.md. "§n" comments point to its sections.
 */

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  supplier: 'demo-supplier',
  currency: 'ETB',
  review_price_change_pct: 25,
  mass_discontinue_pct: 30,
  max_file_bytes: 2000000,
  max_data_rows: 2000,
  max_catalog_rows: 2000,
  max_listed_files: 50,
  max_attempts: 3,
  stale_started_minutes: 15,
  // Off (the default): an unresolved publication, a STARTED row whose publish
  // outcome nobody established, blocks scheduled runs until a person
  // reconciles it (§2). Its age only shows that no run is still active; it
  // never shows what happened to the publish. On: scheduled runs reprocess it
  // themselves, relying on the version check (§12), which the live tests
  // T-VERSION-1 and T-VERSION-2 must confirm first.
  auto_recover_uncertain: false,
  max_request_bytes: 2000000,
  max_price_cents: 1000000000,
  max_name_length: 200,
  max_message_length: 500,
});

const TABS = Object.freeze({
  catalog: 'Catalog',
  review: 'Review',
  changes: 'Changes',
  exceptions: 'Exceptions',
  runLog: 'Run Log',
});

const CATALOG_COLUMNS = Object.freeze([
  'sku', 'name', 'unit', 'unit_price', 'currency', 'status', 'previous_price',
  'first_seen', 'last_seen', 'last_changed', 'pending_review', 'last_issue',
]);

const REVIEW_COLUMNS = Object.freeze([
  'review_id', 'sku', 'status', 'reasons', 'current_name', 'current_unit',
  'current_price', 'proposed_name', 'proposed_unit', 'proposed_price',
  'change_pct', 'first_seen', 'last_seen', 'source_row', 'decision', 'note',
]);

const CHANGES_COLUMNS = Object.freeze([
  'event_id', 'batch_id', 'effective_date', 'sku', 'change_type', 'disposition',
  'old_value', 'new_value', 'change_pct', 'review_id', 'note',
]);

const EXCEPTIONS_COLUMNS = Object.freeze([
  'exception_id', 'batch_id', 'source_file', 'source_row', 'sku_raw', 'severity',
  'code', 'field', 'raw_value', 'message', 'action',
]);

const RUNLOG_COLUMNS = Object.freeze([
  'run_id', 'mode', 'status', 'started_at', 'finished_at', 'batch_id',
  'source_file_id', 'source_name', 'effective_date', 'source_modified_at',
  'source_created_at', 'rows_read', 'accepted', 'collapsed', 'rejected',
  'held_conflict', 'held_review', 'blank', 'changes_applied', 'reviews_opened',
  'reviews_pending', 'exceptions', 'exceptions_new', 'queue_remaining',
  'error_code', 'error_message',
]);

// §4: header aliases, matched after trim + lowercase + whitespace collapse.
const HEADER_LOOKUP = buildLookup({
  sku: ['sku', 'item code', 'item_code', 'product code', 'code'],
  name: ['name', 'description', 'item name', 'product'],
  unit: ['unit', 'uom', 'unit of measure'],
  unit_price: ['unit_price', 'unit price', 'price'],
  currency: ['currency', 'cur'],
});
const REQUIRED_FIELDS = Object.freeze(['sku', 'name', 'unit', 'unit_price']);

// §5: unit vocabulary and aliases.
const UNIT_ALIASES = buildMap({
  pcs: 'each', pc: 'each', piece: 'each', ea: 'each', kgs: 'kg', ltr: 'l', litre: 'l', liter: 'l',
});
const UNITS = Object.freeze(['each', 'kg', 'g', 'l', 'ml', 'pack', 'box']);

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,31}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const FILE_NAME_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)_(\d{4})-(\d{2})-(\d{2})\.csv$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const COMMITTED_STATUSES = Object.freeze(['SUCCESS', 'SUCCESS_WITH_EXCEPTIONS']);

// The publication version (§12): a hidden tab whose sheet ID is the version.
// Every publish deletes the tab with the ID it planned from and adds it back
// with a higher ID, so a publish planned from an older version is rejected.
const VERSION_TAB = '_sheetops_version';
const VERSION_BASE = 1000000000;
const VERSION_MAX = 2147483646;
const VERSION_EPOCH = Date.UTC(2026, 0, 1);
const RUN_STATUSES = Object.freeze([
  'STARTED', 'SUCCESS', 'SUCCESS_WITH_EXCEPTIONS', 'REJECTED_FILE', 'HALTED_REVIEW',
  'FAILED', 'INTERRUPTED', 'BLOCKED',
]);
const CHANGE_TYPE_ORDER = Object.freeze([
  'REVIEW_SUPERSEDED', 'NEW_ITEM', 'REACTIVATED', 'PRICE_CHANGED', 'UNIT_CHANGED',
  'NAME_CHANGED', 'DISCONTINUED',
]);
const OUTCOMES = Object.freeze(['ACCEPTED', 'COLLAPSED', 'REJECTED', 'HELD_CONFLICT', 'HELD_REVIEW', 'BLANK']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// A run-level failure: the workflow records it as FAILED and publishes nothing.
class SheetOpsError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'SheetOpsError';
    this.code = code;
    this.detail = detail;
  }
}

class CsvParseError extends Error {
  constructor(reason, line) {
    super(`${reason} (line ${line})`);
    this.name = 'CsvParseError';
    this.reason = reason;
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function buildLookup(aliases) {
  const lookup = Object.create(null);
  for (const field of Object.keys(aliases)) {
    for (const alias of aliases[field]) lookup[alias] = field;
  }
  return lookup;
}

function buildMap(entries) {
  const map = Object.create(null);
  for (const key of Object.keys(entries)) map[key] = entries[key];
  return map;
}

function withDefaults(config) {
  return Object.assign({}, DEFAULT_CONFIG, config || {});
}

function cellString(value) {
  return value === undefined || value === null ? '' : String(value);
}

function collapseWhitespace(value) {
  return cellString(value).trim().replace(/\s+/g, ' ');
}

// Plain code-unit comparison: never locale-dependent, so sorting is deterministic.
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const result = compareStrings(a[i], b[i]);
    if (result !== 0) return result;
  }
  return 0;
}

function truncate(value, max) {
  const text = cellString(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

// A date pasted into Google Sheets is usually converted to a date value, which
// the API returns as a serial day number (day 0 = 1899-12-30). Converting it
// back is exact, so date columns accept it.
function sheetDate(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2958466) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  return cellString(value).trim();
}

function isDateString(value) {
  const match = DATE_PATTERN.exec(cellString(value));
  return Boolean(match) && isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

// Returns `YYYY-MM-DDTHH:MM:SS.sssZ` or null.
function normalizeTimestamp(value) {
  const m = TIMESTAMP_PATTERN.exec(cellString(value).trim());
  if (!m) return null;
  if (!isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] || '').padEnd(3, '0')}Z`;
}

// Counted by hand so the core needs neither Buffer nor TextEncoder.
function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Money (§5, §7): integer cents only
// ---------------------------------------------------------------------------

function formatCents(cents) {
  const fraction = cents % 100;
  return `${Math.floor(cents / 100)}.${fraction < 10 ? '0' : ''}${fraction}`;
}

function centsToNumber(cents) {
  return cents / 100;
}

// part / whole as a percentage in tenths, rounded half away from zero.
function percentTenths(part, whole) {
  return Math.floor((2 * part * 1000 + whole) / (2 * whole));
}

function formatTenths(tenths) {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function changePct(oldCents, newCents) {
  const tenths = percentTenths(Math.abs(newCents - oldCents), oldCents);
  if (tenths === 0) return 0;
  return (newCents < oldCents ? -tenths : tenths) / 10;
}

function parsePrice(raw, maxCents) {
  const limit = maxCents === undefined ? DEFAULT_CONFIG.max_price_cents : maxCents;
  const text = cellString(raw).trim();
  if (text === '') return { code: 'MISSING_PRICE' };
  let digits;
  if (/^\d+(\.\d{1,2})?$/.test(text)) digits = text;
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text)) digits = text.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(text) || /^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(text)) return { code: 'AMBIGUOUS_PRICE' };
  else return { code: 'INVALID_PRICE' };
  const parts = digits.split('.');
  const whole = parts[0].replace(/^0+(?=\d)/, '');
  if (whole.length > 10) return { code: 'INVALID_PRICE' };
  const cents = Number(whole) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (cents <= 0 || cents > limit) return { code: 'INVALID_PRICE' };
  return { cents };
}

// Sheet cells come back as numbers (UNFORMATTED_VALUE) or as text.
function readSheetPrice(value, maxCents) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6 || cents <= 0 || cents > maxCents) return null;
    return cents;
  }
  const parsed = parsePrice(value, maxCents);
  return parsed.cents === undefined ? null : parsed.cents;
}

// ---------------------------------------------------------------------------
// CSV parsing (§3): RFC 4180 state machine, never comma splitting
// ---------------------------------------------------------------------------

function parseCsv(input) {
  let text = cellString(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    fields.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    records.push({ record: records.length + 1, line: recordLine, fields });
    fields = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          afterQuote = true;
          i += 1;
        }
        continue;
      }
      if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      endRecord();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }
    if (afterQuote) throw new CsvParseError('unexpected character after a closing quote', line);
    if (c === '"') {
      if (field.length > 0) throw new CsvParseError('quote inside an unquoted field', line);
      inQuotes = true;
      quoted = true;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) throw new CsvParseError('unterminated quoted field', recordLine);
  if (field.length > 0 || fields.length > 0 || quoted) endRecord();
  return records;
}

// ---------------------------------------------------------------------------
// Headers and fields (§4, §5)
// ---------------------------------------------------------------------------

function fileProblem(code, field, raw, message) {
  return { code, field, raw, message };
}

function mapHeader(headerFields) {
  const index = Object.create(null);
  const ignored = [];
  const problems = [];
  headerFields.forEach((cell, position) => {
    const key = cellString(cell).trim().toLowerCase().replace(/\s+/g, ' ');
    const field = HEADER_LOOKUP[key];
    if (!field) {
      ignored.push(cellString(cell));
      return;
    }
    if (index[field] !== undefined) {
      if (!problems.some((p) => p.field === field)) {
        problems.push(fileProblem('AMBIGUOUS_COLUMN', field, cellString(cell),
          `More than one column maps to ${field}`));
      }
      return;
    }
    index[field] = position;
  });
  for (const field of REQUIRED_FIELDS) {
    if (index[field] === undefined && !problems.some((p) => p.field === field)) {
      problems.push(fileProblem('MISSING_COLUMN', field, '', `No column maps to ${field}`));
    }
  }
  return { index, ignored, problems, width: headerFields.length };
}

function fieldError(code, field, raw, message) {
  return { code, field, raw: cellString(raw), message };
}

// Validates one record's fields. `fields.currency === undefined` means the
// file has no currency column, so the configured currency applies.
function validateFields(fields, config) {
  const cfg = withDefaults(config);
  const errors = [];
  const skuRaw = cellString(fields.sku);
  const sku = skuRaw.trim().toUpperCase();
  const skuValid = SKU_PATTERN.test(sku);
  if (sku === '') errors.push(fieldError('MISSING_SKU', 'sku', skuRaw, 'SKU is empty'));
  else if (!skuValid) errors.push(fieldError('INVALID_SKU', 'sku', skuRaw, `SKU "${skuRaw}" does not match the allowed pattern`));

  const name = collapseWhitespace(fields.name);
  if (name === '') errors.push(fieldError('MISSING_NAME', 'name', fields.name, 'Name is empty'));
  else if (name.length > cfg.max_name_length) {
    errors.push(fieldError('NAME_TOO_LONG', 'name', fields.name, `Name is longer than ${cfg.max_name_length} characters`));
  }

  let unit = cellString(fields.unit).trim().toLowerCase();
  if (unit === '') errors.push(fieldError('MISSING_UNIT', 'unit', fields.unit, 'Unit is empty'));
  else {
    if (UNIT_ALIASES[unit] !== undefined) unit = UNIT_ALIASES[unit];
    if (!UNITS.includes(unit)) {
      errors.push(fieldError('UNKNOWN_UNIT', 'unit', fields.unit, `Unit "${cellString(fields.unit).trim()}" is not one of ${UNITS.join(', ')}`));
    }
  }

  const price = parsePrice(fields.unit_price, cfg.max_price_cents);
  if (price.code) {
    const messages = {
      MISSING_PRICE: 'Price is empty',
      AMBIGUOUS_PRICE: `Price "${cellString(fields.unit_price).trim()}" may use a decimal comma; not guessed`,
      INVALID_PRICE: `Price "${cellString(fields.unit_price).trim()}" is not a positive amount with at most 2 decimals`,
    };
    errors.push(fieldError(price.code, 'unit_price', fields.unit_price, messages[price.code]));
  }

  let currency = cfg.currency;
  if (fields.currency !== undefined) {
    currency = cellString(fields.currency).trim().toUpperCase();
    if (currency !== cfg.currency) {
      errors.push(fieldError('CURRENCY_MISMATCH', 'currency', fields.currency, `Currency "${cellString(fields.currency).trim()}" is not ${cfg.currency}`));
    }
  }

  return {
    sku: skuValid ? sku : '',
    skuRaw,
    errors,
    value: errors.length === 0 ? { name, unit, cents: price.cents, currency } : null,
  };
}

function classifyRecord(record, header, cfg) {
  const raw = record.fields;
  const base = { row: record.record, line: record.line };
  if (raw.every((value) => value.trim() === '')) {
    return Object.assign(base, { kind: 'BLANK', sku: '', skuRaw: '', errors: [], value: null });
  }
  const pick = (field) => (header.index[field] === undefined ? undefined : cellString(raw[header.index[field]]));
  if (raw.length !== header.width) {
    const skuRaw = cellString(pick('sku'));
    const sku = skuRaw.trim().toUpperCase();
    return Object.assign(base, {
      kind: 'REJECTED',
      sku: SKU_PATTERN.test(sku) ? sku : '',
      skuRaw,
      errors: [fieldError('FIELD_COUNT_MISMATCH', '', String(raw.length),
        `Row has ${raw.length} fields; the header has ${header.width}`)],
      value: null,
    });
  }
  const result = validateFields({
    sku: pick('sku'),
    name: pick('name'),
    unit: pick('unit'),
    unit_price: pick('unit_price'),
    currency: pick('currency'),
  }, cfg);
  return Object.assign(base, {
    kind: result.errors.length === 0 ? 'VALID' : 'REJECTED',
    sku: result.sku,
    skuRaw: result.skuRaw,
    errors: result.errors,
    value: result.value,
  });
}

// ---------------------------------------------------------------------------
// Reading sheet tabs (§10)
// ---------------------------------------------------------------------------

function readTable(values, columns, tabName) {
  if (!Array.isArray(values) || values.length === 0 || !Array.isArray(values[0])) {
    throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `${tabName} tab has no header row`);
  }
  const header = values[0].map((cell) => cellString(cell).trim());
  while (header.length > columns.length && header[header.length - 1] === '') header.pop();
  if (header.length !== columns.length || header.some((name, i) => name !== columns[i])) {
    throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `${tabName} header must be exactly: ${columns.join(', ')}`);
  }
  const rows = [];
  for (let r = 1; r < values.length; r += 1) {
    const cells = Array.isArray(values[r]) ? values[r] : [];
    if (cells.slice(columns.length).some((cell) => cellString(cell).trim() !== '')) {
      throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `${tabName} row ${r + 1} has values outside the managed columns`);
    }
    if (cells.every((cell) => cellString(cell).trim() === '')) continue;
    // The Sheets API omits trailing empty cells, so short rows are padded.
    const row = { _row: r + 1 };
    columns.forEach((column, i) => {
      row[column] = cells[i] === undefined || cells[i] === null ? '' : cells[i];
    });
    rows.push(row);
  }
  return rows;
}

function readCatalog(values, cfg) {
  const rows = readTable(values, CATALOG_COLUMNS, TABS.catalog);
  if (rows.length > cfg.max_catalog_rows) {
    throw new SheetOpsError('CATALOG_INVALID', `Catalog has ${rows.length} rows; the limit is ${cfg.max_catalog_rows}`);
  }
  const bySku = new Map();
  for (const row of rows) {
    const fail = (why) => { throw new SheetOpsError('CATALOG_INVALID', `Catalog row ${row._row}: ${why}`); };
    const sku = cellString(row.sku).trim();
    if (!SKU_PATTERN.test(sku)) fail(`invalid sku "${sku}"`);
    if (bySku.has(sku)) fail(`duplicate sku ${sku}`);
    const name = collapseWhitespace(row.name);
    if (name === '') fail('empty name');
    const unit = cellString(row.unit).trim();
    if (!UNITS.includes(unit)) fail(`unknown unit "${unit}"`);
    const cents = readSheetPrice(row.unit_price, cfg.max_price_cents);
    if (cents === null) fail(`unreadable unit_price "${cellString(row.unit_price)}"`);
    const currency = cellString(row.currency).trim();
    if (currency !== cfg.currency) fail(`currency "${currency}" is not ${cfg.currency}`);
    const status = cellString(row.status).trim();
    if (status !== 'ACTIVE' && status !== 'DISCONTINUED') fail(`unknown status "${status}"`);
    let previousCents = null;
    if (cellString(row.previous_price).trim() !== '') {
      previousCents = readSheetPrice(row.previous_price, cfg.max_price_cents);
      if (previousCents === null) fail(`unreadable previous_price "${cellString(row.previous_price)}"`);
    }
    const dates = {};
    for (const column of ['first_seen', 'last_seen', 'last_changed']) {
      dates[column] = sheetDate(row[column]);
      if (!isDateString(dates[column])) fail(`${column} "${dates[column]}" is not YYYY-MM-DD`);
    }
    bySku.set(sku, {
      sku, name, unit, cents, currency, status, previousCents,
      first_seen: dates.first_seen, last_seen: dates.last_seen, last_changed: dates.last_changed,
    });
  }
  return bySku;
}

function readReview(values, cfg) {
  const rows = readTable(values, REVIEW_COLUMNS, TABS.review);
  const bySku = new Map();
  const ids = new Set();
  for (const row of rows) {
    const fail = (why) => { throw new SheetOpsError('REVIEW_INVALID', `Review row ${row._row}: ${why}`); };
    const reviewId = cellString(row.review_id).trim();
    const sku = cellString(row.sku).trim();
    const parts = reviewId.split('|');
    if (parts.length !== 3 || parts[0] !== 'RV' || parts[1] !== sku || !SKU_PATTERN.test(sku)
      || !BATCH_ID_PATTERN.test(parts[2])) fail(`malformed review_id "${reviewId}"`);
    if (ids.has(reviewId)) fail(`duplicate review_id ${reviewId}`);
    if (bySku.has(sku)) fail(`more than one open item for ${sku}`);
    const name = collapseWhitespace(row.proposed_name);
    if (name === '') fail('empty proposed_name');
    const unit = cellString(row.proposed_unit).trim();
    if (!UNITS.includes(unit)) fail(`unknown proposed_unit "${unit}"`);
    const cents = readSheetPrice(row.proposed_price, cfg.max_price_cents);
    if (cents === null) fail(`unreadable proposed_price "${cellString(row.proposed_price)}"`);
    const firstSeen = sheetDate(row.first_seen);
    const lastSeen = sheetDate(row.last_seen);
    if (!isDateString(firstSeen) || !isDateString(lastSeen)) fail('first_seen and last_seen must be YYYY-MM-DD');
    const sourceRow = Number(cellString(row.source_row).trim());
    if (!Number.isInteger(sourceRow) || sourceRow < 2) fail(`invalid source_row "${cellString(row.source_row)}"`);
    ids.add(reviewId);
    // decision and note are the operator's: kept exactly as read, type included.
    bySku.set(sku, {
      review_id: reviewId,
      sku,
      firstBatchId: parts[2],
      proposal: { name, unit, cents },
      first_seen: firstSeen,
      last_seen: lastSeen,
      source_row: sourceRow,
      decision: row.decision,
      note: row.note,
    });
  }
  return bySku;
}

function readIdColumn(tab, columns, tabName) {
  if (!tab || !Array.isArray(tab.header)) {
    throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `${tabName} tab header was not provided`);
  }
  readTable([tab.header], columns, tabName);
  const ids = new Set();
  for (const id of tab.ids || []) {
    const text = cellString(id).trim();
    if (text !== '' && text !== columns[0]) ids.add(text);
  }
  return ids;
}

// The first free row (1-based) of Changes and Exceptions: just below the last
// row the ID-column read returned. New history rows are written there, at a
// fixed range, so replaying the same publish rewrites the same cells (§12).
function nextRows(sheet) {
  const next = (tab) => {
    const rows = tab && Number.isInteger(tab.rows) ? tab.rows : ((tab && tab.ids) || []).length;
    return 2 + rows;
  };
  return { changes: next(sheet.changes), exceptions: next(sheet.exceptions) };
}

function readRunLog(values) {
  const rows = readTable(values, RUNLOG_COLUMNS, TABS.runLog);
  return rows.map((row) => {
    const fail = (why) => { throw new SheetOpsError('RUNLOG_INVALID', `Run Log row ${row._row}: ${why}`); };
    const run = {
      row_number: row._row,
      run_id: cellString(row.run_id).trim(),
      status: cellString(row.status).trim(),
      started_at: cellString(row.started_at).trim(),
      batch_id: cellString(row.batch_id).trim(),
      source_file_id: cellString(row.source_file_id).trim(),
      effective_date: cellString(row.effective_date).trim(),
      source_modified_at: normalizeTimestamp(row.source_modified_at),
      source_created_at: normalizeTimestamp(row.source_created_at),
    };
    if (run.run_id === '') fail('empty run_id');
    if (!RUN_STATUSES.includes(run.status)) fail(`unknown status "${run.status}"`);
    if (run.status === 'STARTED' && normalizeTimestamp(run.started_at) === null) fail('STARTED row without a valid started_at');
    if (COMMITTED_STATUSES.includes(run.status) && (!BATCH_ID_PATTERN.test(run.batch_id)
      || !isDateString(run.effective_date) || !run.source_modified_at || !run.source_created_at
      || !FILE_ID_PATTERN.test(run.source_file_id))) fail('committed row without complete batch identity');
    return run;
  });
}

// ---------------------------------------------------------------------------
// Source versions and queue selection (§2)
// ---------------------------------------------------------------------------

// Describes one Drive listing entry and applies the pre-download checks (§2).
function describeSourceFile(file, config) {
  const cfg = withDefaults(config);
  const source = file || {};
  const id = cellString(source.id);
  const name = cellString(source.name);
  const modified = normalizeTimestamp(source.modifiedTime);
  const created = normalizeTimestamp(source.createdTime);
  if (!FILE_ID_PATTERN.test(id) || modified === null || created === null) {
    throw new SheetOpsError('INVALID_LISTING', `Drive entry "${name}" lacks a valid id, modifiedTime or createdTime`);
  }
  // Drive reports size as a string; Google-native files have no size.
  let size = null;
  if (source.size !== undefined && source.size !== null && source.size !== '') {
    size = Number(source.size);
    if (!Number.isInteger(size) || size < 0) throw new SheetOpsError('INVALID_LISTING', `Drive entry "${name}" has an invalid size`);
  }
  const version = {
    batch_id: `${id}@${modified}`,
    file_id: id,
    name,
    effective_date: '',
    modified_at: modified,
    created_at: created,
    size,
    reject_code: '',
    reject_message: '',
  };
  const reject = (code, message) => {
    version.reject_code = code;
    version.reject_message = message;
  };
  const match = FILE_NAME_PATTERN.exec(name);
  if (cellString(source.mimeType).startsWith('application/vnd.google-apps.')) {
    reject('NOT_A_CSV_FILE', `"${name}" is a Google Docs, Sheets or other native file, not an uploaded CSV`);
  } else if (!match || !isRealDate(Number(match[2]), Number(match[3]), Number(match[4]))) {
    reject('BAD_FILENAME', `"${name}" does not match ${cfg.supplier}_YYYY-MM-DD.csv`);
  } else if (match[1] !== cfg.supplier) {
    reject('WRONG_SUPPLIER', `Supplier part of "${name}" is not ${cfg.supplier}`);
  } else {
    version.effective_date = `${match[2]}-${match[3]}-${match[4]}`;
    if (size !== null && size > cfg.max_file_bytes) reject('FILE_TOO_LARGE', `"${name}" is ${size} bytes; the limit is ${cfg.max_file_bytes}`);
  }
  return version;
}

function orderKey(version) {
  return [version.effective_date, version.modified_at, version.created_at, version.file_id];
}

function runKey(run) {
  return [run.effective_date, run.source_modified_at, run.source_created_at, run.source_file_id];
}

function selectNextBatch(input) {
  const cfg = withDefaults(input && input.config);
  const params = (input && input.params) || {};
  const nowText = normalizeTimestamp(input && input.now);
  if (nowText === null) throw new SheetOpsError('INVALID_LISTING', '`now` must be an ISO 8601 UTC timestamp');
  const now = Date.parse(nowText);
  const runs = readRunLog(input.runLog);
  const files = Array.isArray(input.files) ? input.files : [];
  const result = (action, extra) => Object.assign({
    action, code: '', message: '', batch: null, queue_remaining: 0, stale_runs: [],
    confirm_mass_discontinue: false, reprocess: false,
  }, extra);

  // A partial listing could hide an older file and break the processing order,
  // so SheetOps never works from one (§2).
  if (files.length > cfg.max_listed_files) {
    return result('BLOCKED', {
      code: 'QUEUE_TOO_LARGE',
      message: `More than ${cfg.max_listed_files} files are in the inbox (${files.length} listed). `
        + `Move processed files to another folder until at most ${cfg.max_listed_files} remain, then run again`,
    });
  }
  if (input.listing_complete === false) {
    return result('BLOCKED', {
      code: 'QUEUE_TOO_LARGE',
      message: `Drive returned the inbox listing in more than one page (${files.length} file${files.length === 1 ? '' : 's'} on the first page). `
        + `Run again; if this repeats, move processed files to another folder`,
    });
  }
  const versions = files.map((file) => describeSourceFile(file, cfg));

  // A fresh STARTED row means another run is probably active.
  const staleRuns = [];
  const staleMs = cfg.stale_started_minutes * 60000;
  for (const run of runs) {
    if (run.status !== 'STARTED') continue;
    if (now - Date.parse(normalizeTimestamp(run.started_at)) < staleMs) {
      return result('WAIT', { code: 'RUN_IN_PROGRESS', message: `Run ${run.run_id} started at ${run.started_at}` });
    }
    staleRuns.push({ row_number: run.row_number, run_id: run.run_id, batch_id: run.batch_id });
  }

  const states = new Map();
  let committed = null;
  for (const run of runs) {
    if (run.batch_id === '') continue;
    if (!states.has(run.batch_id)) states.set(run.batch_id, { committed: false, rejected: false, halted: false, attempts: 0 });
    const state = states.get(run.batch_id);
    if (COMMITTED_STATUSES.includes(run.status)) {
      state.committed = true;
      if (!committed || compareKeys(runKey(run), committed.key) > 0) committed = { key: runKey(run), batch_id: run.batch_id };
    } else if (run.status === 'REJECTED_FILE') state.rejected = true;
    else if (run.status === 'HALTED_REVIEW') state.halted = true;
    else if (run.status === 'FAILED' || run.status === 'INTERRUPTED' || run.status === 'STARTED') state.attempts += 1;
  }
  const stateOf = (version) => states.get(version.batch_id) || { committed: false, rejected: false, halted: false, attempts: 0 };
  const open = (version) => !stateOf(version).committed && !stateOf(version).rejected;

  const prechecked = versions.filter((v) => v.reject_code !== '' && open(v)).sort((a, b) => compareKeys(
    [a.modified_at, a.created_at, a.file_id], [b.modified_at, b.created_at, b.file_id]));
  const valid = versions.filter((v) => v.reject_code === '' && open(v)).sort((a, b) => compareKeys(orderKey(a), orderKey(b)));
  const queued = prechecked.length + valid.length;
  const base = { stale_runs: staleRuns };

  // A stale STARTED row is a publication whose outcome nobody knows: it may
  // still land. Until a publish moves the version past it, only its own batch
  // may be published, so a newer batch can never overtake it (§2, §12).
  const unresolved = Array.from(new Set(staleRuns.map((run) => run.batch_id)));
  const pending = unresolved.length === 1 ? versions.find((v) => v.batch_id === unresolved[0]) : null;
  const unresolvedMessage = () => {
    const rows = staleRuns.map((run) => `row ${run.row_number} (run ${run.run_id}, ${run.batch_id})`).join('; ');
    return `Publication outcome unknown for ${rows}`;
  };

  if (params.target_batch_id || params.reprocess_latest) {
    const refuse = (code, message) => result('REFUSED', Object.assign({}, base, { code, message, queue_remaining: queued }));
    const targetId = params.reprocess_latest ? (committed ? committed.batch_id : '') : cellString(params.target_batch_id);
    if (unresolved.length > 0 && !(unresolved.length === 1 && targetId === unresolved[0])) {
      return refuse('PUBLICATION_UNRESOLVED', `${unresolvedMessage()}; only target_batch_id ${unresolved.join(', ')} can run`);
    }
    if (targetId === '') return refuse('NOTHING_COMMITTED', 'No batch has been committed yet');
    const version = versions.find((v) => v.batch_id === targetId);
    if (!version) return refuse('TARGET_NOT_IN_INBOX', `${targetId} is not in the inbox`);
    if (version.reject_code !== '') return refuse('TARGET_PRECHECK_FAILED', `${version.reject_code}: ${version.reject_message}`);
    if (stateOf(version).rejected) return refuse('TARGET_REJECTED', `${targetId} was rejected`);
    if (committed && compareKeys(orderKey(version), committed.key) < 0) {
      return refuse('TARGET_OUT_OF_ORDER', `${targetId} is older than the committed batch ${committed.batch_id}`);
    }
    return result('PROCESS', Object.assign({}, base, {
      batch: version,
      confirm_mass_discontinue: Boolean(params.confirm_mass_discontinue),
      reprocess: stateOf(version).committed,
      queue_remaining: queued - (open(version) ? 1 : 0),
    }));
  }

  if (unresolved.length > 0) {
    if (cfg.auto_recover_uncertain !== true) {
      return result('BLOCKED', Object.assign({}, base, {
        code: 'PUBLICATION_UNRESOLVED',
        message: `${unresolvedMessage()}. Its publish outcome is not established and automatic recovery is off. Inspect the evidence listed in docs/setup.md ("An unresolved publication"), then reprocess it explicitly with a manual run, target_batch_id ${unresolved.join(', ')}`,
        batch: pending, queue_remaining: queued,
      }));
    }
    if (!pending) {
      return result('BLOCKED', Object.assign({}, base, {
        code: 'PUBLICATION_UNRESOLVED',
        message: unresolved.length > 1
          ? `${unresolvedMessage()}. More than one batch is unresolved; see the recovery steps in docs/setup.md`
          : `${unresolvedMessage()}, and that file version is no longer in the inbox. Put it back, or see the recovery steps in docs/setup.md`,
        queue_remaining: queued,
      }));
    }
    const state = stateOf(pending);
    const recover = (extra) => result('PROCESS', Object.assign({}, base, { batch: pending, reprocess: state.committed, queue_remaining: queued - (open(pending) ? 1 : 0) }, extra));
    if (pending.reject_code !== '') {
      return result('REJECT_FILE', Object.assign({}, base, { code: pending.reject_code, message: pending.reject_message, batch: pending, queue_remaining: queued - (open(pending) ? 1 : 0) }));
    }
    if (state.halted) {
      return result('BLOCKED', Object.assign({}, base, { code: 'BATCH_HALTED', message: `${pending.batch_id} is waiting for a review decision`, batch: pending, queue_remaining: queued }));
    }
    if (state.attempts >= cfg.max_attempts) {
      return result('BLOCKED', Object.assign({}, base, { code: 'RETRY_LIMIT', message: `${pending.batch_id} failed ${state.attempts} times`, batch: pending, queue_remaining: queued }));
    }
    if (committed && !state.committed && compareKeys(orderKey(pending), committed.key) < 0) {
      return result('REJECT_FILE', Object.assign({}, base, {
        code: 'OUT_OF_ORDER_FILE', message: `${pending.name} (${pending.batch_id}) is older than the committed batch ${committed.batch_id}`, batch: pending, queue_remaining: queued - 1,
      }));
    }
    return recover({});
  }

  if (prechecked.length > 0) {
    const version = prechecked[0];
    return result('REJECT_FILE', Object.assign({}, base, {
      code: version.reject_code, message: version.reject_message, batch: version, queue_remaining: queued - 1,
    }));
  }
  for (const version of valid) {
    const state = stateOf(version);
    if (committed && compareKeys(orderKey(version), committed.key) < 0) {
      return result('REJECT_FILE', Object.assign({}, base, {
        code: 'OUT_OF_ORDER_FILE',
        message: `${version.name} (${version.batch_id}) is older than the committed batch ${committed.batch_id}`,
        batch: version,
        queue_remaining: queued - 1,
      }));
    }
    if (state.halted) {
      return result('BLOCKED', Object.assign({}, base, {
        code: 'BATCH_HALTED', message: `${version.batch_id} is waiting for a review decision`, batch: version, queue_remaining: queued,
      }));
    }
    if (state.attempts >= cfg.max_attempts) {
      return result('BLOCKED', Object.assign({}, base, {
        code: 'RETRY_LIMIT', message: `${version.batch_id} failed ${state.attempts} times`, batch: version, queue_remaining: queued,
      }));
    }
    return result('PROCESS', Object.assign({}, base, { batch: version, queue_remaining: queued - 1 }));
  }
  return result('IDLE', base);
}

// ---------------------------------------------------------------------------
// Run Log rows (§11)
// ---------------------------------------------------------------------------

function makeRunRow(run, batch, status, fields, cfg) {
  const row = {};
  for (const column of RUNLOG_COLUMNS) row[column] = '';
  const info = run || {};
  row.run_id = cellString(info.run_id);
  row.mode = cellString(info.mode);
  row.status = status;
  row.started_at = cellString(info.started_at);
  row.finished_at = cellString(info.finished_at);
  if (batch) {
    row.batch_id = batch.batch_id;
    row.source_file_id = batch.file_id;
    row.source_name = batch.name;
    row.effective_date = batch.effective_date;
    row.source_modified_at = batch.modified_at;
    row.source_created_at = batch.created_at;
  }
  row.queue_remaining = info.queue_remaining === undefined ? '' : info.queue_remaining;
  Object.assign(row, fields || {});
  row.error_message = truncate(row.error_message, (cfg || DEFAULT_CONFIG).max_message_length);
  return row;
}

function buildStartedRow(run, batch) {
  return makeRunRow(run, batch, 'STARTED', { finished_at: '' });
}

function buildBlockedRow(run, selection) {
  return makeRunRow(run, selection.batch, 'BLOCKED', { error_code: selection.code, error_message: selection.message });
}

function buildFailedRunRow(run, batch, code, message) {
  return makeRunRow(run, batch, 'FAILED', { error_code: code, error_message: message });
}

function rowToValues(columns, row) {
  return columns.map((column) => (row[column] === undefined ? '' : row[column]));
}

// ---------------------------------------------------------------------------
// Processing a batch (§5–§9)
// ---------------------------------------------------------------------------

function requireBatch(batch, needEffectiveDate) {
  if (!batch || !BATCH_ID_PATTERN.test(cellString(batch.batch_id))) {
    throw new SheetOpsError('PLAN_INVALID', 'batch is missing or has a malformed batch_id');
  }
  if (needEffectiveDate && !isDateString(batch.effective_date)) {
    throw new SheetOpsError('PLAN_INVALID', `batch ${batch.batch_id} has no effective date`);
  }
  return batch;
}

function exceptionId(batchId, row, code, field) {
  return `EX|${batchId}|${row}|${code}${field ? `|${field}` : ''}`;
}

function makeException(ctx, row, skuRaw, sku, severity, error, action) {
  return {
    exception_id: exceptionId(ctx.batch.batch_id, row, error.code, error.field),
    batch_id: ctx.batch.batch_id,
    source_file: ctx.batch.name,
    source_row: row,
    sku_raw: skuRaw,
    severity,
    code: error.code,
    field: error.field,
    raw_value: error.raw,
    message: error.message,
    action,
    _sku: sku,
  };
}

function pickColumns(columns, row) {
  const out = {};
  for (const column of columns) out[column] = row[column] === undefined ? '' : row[column];
  return out;
}

function proposalSummary(proposal) {
  return `${proposal.name} | ${proposal.unit} | ${formatCents(proposal.cents)}`;
}

function sameProposal(a, b) {
  return a.name === b.name && a.unit === b.unit && a.cents === b.cents;
}

function decisionState(decision) {
  const text = cellString(decision).trim().toUpperCase();
  if (text === '') return 'PENDING';
  if (text === 'APPROVE') return 'APPROVED';
  return 'INVALID_DECISION';
}

// §7 review triggers, in the fixed order unit, price, name.
function reviewTriggers(current, proposal, cfg) {
  const triggers = [];
  if (current.unit !== proposal.unit) triggers.push('UNIT_CHANGED');
  else if (current.cents !== proposal.cents
    && Math.abs(proposal.cents - current.cents) * 100 >= cfg.review_price_change_pct * current.cents) {
    triggers.push('LARGE_PRICE_CHANGE');
  }
  if (current.name !== proposal.name) triggers.push('NAME_CHANGED');
  return triggers;
}

function fileRejectionPlan(ctx, problems, rowsRead) {
  const exceptions = problems.map((p) => makeException(ctx, 0, '', '', 'ERROR', p, 'FILE_NOT_PROCESSED'));
  const fresh = exceptions.filter((e) => !ctx.existingExceptionIds.has(e.exception_id));
  return {
    status: 'REJECTED_FILE',
    batch: ctx.batch,
    row_outcomes: [],
    writes: {
      catalog: null,
      review: null,
      changes: [],
      exceptions: fresh.map((e) => pickColumns(EXCEPTIONS_COLUMNS, e)),
    },
    run_row: makeRunRow(ctx.run, ctx.batch, 'REJECTED_FILE', {
      rows_read: rowsRead,
      exceptions: exceptions.length,
      exceptions_new: fresh.length,
      error_code: problems[0].code,
      error_message: problems.map((p) => p.message).join('; '),
    }, ctx.cfg),
    stale_runs: ctx.staleRuns,
    next_rows: ctx.nextRows,
    summary: { rows_read: rowsRead, exceptions: exceptions.length, exceptions_new: fresh.length, warnings: [] },
  };
}

function haltPlan(ctx, missing, activeCount, rowsRead) {
  const tenths = percentTenths(missing.length, activeCount);
  const listed = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ', ...' : '');
  const message = `${missing.length} of ${activeCount} active SKUs are absent (${formatTenths(tenths)}%, limit ${ctx.cfg.mass_discontinue_pct}%): ${listed}`;
  const problem = fileProblem('MASS_DISCONTINUE', '', `${missing.length}/${activeCount}`, message);
  const exception = makeException(ctx, 0, '', '', 'REVIEW', problem, 'FILE_NOT_PROCESSED');
  const fresh = ctx.existingExceptionIds.has(exception.exception_id) ? [] : [exception];
  return {
    status: 'HALTED_REVIEW',
    batch: ctx.batch,
    row_outcomes: [],
    writes: { catalog: null, review: null, changes: [], exceptions: fresh.map((e) => pickColumns(EXCEPTIONS_COLUMNS, e)) },
    run_row: makeRunRow(ctx.run, ctx.batch, 'HALTED_REVIEW', {
      rows_read: rowsRead,
      exceptions: 1,
      exceptions_new: fresh.length,
      error_code: 'MASS_DISCONTINUE',
      error_message: message,
    }, ctx.cfg),
    stale_runs: ctx.staleRuns,
    next_rows: ctx.nextRows,
    summary: { rows_read: rowsRead, missing, active: activeCount, exceptions: 1, exceptions_new: fresh.length, warnings: [] },
  };
}

// Used by the workflow for rejections decided before download (§2):
// BAD_FILENAME, WRONG_SUPPLIER, OUT_OF_ORDER_FILE.
function planFileRejection(input) {
  const cfg = withDefaults(input.config);
  const batch = requireBatch(input.batch, false);
  const sheet = input.sheet || {};
  const ctx = {
    cfg,
    batch,
    run: input.run || {},
    staleRuns: input.stale_runs || [],
    existingExceptionIds: readIdColumn(sheet.exceptions, EXCEPTIONS_COLUMNS, TABS.exceptions),
    nextRows: nextRows(sheet),
  };
  return fileRejectionPlan(ctx, [fileProblem(input.code, '', batch.name, cellString(input.message))], '');
}

function processBatch(input) {
  const cfg = withDefaults(input && input.config);
  const batch = requireBatch(input && input.batch, true);
  const options = input.options || {};
  const sheet = input.sheet || {};
  const catalog = readCatalog(sheet.catalog, cfg);
  const reviews = readReview(sheet.review, cfg);
  const existingChangeIds = readIdColumn(sheet.changes, CHANGES_COLUMNS, TABS.changes);
  const existingExceptionIds = readIdColumn(sheet.exceptions, EXCEPTIONS_COLUMNS, TABS.exceptions);
  const ctx = { cfg, batch, run: input.run || {}, staleRuns: input.stale_runs || [], existingExceptionIds, nextRows: nextRows(sheet) };
  const eff = batch.effective_date;

  // File-level checks (§1, §3, §4). Each rejects the whole file.
  const text = cellString(input.csvText);
  const bytes = utf8ByteLength(text);
  if (bytes > cfg.max_file_bytes) {
    return fileRejectionPlan(ctx, [fileProblem('FILE_TOO_LARGE', '', String(bytes),
      `File is ${bytes} bytes; the limit is ${cfg.max_file_bytes}`)], '');
  }
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    if (!(err instanceof CsvParseError)) throw err;
    return fileRejectionPlan(ctx, [fileProblem('CSV_PARSE_ERROR', '', `line ${err.line}`, err.message)], '');
  }
  if (records.length === 0) return fileRejectionPlan(ctx, [fileProblem('FILE_EMPTY', '', '', 'The file is empty')], 0);
  const header = mapHeader(records[0].fields);
  const data = records.slice(1);
  if (header.problems.length > 0) return fileRejectionPlan(ctx, header.problems, data.length);
  if (data.length > cfg.max_data_rows) {
    return fileRejectionPlan(ctx, [fileProblem('TOO_MANY_ROWS', '', String(data.length),
      `File has ${data.length} data rows; the limit is ${cfg.max_data_rows}`)], data.length);
  }
  const rows = data.map((record) => classifyRecord(record, header, cfg));
  if (rows.every((row) => row.kind === 'BLANK')) {
    return fileRejectionPlan(ctx, [fileProblem('FILE_EMPTY', '', '', 'The file has no data rows')], data.length);
  }

  // §11 disappearance safety stop. "Present" means any row with a valid SKU.
  const present = new Set(rows.filter((row) => row.sku !== '').map((row) => row.sku));
  const catalogSkus = Array.from(catalog.keys()).sort(compareStrings);
  const active = catalogSkus.filter((sku) => catalog.get(sku).status === 'ACTIVE');
  const missing = active.filter((sku) => !present.has(sku));
  if (active.length > 0 && missing.length * 100 > cfg.mass_discontinue_pct * active.length && !options.confirm_mass_discontinue) {
    return haltPlan(ctx, missing, active.length, data.length);
  }

  const outcomes = new Map();
  const exceptions = [];
  const changes = [];
  const setOutcome = (row, outcome) => outcomes.set(row.row, { row: row.row, outcome, sku: row.sku });
  const actionFor = (sku) => (sku !== '' && catalog.has(sku) ? 'KEPT_PREVIOUS' : 'NOT_ADDED');

  for (const row of rows) {
    if (row.kind === 'BLANK') setOutcome(row, 'BLANK');
    if (row.kind === 'REJECTED') {
      setOutcome(row, 'REJECTED');
      for (const error of row.errors) exceptions.push(makeException(ctx, row.row, row.skuRaw, row.sku, 'ERROR', error, actionFor(row.sku)));
    }
  }

  // §6 grouping by SKU.
  const groups = new Map();
  for (const row of rows) {
    if (row.sku === '') continue;
    if (!groups.has(row.sku)) groups.set(row.sku, { valid: [], rejected: [] });
    if (row.kind === 'VALID') groups.get(row.sku).valid.push(row);
    else groups.get(row.sku).rejected.push(row);
  }
  const singles = [];
  for (const sku of Array.from(groups.keys()).sort(compareStrings)) {
    const group = groups.get(sku);
    const reps = [];
    const repByKey = new Map();
    for (const row of group.valid) {
      const key = JSON.stringify([row.value.name, row.value.unit, row.value.cents, row.value.currency]);
      const rep = repByKey.get(key);
      if (rep) {
        setOutcome(row, 'COLLAPSED');
        exceptions.push(makeException(ctx, row.row, row.skuRaw, sku, 'INFO',
          fieldError('DUPLICATE_COLLAPSED', '', '', `Identical to row ${rep.row}`), 'IGNORED'));
      } else {
        repByKey.set(key, row);
        reps.push(row);
      }
    }
    if (reps.length === 0) continue;
    if (group.rejected.length > 0) {
      const rejectedRows = group.rejected.map((row) => row.row).join(', ');
      for (const rep of reps) {
        setOutcome(rep, 'HELD_CONFLICT');
        exceptions.push(makeException(ctx, rep.row, rep.skuRaw, sku, 'REVIEW', fieldError('SIBLING_ROW_INVALID', '', '',
          `Another row for ${sku} was rejected (row ${rejectedRows}); previous catalog values kept`), actionFor(sku)));
      }
    } else if (reps.length > 1) {
      const repRows = reps.map((row) => row.row).join(', ');
      for (const rep of reps) {
        setOutcome(rep, 'HELD_CONFLICT');
        exceptions.push(makeException(ctx, rep.row, rep.skuRaw, sku, 'REVIEW', fieldError('CONFLICTING_DUPLICATE', '', '',
          `Rows ${repRows} for ${sku} disagree; previous catalog values kept`), actionFor(sku)));
      }
    } else singles.push({ sku, rep: reps[0] });
  }

  // §7 changes and reviews.
  const next = new Map();
  for (const sku of catalogSkus) next.set(sku, Object.assign({}, catalog.get(sku)));
  const outReviews = new Map();
  const handled = new Set();
  let reviewsOpened = 0;

  const addChange = (fields) => changes.push(Object.assign({
    batch_id: batch.batch_id, effective_date: eff, old_value: '', new_value: '', change_pct: '', review_id: '', note: '',
  }, fields));
  const addAuto = (sku, type, oldValue, newValue, pct) => addChange({
    event_id: `EV|${batch.batch_id}|${sku}|${type}`, sku, change_type: type, disposition: 'APPLIED',
    old_value: oldValue, new_value: newValue, change_pct: pct === undefined ? '' : pct,
  });
  const supersede = (item) => addChange({
    event_id: `${item.review_id}|REVIEW_SUPERSEDED`, sku: item.sku, change_type: 'REVIEW_SUPERSEDED',
    disposition: 'NOT_APPLIED', old_value: proposalSummary(item.proposal), review_id: item.review_id, note: cellString(item.note),
  });
  // One change row per differing field, for held or approved proposals.
  const addFieldChanges = (sku, current, proposal, reviewId, suffix, disposition, note) => {
    const add = (type, oldValue, newValue, pct) => addChange({
      event_id: `${reviewId}|${type}|${suffix}`, sku, change_type: type, disposition,
      old_value: oldValue, new_value: newValue, change_pct: pct, review_id: reviewId, note,
    });
    if (current.cents !== proposal.cents) {
      add('PRICE_CHANGED', formatCents(current.cents), formatCents(proposal.cents),
        current.unit === proposal.unit ? changePct(current.cents, proposal.cents) : '');
    }
    if (current.unit !== proposal.unit) add('UNIT_CHANGED', current.unit, proposal.unit, '');
    if (current.name !== proposal.name) add('NAME_CHANGED', current.name, proposal.name, '');
  };

  for (const { sku, rep } of singles) {
    handled.add(sku);
    const proposal = { name: rep.value.name, unit: rep.value.unit, cents: rep.value.cents };
    const current = next.get(sku);
    const item = reviews.get(sku);

    if (!current) {
      if (item) supersede(item);
      next.set(sku, {
        sku, name: proposal.name, unit: proposal.unit, cents: proposal.cents, currency: cfg.currency,
        status: 'ACTIVE', previousCents: null, first_seen: eff, last_seen: eff, last_changed: eff,
      });
      addAuto(sku, 'NEW_ITEM', '', proposalSummary(proposal));
      setOutcome(rep, 'ACCEPTED');
      continue;
    }

    const triggers = reviewTriggers(current, proposal, cfg);
    if (triggers.length === 0) {
      // Equal to the catalog, or a price change below the review threshold.
      if (item) supersede(item);
      if (current.status === 'DISCONTINUED') {
        addAuto(sku, 'REACTIVATED', 'DISCONTINUED', 'ACTIVE');
        current.status = 'ACTIVE';
        current.last_changed = eff;
      }
      if (current.cents !== proposal.cents) {
        addAuto(sku, 'PRICE_CHANGED', formatCents(current.cents), formatCents(proposal.cents), changePct(current.cents, proposal.cents));
        current.previousCents = current.cents;
        current.cents = proposal.cents;
        current.last_changed = eff;
      }
      setOutcome(rep, 'ACCEPTED');
      continue;
    }

    if (item && sameProposal(item.proposal, proposal)) {
      if (decisionState(item.decision) === 'APPROVED') {
        const note = cellString(item.note);
        if (current.status === 'DISCONTINUED') {
          addChange({
            event_id: `${item.review_id}|REACTIVATED|APPLIED`, sku, change_type: 'REACTIVATED', disposition: 'APPLIED_AFTER_REVIEW',
            old_value: 'DISCONTINUED', new_value: 'ACTIVE', review_id: item.review_id, note,
          });
        }
        addFieldChanges(sku, current, proposal, item.review_id, 'APPLIED', 'APPLIED_AFTER_REVIEW', note);
        if (current.cents !== proposal.cents) current.previousCents = current.cents;
        Object.assign(current, { name: proposal.name, unit: proposal.unit, cents: proposal.cents, status: 'ACTIVE', last_changed: eff });
        setOutcome(rep, 'ACCEPTED');
        continue;
      }
      outReviews.set(sku, Object.assign({}, item, { last_seen: eff, source_row: rep.row }));
      setOutcome(rep, 'HELD_REVIEW');
      continue;
    }

    if (item) {
      if (item.firstBatchId === batch.batch_id) {
        throw new SheetOpsError('REVIEW_INVALID', `Review item ${item.review_id} does not match row ${rep.row} of its own batch; the Review tab was edited by hand`);
      }
      supersede(item);
    }
    const reviewId = `RV|${sku}|${batch.batch_id}`;
    addFieldChanges(sku, current, proposal, reviewId, 'HELD', 'HELD_FOR_REVIEW', '');
    outReviews.set(sku, {
      review_id: reviewId, sku, firstBatchId: batch.batch_id, proposal,
      first_seen: eff, last_seen: eff, source_row: rep.row, decision: '', note: '',
    });
    reviewsOpened += 1;
    setOutcome(rep, 'HELD_REVIEW');
  }

  // Open items not decided above: superseded if absent, otherwise untouched.
  for (const sku of Array.from(reviews.keys()).sort(compareStrings)) {
    if (handled.has(sku)) continue;
    const item = reviews.get(sku);
    if (present.has(sku)) outReviews.set(sku, item);
    else supersede(item);
  }

  // Presence and discontinuation (§6, §7).
  for (const sku of Array.from(next.keys()).sort(compareStrings)) {
    const entry = next.get(sku);
    if (present.has(sku)) entry.last_seen = eff;
    else if (entry.status === 'ACTIVE') {
      addAuto(sku, 'DISCONTINUED', 'ACTIVE', 'DISCONTINUED');
      entry.status = 'DISCONTINUED';
      entry.last_changed = eff;
    }
  }

  exceptions.sort((a, b) => a.source_row - b.source_row);
  changes.sort((a, b) => compareStrings(a.sku, b.sku)
    || CHANGE_TYPE_ORDER.indexOf(a.change_type) - CHANGE_TYPE_ORDER.indexOf(b.change_type)
    || compareStrings(a.event_id, b.event_id));

  // last_issue: this batch's ERROR/REVIEW exceptions per catalog SKU.
  const issues = new Map();
  for (const e of exceptions) {
    if (e.severity === 'INFO' || e._sku === '' || !next.has(e._sku)) continue;
    if (!issues.has(e._sku)) issues.set(e._sku, new Map());
    const byCode = issues.get(e._sku);
    if (!byCode.has(e.code)) byCode.set(e.code, []);
    byCode.get(e.code).push(e.source_row);
  }
  const issueText = (sku) => {
    if (!issues.has(sku)) return '';
    return Array.from(issues.get(sku).entries())
      .map(([code, rowNumbers]) => `${code} (${rowNumbers.length === 1 ? 'row' : 'rows'} ${rowNumbers.join(', ')})`)
      .join('; ');
  };

  const catalogRows = Array.from(next.keys()).sort(compareStrings).map((sku) => {
    const e = next.get(sku);
    return {
      sku,
      name: e.name,
      unit: e.unit,
      unit_price: centsToNumber(e.cents),
      currency: e.currency,
      status: e.status,
      previous_price: e.previousCents === null ? '' : centsToNumber(e.previousCents),
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      last_changed: e.last_changed,
      pending_review: outReviews.has(sku) ? outReviews.get(sku).review_id : '',
      last_issue: issueText(sku),
    };
  });
  if (catalogRows.length > cfg.max_catalog_rows) {
    throw new SheetOpsError('PLAN_INVALID', `Catalog would grow to ${catalogRows.length} rows; the limit is ${cfg.max_catalog_rows}`);
  }

  const warnings = [];
  const reviewRows = Array.from(outReviews.keys()).sort(compareStrings).map((sku) => {
    const item = outReviews.get(sku);
    const current = next.get(sku);
    const state = decisionState(item.decision);
    if (state === 'INVALID_DECISION') warnings.push(`INVALID_DECISION ${item.review_id}`);
    const sameUnit = current && current.unit === item.proposal.unit;
    return {
      review_id: item.review_id,
      sku,
      status: state,
      reasons: current ? reviewTriggers(current, item.proposal, cfg).join(', ') : '',
      current_name: current ? current.name : '',
      current_unit: current ? current.unit : '',
      current_price: current ? centsToNumber(current.cents) : '',
      proposed_name: item.proposal.name,
      proposed_unit: item.proposal.unit,
      proposed_price: centsToNumber(item.proposal.cents),
      change_pct: sameUnit && current.cents !== item.proposal.cents ? changePct(current.cents, item.proposal.cents) : '',
      first_seen: item.first_seen,
      last_seen: item.last_seen,
      source_row: item.source_row,
      decision: item.decision === undefined || item.decision === null ? '' : item.decision,
      note: item.note === undefined || item.note === null ? '' : item.note,
    };
  });

  // Plan checks: accounting (§6) and identifier uniqueness (§9).
  const counts = {};
  for (const outcome of OUTCOMES) counts[outcome] = 0;
  for (const entry of outcomes.values()) counts[entry.outcome] += 1;
  const accounted = OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
  if (outcomes.size !== rows.length || accounted !== rows.length) {
    throw new SheetOpsError('PLAN_INVALID', `Row accounting failed: ${accounted} outcomes for ${rows.length} rows`);
  }
  const assertUnique = (list, key) => {
    const seen = new Set();
    for (const item of list) {
      if (seen.has(item[key])) throw new SheetOpsError('PLAN_INVALID', `Duplicate ${key} ${item[key]}`);
      seen.add(item[key]);
    }
  };
  assertUnique(changes, 'event_id');
  assertUnique(exceptions, 'exception_id');

  const newChanges = changes.filter((c) => !existingChangeIds.has(c.event_id));
  const newExceptions = exceptions.filter((e) => !existingExceptionIds.has(e.exception_id));
  const applied = changes.filter((c) => c.disposition === 'APPLIED' || c.disposition === 'APPLIED_AFTER_REVIEW').length;
  const attention = exceptions.some((e) => e.severity !== 'INFO') || reviewRows.length > 0;
  const status = attention ? 'SUCCESS_WITH_EXCEPTIONS' : 'SUCCESS';

  const summary = {
    rows_read: rows.length,
    accepted: counts.ACCEPTED,
    collapsed: counts.COLLAPSED,
    rejected: counts.REJECTED,
    held_conflict: counts.HELD_CONFLICT,
    held_review: counts.HELD_REVIEW,
    blank: counts.BLANK,
    changes_applied: applied,
    reviews_opened: reviewsOpened,
    reviews_pending: reviewRows.length,
    exceptions: exceptions.length,
    exceptions_new: newExceptions.length,
  };

  return {
    status,
    batch,
    row_outcomes: Array.from(outcomes.values()).sort((a, b) => a.row - b.row),
    writes: {
      catalog: catalogRows,
      review: reviewRows,
      changes: newChanges.map((c) => pickColumns(CHANGES_COLUMNS, c)),
      exceptions: newExceptions.map((e) => pickColumns(EXCEPTIONS_COLUMNS, e)),
    },
    run_row: makeRunRow(ctx.run, batch, status, summary, cfg),
    stale_runs: ctx.staleRuns,
    next_rows: ctx.nextRows,
    summary: Object.assign({}, summary, {
      changes_detected: changes.length,
      changes_new: newChanges.length,
      ignored_columns: header.ignored,
      warnings,
    }),
  };
}

// ---------------------------------------------------------------------------
// Publication (§12)
// ---------------------------------------------------------------------------

function toCell(value) {
  if (value === '' || value === null || value === undefined) return {};
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SheetOpsError('PLAN_INVALID', `Non-finite number ${value}`);
    return { userEnteredValue: { numberValue: value } };
  }
  // stringValue is stored as text; it is never parsed as a formula.
  return { userEnteredValue: { stringValue: String(value) } };
}

function toRowData(columns, row) {
  return { values: columns.map((column) => toCell(row[column])) };
}

function requireTabMeta(sheetMeta, tab, columns) {
  const meta = sheetMeta && sheetMeta[tab];
  if (!meta || !Number.isInteger(meta.sheetId) || !Number.isInteger(meta.rowCount) || !Number.isInteger(meta.columnCount)) {
    throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `Metadata for the ${tab} tab is missing`);
  }
  if (meta.columnCount < columns.length) {
    throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `${tab} tab has ${meta.columnCount} columns; ${columns.length} are needed`);
  }
  return meta;
}

function runRowRequest(meta, runRowNumber, row) {
  return {
    updateCells: {
      range: {
        sheetId: meta.sheetId, startRowIndex: runRowNumber - 1, endRowIndex: runRowNumber,
        startColumnIndex: 0, endColumnIndex: RUNLOG_COLUMNS.length,
      },
      rows: [toRowData(RUNLOG_COLUMNS, row)],
      fields: 'userEnteredValue',
    },
  };
}

function finishBody(requests, cfg) {
  const body = { requests, includeSpreadsheetInResponse: false };
  const size = utf8ByteLength(JSON.stringify(body));
  if (size > cfg.max_request_bytes) {
    throw new SheetOpsError('PUBLISH_TOO_LARGE', `Publish request is ${size} bytes; the limit is ${cfg.max_request_bytes}`);
  }
  return body;
}

function checkRunRowNumber(runRowNumber, meta) {
  if (!Number.isInteger(runRowNumber) || runRowNumber < 2 || runRowNumber > meta.rowCount) {
    throw new SheetOpsError('PLAN_INVALID', `Run row number ${runRowNumber} is outside the Run Log grid`);
  }
}

// The version this publish moves from and to (§12). `from` is the ID of the
// version tab as read in step 5 (null before the first publish); `to` is
// higher than every ID used before, also after the tab is deleted by hand,
// because it is at least the seconds since 2026-01-01 above VERSION_BASE.
function publicationVersion(sheetMeta, startedAt) {
  const tab = sheetMeta && sheetMeta[VERSION_TAB];
  let from = null;
  if (tab) {
    if (!Number.isInteger(tab.sheetId) || tab.sheetId <= VERSION_BASE || tab.sheetId >= VERSION_MAX) {
      throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `The ${VERSION_TAB} tab has sheet ID ${tab.sheetId}, which SheetOps did not create`);
    }
    from = tab.sheetId;
  }
  const started = normalizeTimestamp(startedAt);
  if (started === null) throw new SheetOpsError('PLAN_INVALID', 'The run row has no valid started_at');
  const seconds = Math.floor((Date.parse(started) - VERSION_EPOCH) / 1000);
  const to = Math.max((from === null ? VERSION_BASE : from) + 1, VERSION_BASE + seconds);
  if (to > VERSION_MAX) throw new SheetOpsError('PLAN_INVALID', 'Publication version IDs are exhausted');
  for (const [title, meta] of Object.entries(sheetMeta || {})) {
    if (meta.sheetId === to) throw new SheetOpsError('PLAN_INVALID', `Version ID ${to} is already used by the "${title}" tab`);
  }
  return { from, to };
}

// Builds the single spreadsheets.batchUpdate body. It starts with the version
// check and ends with the commit marker, the rewrite of this run's STARTED row.
function buildPublishRequest(input) {
  const cfg = withDefaults(input.config);
  const plan = input.plan;
  const sheetMeta = input.sheetMeta;
  const runRowNumber = input.runRowNumber;
  const requests = [];

  const replace = (tab, columns, rows) => {
    const meta = requireTabMeta(sheetMeta, tab, columns);
    const needed = rows.length + 1;
    if (needed > meta.rowCount) {
      requests.push({ appendDimension: { sheetId: meta.sheetId, dimension: 'ROWS', length: needed - meta.rowCount } });
    }
    const end = Math.max(meta.rowCount, needed);
    if (end <= 1) return;
    // Cells in the range that `rows` does not cover are cleared.
    requests.push({
      updateCells: {
        range: { sheetId: meta.sheetId, startRowIndex: 1, endRowIndex: end, startColumnIndex: 0, endColumnIndex: columns.length },
        rows: rows.map((row) => toRowData(columns, row)),
        fields: 'userEnteredValue',
      },
    });
  };
  const writeAt = (tab, columns, rows, firstRow) => {
    if (rows.length === 0) return;
    const meta = requireTabMeta(sheetMeta, tab, columns);
    if (!Number.isInteger(firstRow) || firstRow < 2) throw new SheetOpsError('PLAN_INVALID', `${tab} start row ${firstRow} is not a data row`);
    const end = firstRow - 1 + rows.length;
    if (end > meta.rowCount) requests.push({ appendDimension: { sheetId: meta.sheetId, dimension: 'ROWS', length: end - meta.rowCount } });
    requests.push({
      updateCells: {
        range: { sheetId: meta.sheetId, startRowIndex: firstRow - 1, endRowIndex: end, startColumnIndex: 0, endColumnIndex: columns.length },
        rows: rows.map((row) => toRowData(columns, row)),
        fields: 'userEnteredValue',
      },
    });
  };

  const version = publicationVersion(sheetMeta, plan.run_row.started_at);
  if (version.from !== null) requests.push({ deleteSheet: { sheetId: version.from } });
  requests.push({
    addSheet: { properties: { sheetId: version.to, title: VERSION_TAB, hidden: true, gridProperties: { rowCount: 1, columnCount: 1 } } },
  });

  if (plan.writes.catalog) replace(TABS.catalog, CATALOG_COLUMNS, plan.writes.catalog);
  if (plan.writes.review) replace(TABS.review, REVIEW_COLUMNS, plan.writes.review);
  const next = plan.next_rows || {};
  writeAt(TABS.changes, CHANGES_COLUMNS, plan.writes.changes, next.changes);
  writeAt(TABS.exceptions, EXCEPTIONS_COLUMNS, plan.writes.exceptions, next.exceptions);

  const log = requireTabMeta(sheetMeta, TABS.runLog, RUNLOG_COLUMNS);
  checkRunRowNumber(runRowNumber, log);
  const statusColumn = RUNLOG_COLUMNS.indexOf('status');
  for (const stale of plan.stale_runs || []) {
    if (stale.row_number === runRowNumber) continue;
    requests.push({
      updateCells: {
        range: {
          sheetId: log.sheetId, startRowIndex: stale.row_number - 1, endRowIndex: stale.row_number,
          startColumnIndex: statusColumn, endColumnIndex: statusColumn + 1,
        },
        rows: [{ values: [toCell('INTERRUPTED')] }],
        fields: 'userEnteredValue',
      },
    });
  }
  requests.push(runRowRequest(log, runRowNumber, plan.run_row));
  return finishBody(requests, cfg);
}

// 4xx (except 408) means Google refused the request, so nothing was applied.
function classifyPublishFailure(failure) {
  const status = failure && failure.httpStatus;
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) return 'REJECTED';
  return 'UNKNOWN';
}

// A publish error as a failure (§12): definitive when Google refused the
// request, unknown when it may have been applied.
function publishFailure(result) {
  const definitive = result.outcome === 'REJECTED';
  const status = Number.isInteger(result.httpStatus) ? `HTTP ${result.httpStatus}: ` : '';
  return {
    kind: definitive ? 'DEFINITIVE' : 'UNKNOWN',
    code: definitive ? 'PUBLISH_REJECTED' : 'PUBLISH_OUTCOME_UNKNOWN',
    message: `${status}${cellString(result.message)}`,
  };
}

// One Run Log row read without its header, by column position.
function runRowFacts(cells) {
  const row = Array.isArray(cells) ? cells : [];
  const at = (column) => cellString(row[RUNLOG_COLUMNS.indexOf(column)]).trim();
  return { run_id: at('run_id'), status: at('status'), batch_id: at('batch_id') };
}

// Step 6 check (§12): every row the publish overwrites by position must still
// hold what this run expects. This run's row must be its own STARTED row, or
// nothing is published. A stale row that has moved is dropped from this
// run's INTERRUPTED marks and left for a later run.
function verifyRunLogRows(input) {
  const byRow = new Map(readRunLog(input.runLog).map((run) => [run.row_number, run]));
  const n = input.runRowNumber;
  const own = byRow.get(n);
  if (!own || own.run_id !== cellString(input.run && input.run.run_id)
    || own.batch_id !== cellString(input.batch && input.batch.batch_id) || own.status !== 'STARTED') {
    const shows = own ? `run ${own.run_id}, ${own.status}` : 'no row';
    throw new SheetOpsError('RUN_ROW_UNVERIFIED', `Run Log row ${n} shows ${shows}, not this run's STARTED row; was the Run Log edited during the run?`);
  }
  return (input.staleRuns || []).filter((stale) => {
    const current = byRow.get(stale.row_number);
    return Boolean(current) && current.run_id === stale.run_id && current.status === 'STARTED';
  });
}

// The final Review check (§8), just before the publish. `planned` is the
// Review range of the step 6 read the plan was built from (rows of values,
// header first); `finalRead` is the values.get response of the final read.
// Every operator decision and note must be identical, type included, for the
// same set of review IDs. Row order does not matter: items are matched by
// review_id. Throws REVIEW_READ_FAILED or REVIEW_CHANGED; either way nothing
// may be published. An edit saved after this read can still be lost (§8).
function checkReviewUnchanged(input) {
  let finalValues;
  try {
    finalValues = parseValueRange(input.finalRead, 'the Review tab for the final check');
  } catch (err) {
    if (!(err instanceof SheetOpsError)) throw err;
    throw new SheetOpsError('REVIEW_READ_FAILED', `${err.detail}. Nothing was published`);
  }
  const decisions = (values) => {
    const items = new Map();
    for (const row of readTable(values, REVIEW_COLUMNS, TABS.review)) {
      const id = cellString(row.review_id).trim();
      if (items.has(id)) throw new SheetOpsError('REVIEW_CHANGED', `Review lists ${id} twice`);
      items.set(id, { decision: row.decision, note: row.note });
    }
    return items;
  };
  const before = decisions(input.planned);
  let after;
  try {
    after = decisions(finalValues);
  } catch (err) {
    if (!(err instanceof SheetOpsError)) throw err;
    throw new SheetOpsError('REVIEW_CHANGED', `In the final Review read: ${err.detail}. Nothing was published`);
  }
  const changes = [];
  for (const [id, item] of before) {
    const now = after.get(id);
    if (!now) changes.push(`${id} was removed`);
    else for (const field of ['decision', 'note']) if (now[field] !== item[field]) changes.push(`${id}: ${field} changed`);
  }
  for (const id of after.keys()) if (!before.has(id)) changes.push(`${id || 'a row with no review_id'} was added`);
  if (changes.length > 0) {
    const listed = changes.slice(0, 5).join('; ') + (changes.length > 5 ? `; and ${changes.length - 5} more` : '');
    throw new SheetOpsError('REVIEW_CHANGED', `Review changed after the plan was built (${listed}). Nothing was published; the batch must be processed again`);
  }
  return { items: before.size };
}

// Decides what this run may write after a failure (§12). `rowRead` is the
// step 8 read of this run's row (a values.get response, or { error }).
// `write` is the FAILED row to store, or null: nothing may be written.
// After an unknown publish outcome it is always null.
function resolveRunFailure(input) {
  const failure = input.failure;
  const n = input.runRowNumber;
  let facts = null;
  let shows;
  try {
    facts = runRowFacts(parseValueRange(input.rowRead, `Run Log row ${n}`)[0]);
    shows = facts.run_id === '' ? 'is empty' : `shows run ${facts.run_id}, ${facts.status}`;
  } catch (err) {
    if (!(err instanceof SheetOpsError)) throw err;
    shows = `could not be read (${err.detail})`;
  }
  const ours = facts !== null && facts.run_id === cellString(input.run && input.run.run_id)
    && facts.batch_id === cellString(input.batch && input.batch.batch_id);
  // Only this run could have finished its row, so unless the read shows it,
  // the row still says STARTED.
  const runStatus = ours ? facts.status : 'STARTED';

  if (failure.kind === 'UNKNOWN') {
    if (ours && facts.status === cellString(input.expectedStatus)) {
      return {
        outcome: 'CONFIRMED', write: null, run_status: facts.status, code: '',
        message: `The publish response was lost (${failure.message}); row ${n} shows ${facts.status}, so Google applied it`,
      };
    }
    return {
      outcome: 'UNKNOWN', write: null, run_status: runStatus, code: 'PUBLISH_OUTCOME_UNKNOWN',
      message: `${failure.message}; after the wait, row ${n} ${shows}. Nothing was written; the next run reconciles it once 15 minutes have passed`,
    };
  }
  if (ours && facts.status === 'STARTED') {
    return {
      outcome: 'FAILED', write: buildFailedRunRow(input.run, input.batch, failure.code, failure.message),
      run_status: 'FAILED', code: failure.code, message: failure.message,
    };
  }
  return {
    outcome: 'UNVERIFIED', write: null, run_status: runStatus, code: 'RUN_ROW_UNVERIFIED',
    message: `${failure.code}: ${failure.message}. FAILED was not written because row ${n} ${shows}`,
  };
}

// ---------------------------------------------------------------------------
// Google API requests and responses (§12). n8n's credential adds the access
// token; these functions only build URLs and bodies and check what comes back.
// ---------------------------------------------------------------------------

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

function columnLetter(count) {
  let letters = '';
  let n = count;
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function a1(tab, cells) {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

function queryString(params) {
  return Object.keys(params).map((key) => `${key}=${encodeURIComponent(params[key])}`).join('&');
}

function checkSettings(settings) {
  const s = settings || {};
  const fail = (why) => { throw new SheetOpsError('SETTINGS_INVALID', why); };
  const ids = {};
  for (const name of ['spreadsheet_id', 'inbox_folder_id']) {
    const value = cellString(s[name]).trim();
    if (value.startsWith('PASTE_')) fail(`${name} still holds its placeholder; paste the real ID into the Settings node`);
    if (!DRIVE_ID_PATTERN.test(value)) fail(`${name} "${value}" is not a Google ID`);
    ids[name] = value;
  }
  const supplier = cellString(s.supplier).trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(supplier)) fail(`supplier "${supplier}" must use lowercase letters, digits and hyphens`);
  const currency = cellString(s.currency).trim();
  if (!/^[A-Z]{3}$/.test(currency)) fail(`currency "${currency}" must be a three-letter code`);
  return { spreadsheet_id: ids.spreadsheet_id, inbox_folder_id: ids.inbox_folder_id, supplier, currency };
}

// Every read returns cells as stored: text as strings, numbers as numbers and
// date cells as serial day numbers, which sheetDate() reads (§10).
const READ_OPTIONS = queryString({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS' });

function buildGoogleRequests(settings) {
  const s = checkSettings(settings);
  const cfg = withDefaults({ supplier: s.supplier, currency: s.currency });
  const sheet = `${SHEETS_API}/${s.spreadsheet_id}`;
  const values = READ_OPTIONS;
  const working = [
    [TABS.catalog, `A1:${columnLetter(CATALOG_COLUMNS.length)}`],
    [TABS.review, `A1:${columnLetter(REVIEW_COLUMNS.length)}`],
    [TABS.changes, `A1:${columnLetter(CHANGES_COLUMNS.length)}1`],
    [TABS.changes, 'A2:A'],
    [TABS.exceptions, `A1:${columnLetter(EXCEPTIONS_COLUMNS.length)}1`],
    [TABS.exceptions, 'A2:A'],
    // Read again just before planning, to check the rows the publish overwrites (§12).
    [TABS.runLog, `A1:${columnLetter(RUNLOG_COLUMNS.length)}`],
  ];
  return {
    list_inbox: `${DRIVE_API}?${queryString({
      q: `'${s.inbox_folder_id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime)',
      pageSize: String(cfg.max_listed_files + 1),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })}`,
    read_run_log: `${sheet}/values/${encodeURIComponent(a1(TABS.runLog, `A1:${columnLetter(RUNLOG_COLUMNS.length)}`))}?${values}`,
    append_run_row: `${sheet}/values/${encodeURIComponent(a1(TABS.runLog, 'A1'))}:append?${queryString({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' })}`,
    sheet_meta: `${sheet}?${queryString({ fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))' })}`,
    read_working_tabs: `${sheet}/values:batchGet?${working.map(([tab, cells]) => `ranges=${encodeURIComponent(a1(tab, cells))}`).join('&')}&${values}`,
    // The final Review check, just before the publish (§8): the same range as step 6.
    read_review: `${sheet}/values/${encodeURIComponent(a1(TABS.review, working[1][1]))}?${values}`,
    batch_update: `${sheet}:batchUpdate`,
  };
}

function googleDownloadUrl(fileId) {
  if (!FILE_ID_PATTERN.test(cellString(fileId))) throw new SheetOpsError('PLAN_INVALID', `Invalid Drive file id "${cellString(fileId)}"`);
  return `${DRIVE_API}/${fileId}?${queryString({ alt: 'media', supportsAllDrives: 'true' })}`;
}

// This run's own Run Log row, 'Run Log'!A<n>:Z<n> (§12): the read that checks
// it and the values.update that writes FAILED. Both need only the tab name and
// row number, so they work even when reading the spreadsheet metadata failed.
function buildRunRowRequests(input) {
  const s = checkSettings(input.settings);
  const n = input.runRowNumber;
  if (!Number.isInteger(n) || n < 2) throw new SheetOpsError('PLAN_INVALID', `Run row number ${n} is not a data row`);
  const range = a1(TABS.runLog, `A${n}:${columnLetter(RUNLOG_COLUMNS.length)}${n}`);
  const url = `${SHEETS_API}/${s.spreadsheet_id}/values/${encodeURIComponent(range)}`;
  return {
    number: n,
    range,
    read_url: `${url}?${READ_OPTIONS}`,
    update_url: `${url}?${queryString({ valueInputOption: 'RAW' })}`,
  };
}

function buildRunRowUpdateRequest(input) {
  const target = buildRunRowRequests(input);
  return {
    method: 'PUT',
    url: target.update_url,
    body: { range: target.range, majorDimension: 'ROWS', values: [rowToValues(RUNLOG_COLUMNS, input.row)] },
  };
}

function errorText(error) {
  if (error === undefined || error === null) return 'no response';
  if (typeof error === 'string') return truncate(error, 300);
  if (typeof error.message === 'string' && error.message !== '') return truncate(error.message, 300);
  if (typeof error.code === 'string') return error.code;
  return truncate(JSON.stringify(error), 300);
}

// HTTP nodes that may fail use "continue on fail": a failed call arrives as
// { error }. This turns that into a run-level failure with a readable message.
function requireRead(json, code, what) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new SheetOpsError(code, `${what}: no response`);
  if (json.error !== undefined) throw new SheetOpsError(code, `${what} failed: ${errorText(json.error)}`);
  return json;
}

function parseDriveListing(response) {
  const body = requireRead(response, 'INVALID_LISTING', 'Listing the inbox');
  if (!Array.isArray(body.files)) throw new SheetOpsError('INVALID_LISTING', 'Drive listing has no files array');
  return { files: body.files, complete: !body.nextPageToken };
}

function parseValueRange(response, what) {
  const body = requireRead(response, 'READ_FAILED', `Reading ${what}`);
  if (body.values === undefined) return [];
  if (!Array.isArray(body.values) || body.values.some((row) => !Array.isArray(row))) {
    throw new SheetOpsError('READ_FAILED', `${what} values are malformed`);
  }
  return body.values;
}

function parseWorkingTabs(response) {
  const body = requireRead(response, 'READ_FAILED', 'Reading the Catalog, Review, Changes, Exceptions and Run Log tabs');
  if (!Array.isArray(body.valueRanges) || body.valueRanges.length !== 7) {
    throw new SheetOpsError('READ_FAILED', 'The tab read did not return the seven requested ranges');
  }
  const v = body.valueRanges.map((range, i) => parseValueRange(range, `range ${i + 1}`));
  return {
    catalog: v[0],
    review: v[1],
    changes: { header: v[2][0] || [], ids: v[3].map((row) => row[0]), rows: v[3].length },
    exceptions: { header: v[4][0] || [], ids: v[5].map((row) => row[0]), rows: v[5].length },
    runLog: v[6],
  };
}

function parseSheetMeta(response) {
  const body = requireRead(response, 'READ_FAILED', 'Reading spreadsheet metadata');
  if (!Array.isArray(body.sheets)) throw new SheetOpsError('READ_FAILED', 'Spreadsheet metadata has no sheets array');
  const meta = {};
  for (const sheet of body.sheets) {
    const p = sheet && sheet.properties;
    if (!p || typeof p.title !== 'string') continue;
    const grid = p.gridProperties || {};
    // JSON responses may omit a sheetId of 0.
    meta[p.title] = { sheetId: p.sheetId === undefined ? 0 : p.sheetId, rowCount: grid.rowCount, columnCount: grid.columnCount };
  }
  for (const tab of Object.values(TABS)) {
    if (!meta[tab]) throw new SheetOpsError('OUTPUT_SCHEMA_MISMATCH', `The spreadsheet has no "${tab}" tab`);
  }
  return meta;
}

function parseAppendedRowNumber(response) {
  const body = requireRead(response, 'RUNLOG_INVALID', 'Appending the Run Log row');
  const range = cellString(body.updates && body.updates.updatedRange);
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range);
  if (!match || match[1] !== match[2] || Number(match[1]) < 2) {
    throw new SheetOpsError('RUNLOG_INVALID', `Unexpected appended range "${range}"`);
  }
  return Number(match[1]);
}

// Reads the publish node's output ("full response" + "never error"): an HTTP
// status means Google answered; no status means the call failed in transit.
function interpretPublishResponse(json) {
  const item = json || {};
  if (Number.isInteger(item.statusCode)) {
    const status = item.statusCode;
    if (status >= 200 && status < 300) return { outcome: 'APPLIED', httpStatus: status, message: '' };
    const body = item.body;
    const detail = body && typeof body === 'object' && body.error ? body.error : (typeof body === 'string' && body !== '' ? body : item.statusMessage);
    return { outcome: classifyPublishFailure({ httpStatus: status }), httpStatus: status, message: errorText(detail) };
  }
  return { outcome: 'UNKNOWN', httpStatus: undefined, message: errorText(item.error) };
}

// ---------------------------------------------------------------------------
// Exports (for Node; harmless inside an n8n Code node)
// ---------------------------------------------------------------------------

const SheetOps = {
  DEFAULT_CONFIG,
  TABS,
  CATALOG_COLUMNS,
  REVIEW_COLUMNS,
  CHANGES_COLUMNS,
  EXCEPTIONS_COLUMNS,
  RUNLOG_COLUMNS,
  SheetOpsError,
  CsvParseError,
  parseCsv,
  parsePrice,
  changePct,
  validateFields,
  describeSourceFile,
  selectNextBatch,
  processBatch,
  planFileRejection,
  buildStartedRow,
  buildBlockedRow,
  buildFailedRunRow,
  rowToValues,
  buildPublishRequest,
  publicationVersion,
  VERSION_TAB,
  VERSION_BASE,
  VERSION_MAX,
  buildRunRowRequests,
  buildRunRowUpdateRequest,
  classifyPublishFailure,
  publishFailure,
  verifyRunLogRows,
  checkReviewUnchanged,
  resolveRunFailure,
  checkSettings,
  buildGoogleRequests,
  googleDownloadUrl,
  requireRead,
  parseDriveListing,
  parseValueRange,
  parseWorkingTabs,
  parseSheetMeta,
  parseAppendedRowNumber,
  interpretPublishResponse,
  utf8ByteLength,
  sheetDate,
};

if (typeof module !== 'undefined' && module.exports) module.exports = SheetOps;
