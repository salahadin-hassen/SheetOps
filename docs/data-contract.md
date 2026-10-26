# SheetOps data contract

Version 2.1 (approved design v2 plus the four corrections from the M1 review).
Scope of version one: one supplier, one currency (ETB), one Google Drive inbox
folder, one spreadsheet.

Every rule here is implemented in `src/sheetops-core.js` and covered by the
offline tests in `test/`. When the code and this document disagree, the
document is the specification and the code is the bug.

---

## 1. Source files

| Property | Rule |
|---|---|
| Location | One Drive folder (the inbox), shared with the service account as **Viewer**. SheetOps never modifies or moves source files. |
| File name | `<supplier>_<YYYY-MM-DD>.csv`, matched by `^([a-z0-9]+(?:-[a-z0-9]+)*)_(\d{4})-(\d{2})-(\d{2})\.csv$` |
| Supplier part | Must equal the configured supplier slug (`demo-supplier` in the fixtures). |
| Date part | The price list's **effective date** (not the upload date). Must be a real calendar date. |
| Encoding | UTF-8. A leading byte-order mark is removed. |
| Format | Comma-separated, RFC 4180 quoting (section 3). |
| Limits | At most 2,000,000 bytes and 2,000 data records. |

## 2. Batch identity and queue order

**Batch version.** `batch_id = <drive_file_id>@<modifiedTime>`, with
`modifiedTime` normalized to `YYYY-MM-DDTHH:MM:SS.sssZ`. Editing a file in
Drive changes its `modifiedTime`, so every edit becomes a new, distinguishable
batch version. The previous version's history stays in Run Log.

**Order key.** `(effective_date, modified_at, created_at, file_id)`, compared
field by field as plain strings. All four fields have fixed-width formats, so
string order equals time order. Comparison never uses locale-aware sorting.

**Latest committed batch.** The Run Log row with status `SUCCESS` or
`SUCCESS_WITH_EXCEPTIONS` whose order key is greatest. Run Log stores the four
key fields, so this works even after the file has left the inbox.

**Scheduled selection.** One batch per run. First matching rule wins:

1. More than 50 files listed → `BLOCKED` (`INBOX_TOO_LARGE`).
2. Any `STARTED` run row younger than 15 minutes → `WAIT` (nothing written).
3. Malformed names: every version whose name fails section 1 and that has no
   `REJECTED_FILE` row yet is reported, oldest first by
   `(modified_at, created_at, file_id)`. Code `BAD_FILENAME`, or
   `WRONG_SUPPLIER` when only the supplier part is wrong. The file is not
   downloaded. Each malformed version is reported exactly once and never blocks
   the queue.
4. Well-named versions in order-key order, skipping committed and rejected ones:
   - order key **less than** the latest committed key → `REJECTED_FILE`
     (`OUT_OF_ORDER_FILE`). An older effective date, or an older version of
     the same date, can never roll back a newer catalog.
   - the version has a `HALTED_REVIEW` row → `BLOCKED` (`BATCH_HALTED`).
   - the version has 3 or more failed attempts → `BLOCKED` (`RETRY_LIMIT`).
   - otherwise → process it.
5. Nothing left → `IDLE` (nothing written).

Failed attempts = rows with status `FAILED` or `INTERRUPTED`, plus `STARTED`
rows older than 15 minutes. A stale `STARTED` row is marked `INTERRUPTED` by
the next publishing run.

**Blocking is deliberate.** SheetOps never processes a newer file while an
older, parseable version still needs a decision. The operator unblocks the
queue with a manual override or retry run, or by removing the file from the
inbox.

**Manual runs.**

| Parameter | Effect |
|---|---|
| `target_batch_id` | Process that exact version, ignoring `BATCH_HALTED` and `RETRY_LIMIT`. |
| `reprocess_latest` | Process the latest committed batch again (used to apply approvals immediately). |
| `confirm_mass_discontinue` | With a target: accept the disappearance check for that run only. |

A manual run is refused (nothing written; the reason appears in n8n) when the
target is not in the inbox, has a malformed name, was rejected, or has an
order key less than the latest committed key.

## 3. CSV parsing

The parser is a small RFC 4180 state machine. It never splits lines on commas.

- Fields are separated by `,`. Records end at `\r\n`, `\n` or `\r`.
- A field that starts with `"` is quoted. Inside it, `""` is one literal `"`,
  and commas and line breaks are ordinary characters.
- After a closing quote, only `,` or a record end may follow. Anything else is
  `CSV_PARSE_ERROR`.
- A `"` inside an unquoted field is `CSV_PARSE_ERROR`.
- An unterminated quoted field is `CSV_PARSE_ERROR`.
- A final line break does not create an extra record.
- `CSV_PARSE_ERROR` rejects the whole file and names the physical line.

**Record numbering.** `source_row` is the **logical record number**, with the
header as record 1. A quoted field containing a line break makes one record
span several physical lines, so `source_row` can be smaller than the line
number. `source_row` matches the row number staff see when the file is opened
in a spreadsheet program.

A data record whose field count differs from the header is rejected
(`FIELD_COUNT_MISMATCH`). It is never re-aligned or shifted. A record whose
fields are all empty or whitespace is `BLANK`, whatever its field count.

## 4. Columns

Header cells are matched after trimming, lowercasing and collapsing inner
whitespace.

| Field | Required | Accepted headers |
|---|---|---|
| `sku` | yes | sku, item code, item_code, product code, code |
| `name` | yes | name, description, item name, product |
| `unit` | yes | unit, uom, unit of measure |
| `unit_price` | yes | unit_price, unit price, price |
| `currency` | optional column | currency, cur |

- A required field with no matching header → `MISSING_COLUMN` (file rejected,
  one exception per missing field).
- Two headers mapping to the same field → `AMBIGUOUS_COLUMN` (file rejected).
- Unrecognized headers are ignored and listed in the run output.

## 5. Field rules

Fields are checked in this order, and every problem found becomes one
exception row: sku, name, unit, unit_price, currency.

| Field | Clean-up (automatic, safe) | Rejection codes |
|---|---|---|
| sku | Trim, uppercase | `MISSING_SKU`; `INVALID_SKU` unless `^[A-Z0-9][A-Z0-9._-]{1,31}$` |
| name | Trim, collapse every whitespace run (including line breaks) to one space | `MISSING_NAME`; `NAME_TOO_LONG` above 200 characters |
| unit | Trim, lowercase, aliases: pcs/pc/piece/ea → each; kgs → kg; ltr/litre/liter → l | `MISSING_UNIT`; `UNKNOWN_UNIT` unless one of each, kg, g, l, ml, pack, box |
| unit_price | Remove thousands separators | see below |
| currency | Trim, uppercase. Column absent → ETB for every row | `CURRENCY_MISMATCH` unless exactly ETB (a blank cell is a mismatch) |

**Prices** are stored as integer cents. Floating-point numbers are never used
for money arithmetic.

| Input | Result |
|---|---|
| `1520`, `1520.5`, `1520.00`, `1,520.00`, `12,500` | accepted (`12,500` = 12500.00) |
| `12,5`, `12,50`, `1,52`, `1.520,00` | `AMBIGUOUS_PRICE` (could be a decimal comma) |
| empty | `MISSING_PRICE` |
| more than 2 decimals, symbols, letters, signs, 0 or less, above 10,000,000.00 | `INVALID_PRICE` |

## 6. Row outcomes

Every data record gets exactly one primary outcome. Row accounting must hold
on every run:

`rows_read = accepted + collapsed + rejected + held_conflict + held_review + blank`

| Outcome | Meaning | Catalog effect | Reported in |
|---|---|---|---|
| `ACCEPTED` | Valid and unambiguous, and either equal to the catalog, an automatic change, or an approved change | Updated if changed | Changes |
| `HELD_REVIEW` | Valid and unambiguous, but a review rule triggers and there is no matching approval | Previous values kept | Review, Changes (`HELD_FOR_REVIEW`) |
| `HELD_CONFLICT` | Valid, but its SKU is ambiguous in this file | Previous values kept | Exceptions (`REVIEW`) |
| `REJECTED` | Fails a field rule or the field count | Previous values kept if the SKU is in the catalog | Exceptions (`ERROR`) |
| `COLLAPSED` | Identical (after clean-up) to an earlier row | None | Exceptions (`INFO`) |
| `BLANK` | Every field empty | None | Run Log count |

**Grouping by SKU.** Rows whose SKU passes the SKU rule are grouped by
normalized SKU, including rejected rows.

1. Identical valid rows (same name, unit, cents, currency) collapse first. The
   lowest row number represents them.
2. If the group contains any rejected row, each valid representative becomes
   `HELD_CONFLICT` with code `SIBLING_ROW_INVALID`.
3. Otherwise, if more than one distinct representative remains, each becomes
   `HELD_CONFLICT` with code `CONFLICTING_DUPLICATE`.
4. Otherwise the single representative is compared with the catalog (section 7).

A SKU with any row in the file (any outcome, including rejected) is
**present**. Only absent SKUs can be discontinued.

## 7. Changes and reviews

Comparison uses the catalog's current values, including the last known values
of a `DISCONTINUED` item.

**Review triggers.**

| Trigger | Condition |
|---|---|
| `UNIT_CHANGED` | Unit differs. Prices are not compared. |
| `LARGE_PRICE_CHANGE` | Same unit and `abs(new - old) * 100 >= 25 * old`, in integer cents (25.00% is held, 24.99% is applied). |
| `NAME_CHANGED` | Cleaned name differs (possible SKU reuse). |

If any trigger fires, **none of the row's fields are applied**.

**Automatic changes** (disposition `APPLIED`): `NEW_ITEM`, `PRICE_CHANGED`
below the threshold, `REACTIVATED` without triggers, and `DISCONTINUED` for
active SKUs absent from the file (subject to the safety stop, section 11).

**Percentages** are rounded half away from zero to one decimal, using integers:
`tenths = floor((2 * abs(new - old) * 1000 + old) / (2 * old))`.

**Review lifecycle.** At most one open review item per SKU.

| Situation for an open item (sku S, proposal P) | Result |
|---|---|
| S has one valid row equal to P, decision `APPROVE` | Applied: Changes rows `APPLIED_AFTER_REVIEW` (with the operator's note), item removed, row `ACCEPTED` |
| S has one valid row equal to P, no or invalid decision | Item kept, `last_seen` updated, row `HELD_REVIEW`, no new Changes rows |
| S has one valid row different from P, or equal to the catalog | Item closed: one `REVIEW_SUPERSEDED` Changes row; the row is then evaluated normally |
| S's rows are only rejected or conflicting | Item left exactly as it is, including decision and note |
| S absent from the file | Item closed (`REVIEW_SUPERSEDED`); S is discontinued normally |

- **Decision values.** Trimmed and compared case-insensitively. `APPROVE`
  approves. Blank is pending. Anything else is kept exactly as typed and shown
  with status `INVALID_DECISION`; it never applies a change.
- **No REJECT in version one.** If the operator disagrees with the supplier,
  the fix is a corrected list, which supersedes the item.
- **Tampering guard.** If an item opened by the batch being processed shows a
  proposal different from that batch's own row, the Review tab was edited by
  hand → `REVIEW_INVALID` (run fails before publishing).

## 8. Review tab safety

The Review tab is rewritten as a whole on every publishing run, but **workflow
writes always preserve the operator's `decision` and `note` exactly as read**.
Items are matched by `review_id`, never by row position, so sorting the tab is
safe.

- **Restriction.** Do not edit the Review tab while a run is active (Run Log
  shows a `STARTED` row). An edit made after the run read the tab would be
  overwritten.
- **Guard.** Just before publishing, the workflow reads the Review tab again.
  If any `decision` or `note` changed, or rows were added or removed, the run
  aborts with `REVIEW_EDITED_DURING_RUN` and publishes nothing. The next run
  picks up the edit. This narrows the race to the moment between the second
  read and the publish request; it does not remove it.
- Runs that end `REJECTED_FILE` or `HALTED_REVIEW` do not write the Review tab
  at all.

## 9. Identifiers

The core never generates random identifiers. `|` cannot occur in SKUs, Drive
file IDs or timestamps, so it is a safe separator.

| Identifier | Format |
|---|---|
| batch_id | `<file_id>@<modifiedTime>` |
| review_id | `RV|<sku>|<batch_id of first sighting>` |
| event_id, automatic | `EV|<batch_id>|<sku>|<change_type>` |
| event_id, review | `<review_id>|<change_type>|HELD` or `|APPLIED`; `<review_id>|REVIEW_SUPERSEDED` |
| exception_id | `EX|<batch_id>|<source_row>|<code>`, plus `|<field>` when the exception names a field. File-level problems use row 0. |
| run_id | The n8n execution ID (passed in). |

The core receives the IDs already present in Changes and Exceptions and emits
only new ones. A rerun therefore never duplicates a row.

## 10. Output tabs

Header rows must match these columns exactly, in this order. Extra columns are
refused (`OUTPUT_SCHEMA_MISMATCH`) because SheetOps re-sorts managed rows and
would misalign them. Values are written as text (`stringValue`) or numbers
(`numberValue`); text is never interpreted as a formula.

**Catalog** (replaced in full, sorted by sku):
`sku, name, unit, unit_price, currency, status, previous_price, first_seen,
last_seen, last_changed, pending_review, last_issue`

- `first_seen` / `last_seen` / `last_changed`: effective dates.
- `last_seen`: the latest batch in which the SKU was present.
- `previous_price`: the price before the last applied price change.
- `last_issue`: this batch's `ERROR`/`REVIEW` exceptions for the SKU, e.g.
  `AMBIGUOUS_PRICE (row 5); SIBLING_ROW_INVALID (row 20)`.

**Review** (replaced in full, sorted by sku):
`review_id, sku, status, reasons, current_name, current_unit, current_price,
proposed_name, proposed_unit, proposed_price, change_pct, first_seen,
last_seen, source_row, decision, note`

- Operator-editable: `decision`, `note`. Everything else is managed.
- `status`: `PENDING`, `APPROVED` or `INVALID_DECISION`, derived from `decision`.

**Changes** (append-only):
`event_id, batch_id, effective_date, sku, change_type, disposition,
old_value, new_value, change_pct, review_id, note`

- `change_type`: NEW_ITEM, REACTIVATED, PRICE_CHANGED, UNIT_CHANGED,
  NAME_CHANGED, DISCONTINUED, REVIEW_SUPERSEDED.
- `disposition`: APPLIED, HELD_FOR_REVIEW, APPLIED_AFTER_REVIEW, NOT_APPLIED.
- Rows are sorted by sku, then change type in the order above.

**Exceptions** (append-only):
`exception_id, batch_id, source_file, source_row, sku_raw, severity, code,
field, raw_value, message, action`

- `severity`: ERROR (rejected), REVIEW (held or halted), INFO (collapsed).
- `action`: KEPT_PREVIOUS, NOT_ADDED, IGNORED, FILE_NOT_PROCESSED.
- `sku_raw` and `raw_value` are the cells exactly as they appeared in the file.

**Run Log** (one row per run):
`run_id, mode, status, started_at, finished_at, batch_id, source_file_id,
source_name, effective_date, source_modified_at, source_created_at, rows_read,
accepted, collapsed, rejected, held_conflict, held_review, blank,
changes_applied, reviews_opened, reviews_pending, exceptions, exceptions_new,
queue_remaining, error_code, error_message`

## 11. Run statuses

| Status | Written how | Counts as committed |
|---|---|---|
| `STARTED` | Appended before any processing | no |
| `SUCCESS` | Inside the publish request: no `ERROR`/`REVIEW` exceptions, no pending reviews | **yes** |
| `SUCCESS_WITH_EXCEPTIONS` | Inside the publish request: published, items need attention | **yes** |
| `REJECTED_FILE` | Inside the publish request: the file was not processed | no (closed) |
| `HALTED_REVIEW` | Inside the publish request: more than 30% of active SKUs absent | no (blocks the queue) |
| `FAILED` | Separate write after a definitive failure | no |
| `INTERRUPTED` | Set by a later publishing run on a stale `STARTED` row | no |
| `BLOCKED` | Single appended row; nothing processed | no (no batch) |

`IDLE`, `WAIT` and refused manual runs write nothing to the spreadsheet.

**Disappearance safety stop.** Denominator: SKUs `ACTIVE` in the catalog
before the run. Numerator: those not present in the file (section 6). Halt
when `numerator * 100 > 30 * denominator`; never when the denominator is 0.
A halted run publishes exactly one Exceptions row (`MASS_DISCONTINUE`,
severity REVIEW, raw value `numerator/denominator`, the missing SKUs in the
message) and the Run Log row. Catalog, Review and Changes are not written.

## 12. Publication

Each processing run publishes through **one** `spreadsheets.batchUpdate`
request. Google documents that every request in it is validated first, that
nothing is applied if any request is invalid, and that the updates are applied
together atomically, in order. This is documented behavior; the M2 live tests
verify it on the SheetOps sheet.

Request order:

1. Grow the Catalog and Review grids if needed (`appendDimension`).
2. Replace the Catalog data rows (`updateCells`; cells not covered are cleared).
3. Replace the Review data rows.
4. Append new Changes rows (`appendCells`).
5. Append new Exceptions rows.
6. Mark stale `STARTED` rows `INTERRUPTED`.
7. Overwrite this run's `STARTED` row with its final row — the **commit marker**.

The core checks the complete plan before building the request: unique IDs, no
already-existing IDs, row accounting, row limits, and a request size of at most
2,000,000 bytes (`PUBLISH_TOO_LARGE`). Failures abort before anything is sent.

**After a publish error** (never retried automatically):

| Error | Classification | Action |
|---|---|---|
| HTTP 4xx except 408 | Definitive rejection: nothing was applied | Update the run row to `FAILED` |
| HTTP 5xx, 408, timeout, connection lost | Unknown outcome | Reconcile (below) |

**Reconciling an unknown outcome.** Wait about 20 seconds, then read this
run's row:

| Run row shows | Meaning | Action |
|---|---|---|
| `SUCCESS` / `SUCCESS_WITH_EXCEPTIONS` for this batch | Published | Report success. **Never** write `FAILED`. |
| `STARTED` | Not applied (the marker is part of the atomic request) | Update the row to `FAILED` (`PUBLISH_NOT_APPLIED`) |
| Row missing or unreadable | Inconclusive | Write nothing. The row stays `STARTED`; after 15 minutes the next run treats it as interrupted and retries. |

Residual risk: if a delayed request lands between the reconcile read and the
`FAILED` write, the run row can show `FAILED` although the data was published.
The next run then reprocesses the batch; because IDs are filtered, it adds no
duplicates and commits the batch again.

## 13. Failure policy

| Situation | Spreadsheet writes | Catalog | Status |
|---|---|---|---|
| Nothing to process | none (n8n execution record only) | unchanged | IDLE |
| Malformed name, wrong supplier, out of order | one request: Exceptions row + run row | unchanged | REJECTED_FILE |
| Unreadable CSV, empty, too large, too many rows, missing or ambiguous column | one request: Exceptions row(s) + run row | unchanged | REJECTED_FILE |
| More than 30% of active SKUs absent | one request: Exceptions row + run row | unchanged | HALTED_REVIEW |
| Catalog, Review or Run Log tab invalid | run row `FAILED`, if writable | unchanged | FAILED |
| Review edited during the run | run row `FAILED` | unchanged | FAILED |
| Publish rejected | nothing from the request; run row `FAILED` | unchanged | FAILED |
| Publish outcome unknown | all or nothing; reconciled as in section 12 | all or nothing | SUCCESS* or FAILED or STARTED |
| Spreadsheet unwritable (403, deleted, quota) | probably nothing, **including Run Log** | unchanged | **n8n execution record only** |

SheetOps cannot always record its own failure in the spreadsheet. The n8n
execution record is the fallback diagnostic source, so n8n must keep saving
failed executions.

## 14. Code reference

- File level: `BAD_FILENAME`, `WRONG_SUPPLIER`, `OUT_OF_ORDER_FILE`,
  `CSV_PARSE_ERROR`, `FILE_EMPTY`, `FILE_TOO_LARGE`, `TOO_MANY_ROWS`,
  `MISSING_COLUMN`, `AMBIGUOUS_COLUMN`, `MASS_DISCONTINUE`.
- Row level: `FIELD_COUNT_MISMATCH`, `MISSING_SKU`, `INVALID_SKU`,
  `MISSING_NAME`, `NAME_TOO_LONG`, `MISSING_UNIT`, `UNKNOWN_UNIT`,
  `MISSING_PRICE`, `INVALID_PRICE`, `AMBIGUOUS_PRICE`, `CURRENCY_MISMATCH`,
  `DUPLICATE_COLLAPSED`, `CONFLICTING_DUPLICATE`, `SIBLING_ROW_INVALID`.
- Review reasons: `UNIT_CHANGED`, `LARGE_PRICE_CHANGE`, `NAME_CHANGED`.
- Run level: `INBOX_TOO_LARGE`, `BATCH_HALTED`, `RETRY_LIMIT`,
  `INVALID_LISTING`, `CATALOG_INVALID`, `REVIEW_INVALID`, `RUNLOG_INVALID`,
  `OUTPUT_SCHEMA_MISMATCH`, `REVIEW_EDITED_DURING_RUN`, `PUBLISH_TOO_LARGE`,
  `PLAN_INVALID`, `PUBLISH_REJECTED`, `PUBLISH_NOT_APPLIED`.
