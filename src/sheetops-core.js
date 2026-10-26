'use strict';

/*
 * SheetOps deterministic core.
 *
 * Pure functions only: no clock reads, no randomness, no network, no require().
 * Times, Drive metadata and sheet contents all arrive as inputs, so the same
 * inputs always produce the same plan. The file runs unchanged under
 * `node --test` and inside an n8n Code node; the export block at the bottom is
 * skipped where `module` does not exist.
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
      dates[column] = cellString(row[column]).trim();
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
    const firstSeen = cellString(row.first_seen).trim();
    const lastSeen = cellString(row.last_seen).trim();
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
  const version = {
    batch_id: `${id}@${modified}`,
    file_id: id,
    name,
    effective_date: '',
    modified_at: modified,
    created_at: created,
    name_error: '',
  };
  const match = FILE_NAME_PATTERN.exec(name);
  if (!match || !isRealDate(Number(match[2]), Number(match[3]), Number(match[4]))) version.name_error = 'BAD_FILENAME';
  else if (match[1] !== cfg.supplier) version.name_error = 'WRONG_SUPPLIER';
  else version.effective_date = `${match[2]}-${match[3]}-${match[4]}`;
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

  if (files.length > cfg.max_listed_files) {
    return result('BLOCKED', {
      code: 'INBOX_TOO_LARGE',
      message: `${files.length} files listed; the limit is ${cfg.max_listed_files}`,
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

  const malformed = versions.filter((v) => v.name_error !== '' && open(v)).sort((a, b) => compareKeys(
    [a.modified_at, a.created_at, a.file_id], [b.modified_at, b.created_at, b.file_id]));
  const valid = versions.filter((v) => v.name_error === '' && open(v)).sort((a, b) => compareKeys(orderKey(a), orderKey(b)));
  const queued = malformed.length + valid.length;
  const base = { stale_runs: staleRuns };

  if (params.target_batch_id || params.reprocess_latest) {
    const refuse = (code, message) => result('REFUSED', Object.assign({}, base, { code, message, queue_remaining: queued }));
    const targetId = params.reprocess_latest ? (committed ? committed.batch_id : '') : cellString(params.target_batch_id);
    if (targetId === '') return refuse('NOTHING_COMMITTED', 'No batch has been committed yet');
    const version = versions.find((v) => v.batch_id === targetId);
    if (!version) return refuse('TARGET_NOT_IN_INBOX', `${targetId} is not in the inbox`);
    if (version.name_error !== '') return refuse('TARGET_BAD_FILENAME', `${version.name} has a malformed name`);
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

  if (malformed.length > 0) {
    const version = malformed[0];
    const message = version.name_error === 'WRONG_SUPPLIER'
      ? `Supplier part of "${version.name}" is not ${cfg.supplier}`
      : `"${version.name}" does not match ${cfg.supplier}_YYYY-MM-DD.csv`;
    return result('REJECT_FILE', Object.assign({}, base, { code: version.name_error, message, batch: version, queue_remaining: queued - 1 }));
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
  const ctx = { cfg, batch, run: input.run || {}, staleRuns: input.stale_runs || [], existingExceptionIds };
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

// Builds the single spreadsheets.batchUpdate body. The final request rewrites
// this run's STARTED row: the commit marker.
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
  const append = (tab, columns, rows) => {
    if (rows.length === 0) return;
    const meta = requireTabMeta(sheetMeta, tab, columns);
    requests.push({ appendCells: { sheetId: meta.sheetId, rows: rows.map((row) => toRowData(columns, row)), fields: 'userEnteredValue' } });
  };

  if (plan.writes.catalog) replace(TABS.catalog, CATALOG_COLUMNS, plan.writes.catalog);
  if (plan.writes.review) replace(TABS.review, REVIEW_COLUMNS, plan.writes.review);
  append(TABS.changes, CHANGES_COLUMNS, plan.writes.changes);
  append(TABS.exceptions, EXCEPTIONS_COLUMNS, plan.writes.exceptions);

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

// A single run-row overwrite, used for FAILED after a definitive failure.
function buildRunRowUpdateRequest(input) {
  const cfg = withDefaults(input.config);
  const log = requireTabMeta(input.sheetMeta, TABS.runLog, RUNLOG_COLUMNS);
  checkRunRowNumber(input.runRowNumber, log);
  return finishBody([runRowRequest(log, input.runRowNumber, input.row)], cfg);
}

// 4xx (except 408) means Google refused the request, so nothing was applied.
function classifyPublishFailure(failure) {
  const status = failure && failure.httpStatus;
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) return 'REJECTED';
  return 'UNKNOWN';
}

function reconcileAfterUnknown(input) {
  let runs;
  try {
    runs = readRunLog(input.runLog);
  } catch (err) {
    return { outcome: 'INCONCLUSIVE', reason: err.message };
  }
  const row = runs.find((run) => run.run_id === cellString(input.runId));
  if (!row) return { outcome: 'INCONCLUSIVE', reason: 'run row not found' };
  if (COMMITTED_STATUSES.includes(row.status) && row.batch_id === cellString(input.batchId)) {
    return { outcome: 'CONFIRMED', status: row.status };
  }
  if (row.status === 'STARTED') return { outcome: 'NOT_APPLIED' };
  return { outcome: 'INCONCLUSIVE', reason: `run row shows ${row.status}` };
}

// Decides what to write after a publish error (§12). `write` is the run row to
// store, or null when nothing may be written.
function resolvePublishFailure(input) {
  const kind = classifyPublishFailure(input);
  if (kind === 'REJECTED') {
    return {
      outcome: 'REJECTED',
      write: buildFailedRunRow(input.run, input.batch, 'PUBLISH_REJECTED', `HTTP ${input.httpStatus}: ${cellString(input.errorMessage)}`),
    };
  }
  if (!input.runLog) return { outcome: 'INCONCLUSIVE', write: null, reason: 'Run Log could not be read' };
  const check = reconcileAfterUnknown({ runLog: input.runLog, runId: input.run && input.run.run_id, batchId: input.batch && input.batch.batch_id });
  if (check.outcome === 'NOT_APPLIED') {
    return {
      outcome: 'NOT_APPLIED',
      write: buildFailedRunRow(input.run, input.batch, 'PUBLISH_NOT_APPLIED', `Outcome unknown (${cellString(input.errorMessage)}); commit marker absent`),
    };
  }
  return Object.assign({ write: null }, check);
}

// §8: compares the Review tab read at the start of a run with a second read
// taken just before publishing.
function detectReviewEdits(initialValues, latestValues) {
  const index = (values) => {
    const map = new Map();
    for (const row of readTable(values, REVIEW_COLUMNS, TABS.review)) {
      map.set(cellString(row.review_id).trim(), { decision: cellString(row.decision), note: cellString(row.note) });
    }
    return map;
  };
  const before = index(initialValues);
  const after = index(latestValues);
  const items = [];
  for (const [id, value] of before) {
    const now = after.get(id);
    if (!now) items.push({ review_id: id, change: 'REMOVED' });
    else if (now.decision !== value.decision || now.note !== value.note) items.push({ review_id: id, change: 'EDITED' });
  }
  for (const id of after.keys()) if (!before.has(id)) items.push({ review_id: id, change: 'ADDED' });
  items.sort((a, b) => compareStrings(a.review_id, b.review_id));
  return { edited: items.length > 0, items };
}

// ---------------------------------------------------------------------------
// Exports (skipped inside an n8n Code node)
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
  buildRunRowUpdateRequest,
  classifyPublishFailure,
  reconcileAfterUnknown,
  resolvePublishFailure,
  detectReviewEdits,
  utf8ByteLength,
};

if (typeof module !== 'undefined' && module.exports) module.exports = SheetOps;
