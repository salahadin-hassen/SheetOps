# SheetOps data contract

Version 2.6. Changes since the approved v2.1, all made while building the n8n
workflow (M2):

- v2.2: the Review guard is a read order instead of a second read before
  publishing; two pre-download checks (`NOT_A_CSV_FILE`, listed size); Sheets
  date serials are read as dates.
- v2.3 (review of v2.2):
  - **Failure contract** (section 12): the run row's exact range; a read
    before every overwrite; `FAILED` only after a definitive failure; after
    a lost response, this run never writes a failure status.
  - **`QUEUE_TOO_LARGE`** replaces `INBOX_TOO_LARGE` and `LISTING_INCOMPLETE`,
    with recovery steps (section 2).
  - **Review race** stated as a possible loss (section 8).
  - **Sheets read options** and the date convention stated (section 10).
- v2.4 (review of v2.3): **replay-safe publication** (section 12):
  - every publish carries a version check, so a publish planned from an
    older state can never apply;
  - history rows go to fixed ranges instead of being appended;
  - no other batch is published while a publication is unresolved
    (section 2, `PUBLICATION_UNRESOLVED`);
  - automatic recovery of an unresolved publication is **off by default**:
    the age of a `STARTED` row is never treated as evidence (section 2).
- v2.5 (owner decision, 29 October 2026): **final Review check**
  (section 8). This reverses the v2.2 choice, confirmed on 27 October 2026, of
  a read order without a second read. Just before every publish that rewrites
  Review, the workflow reads Review again (step 6a, section 12). If any
  operator decision or note differs from the read the plan was built from, or
  the read fails, nothing is published and the run ends `FAILED`
  (`REVIEW_CHANGED` or `REVIEW_READ_FAILED`). The check shortens the window in
  which an edit can be lost; it does not close it.
- v2.6 (owner decisions, November 2026):
  - **Changes order** (section 10): this document now states the order the code
    and its tests have always used, `REVIEW_SUPERSEDED` first.
  - **Bounded Exceptions text** (section 10): `Exceptions.raw_value`, `sku_raw`
    and `message` are truncated, with an explicit marker, above 40,000 UTF-16
    units. Business values are validated or rejected, never shortened.
  - **Strict UTF-8** (sections 1 and 12, `INVALID_ENCODING`): the file reaches the
    core as bytes, and invalid UTF-8 rejects it whole.
  - **Typed decisions only** (sections 7, 8 and 12,
    `REVIEW_DECISION_NOT_LITERAL`): a formula never counts as an approval, and
    its presence in a decision cell stops the publish.

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
| Encoding | UTF-8, strictly. A leading byte-order mark is removed. Any invalid byte sequence (including overlong forms, encoded surrogates, values above U+10FFFF and a truncated final sequence) rejects the **whole file** as `REJECTED_FILE` (`INVALID_ENCODING`, naming the first invalid byte's offset). No row is processed, no encoding is guessed and no replacement character is substituted. A correctly encoded U+FFFD in the file is valid text and is kept. |
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

1. The listing is not known to be complete → `BLOCKED` (`QUEUE_TOO_LARGE`).
   This happens when more than 50 files are listed, or when Drive returns the
   listing in more than one page. SheetOps never processes a partial listing
   or skips files silently, because a missing file could be older than the
   ones it can see. Recovery (the message names the case):
   - more than 50 files: move processed files (those with a committed or
     `REJECTED_FILE` row in Run Log) from the inbox to another folder until
     at most 50 remain, then run again;
   - more than one page with 50 files or fewer: Drive may split a listing
     early, so run again; if it persists, reduce the inbox as above.
2. Any `STARTED` run row younger than 15 minutes → `WAIT` (nothing written).
   A `STARTED` row 15 minutes or older is an **unresolved publication**. Its
   age shows only that no run is still active: n8n stops every run after 300
   seconds. It does not show whether the publish was never sent, was
   rejected, or applied with a lost response. An applied publish shows its
   commit marker instead of `STARTED`, but a delayed one could still land
   later. While an unresolved publication exists, no other batch is
   published:
   - **By default** (`auto_recover_uncertain` off), scheduled runs stop:
     `BLOCKED` (`PUBLICATION_UNRESOLVED`). Only a manual run with that row's
     `target_batch_id` may process it. A person runs it after inspecting the
     evidence (docs/setup.md, "An unresolved publication").
   - **With `auto_recover_uncertain` on**, scheduled runs process only that
     batch version, by these rules applied to it alone:
     - its pre-download check fails → `REJECTED_FILE` again;
     - it has a `HALTED_REVIEW` row → `BLOCKED` (`BATCH_HALTED`);
     - it has 3 or more failed attempts → `BLOCKED` (`RETRY_LIMIT`);
     - it is older than the latest committed batch → `REJECTED_FILE`
       (`OUT_OF_ORDER_FILE`);
     - otherwise → process it again (as a reprocess if it is committed).

   In both modes:
   - If that version is no longer in the inbox, or more than one batch is
     unresolved → `BLOCKED` (`PUBLICATION_UNRESOLVED`).
   - A manual run is refused (`PUBLICATION_UNRESOLVED`) unless it targets that
     batch.
   - The publish that processes it marks the old row `INTERRUPTED` and moves
     the version (section 12). After that, the old publish can no longer
     apply. That last point is documented Google behavior, which the live
     tests T-VERSION-1 and T-VERSION-2 must confirm.

   **Switching automatic recovery on** makes scheduled runs repeat an
   uncertain publication without a person. They then rely on the version check
   to reject the original if it lands later. Switch it on only after
   T-VERSION-1 and T-VERSION-2 pass live; keep it off if they fail.
3. Pre-download checks: every version that fails one of these, and has no
   `REJECTED_FILE` row yet, is reported, oldest first by
   `(modified_at, created_at, file_id)`. The file is not downloaded. Each
   version is reported exactly once and never blocks the queue.

   | Code | Condition |
   |---|---|
   | `NOT_A_CSV_FILE` | A Google-native file (Docs, Sheets, ...), which cannot be downloaded as an uploaded CSV |
   | `BAD_FILENAME` | The name fails section 1 (pattern or calendar date) |
   | `WRONG_SUPPLIER` | Only the supplier part is wrong |
   | `FILE_TOO_LARGE` | Drive lists the file above the byte limit |
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
older, parseable version still needs a decision, and never publishes any
other batch while a publication is unresolved. The operator unblocks the
queue with a manual override or retry run, or by removing the file from the
inbox.

**Manual runs.**

| Parameter | Effect |
|---|---|
| `target_batch_id` | Process that exact version, ignoring `BATCH_HALTED` and `RETRY_LIMIT`. |
| `reprocess_latest` | Process the latest committed batch again (used to apply approvals immediately). |
| `confirm_mass_discontinue` | With a target: accept the disappearance check for that run only. |

A manual run is refused (nothing written; the reason appears in n8n) when a
different batch's publication is unresolved, when the target is not in the
inbox, fails a pre-download check, was rejected, or has an
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
- **Typed decisions only.** A decision must be a value a person typed into that
  cell. A formula, or a value an array formula placed there, never counts,
  whatever it shows, and stops the publish (section 8).
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
  shows a `STARTED` row).
- **Read order.** The workflow reads Catalog, Review and the ID columns only
  after the download, immediately before planning (step 6). Edits saved
  before that read are kept.
- **Final check (v2.5).** After planning, and immediately before the publish,
  the workflow reads the Review tab again (step 6a, the same range as step 6)
  and compares it with the step 6 read the plan was built from:
  - Items are matched by `review_id` (trimmed). Row order does not matter;
    blank rows are ignored; missing trailing cells read as empty, as in
    step 6.
  - For every item, `decision` and `note` must be identical: the same value
    and the same type (the number `5` and the text `"5"` differ; so do `""`
    and `" "`).
  - The set of review IDs must be the same: an item added, removed or listed
    twice is a change. A header or managed-column problem in the final read
    is a change.
  - Managed columns are not compared: the publish rewrites them anyway.
  - **Every decision cell must hold a typed value.** The same step reads the
    decision column with `spreadsheets.get`, asking for each cell's
    `userEnteredValue` and `effectiveValue` (`sheets.data.rowData.values`).
    `userEnteredValue` is what the cell holds, so this does not rely on what the
    cell displays:
    - `formulaValue` is a formula, whatever it evaluates to, including nothing;
    - no `userEnteredValue` with a value displayed is a cell filled by an array
      formula elsewhere;
    - any other kind of value, or a typed value that differs from step 6a's read
      of that row, is ambiguous.

    Any of these ends the run `FAILED` (`REVIEW_DECISION_NOT_LITERAL`, naming
    the rows) with nothing published. The run must stop rather than ignore the
    cell: a publish rewrites Review from the values read, so it would store the
    formula's result as typed text, and the next run would read it as an
    approval. The cell is left as it is. A typed `=...` is text, so it is simply
    `INVALID_DECISION`. A failed or malformed read is `REVIEW_READ_FAILED`. Only
    `decision` is checked: a formula in `note` still has its displayed value
    stored as text.
  - If anything differs, nothing is published and the run ends `FAILED`
    (`REVIEW_CHANGED`, naming the items and fields). If the final read fails
    after its three tries, or returns no usable rows, the run ends `FAILED`
    (`REVIEW_READ_FAILED`). Both are definitive failures: nothing was sent, so
    `FAILED` is written after step 8 confirms this run's row (section 12).
    The operator's edit stays in the sheet, untouched.
  - Like any `FAILED` run, it counts as a failed attempt (section 2). A batch
    that is not yet committed is processed again by the next scheduled run,
    which plans from the new values; three failed attempts block it
    (`RETRY_LIMIT`). A manual reprocess of a committed batch is not repeated
    automatically: run it again.
  - Runs whose plan does not write Review (`REJECTED_FILE`, `HALTED_REVIEW`)
    skip the check: their publish cannot overwrite a decision.
- **Remaining loss.** An edit saved between the final read and Google
  applying the publish **may still be lost**: the publish rewrites the Review
  rows from the step 6 read. The item then shows the decision and note it had
  before the edit; nothing is applied on the strength of a lost edit, and the
  operator must type it again. The final check makes this window shorter (the
  planning time is no longer inside it); it does not close it, and it cannot:
  Google Sheets has no conditional write, and Google documents that a
  `batchUpdate` "may be altered with respect to collaborator changes".
  A formula saved in that window is overwritten by the value read earlier, so
  it cannot become an approval.
  Evidence: `simulate.test.js` injects an approval after the final read and
  checks that it is lost and not applied, and injects one before the final
  read and checks that the run aborts without publishing.
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

**Reading the tabs back.** Every Sheets read uses
`valueRenderOption=UNFORMATTED_VALUE` and `dateTimeRenderOption=SERIAL_NUMBER`.
Cells therefore arrive as stored, not as displayed: text as strings, numbers as
JSON numbers, and date cells as Sheets serial day numbers. SheetOps writes
dates as text, so serials appear only where a person typed or pasted a date
into a tab that was not formatted as plain text. Date columns in Catalog
(`first_seen`, `last_seen`, `last_changed`) and Review (`first_seen`,
`last_seen`) accept both forms:

| Cell value | Read as |
|---|---|
| Text `YYYY-MM-DD` that is a real calendar date | that date |
| A whole number from 1 to 2958465 | the date that many days after 1899-12-30 (Google Sheets' epoch): 1 = 1899-12-31, 61 = 1900-03-01, 46300 = 2026-10-05, 2958465 = 9999-12-31 |
| Anything else, including fractions (date-times such as 46300.5), 0, negatives and digit strings such as `"46300"` | refused: `CATALOG_INVALID` or `REVIEW_INVALID` |

Only the date columns of those two tabs accept serials. Run Log
timestamps and dates are always written as text with `RAW` and must stay
text.

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
- Rows are sorted by sku, then change type in this order: REVIEW_SUPERSEDED, NEW_ITEM, REACTIVATED, PRICE_CHANGED,
  UNIT_CHANGED, NAME_CHANGED, DISCONTINUED, then by `event_id`. The list above
  is not this order. `REVIEW_SUPERSEDED` comes first because it reads in the
  order things happen: the old proposal is closed before the row that replaces
  it, or the SKU's discontinuation, is recorded. The file's row order never
  affects the result.

**Exceptions** (append-only):
`exception_id, batch_id, source_file, source_row, sku_raw, severity, code,
field, raw_value, message, action`

- `severity`: ERROR (rejected), REVIEW (held or halted), INFO (collapsed).
- `action`: KEPT_PREVIOUS, NOT_ADDED, IGNORED, FILE_NOT_PROCESSED.
- `sku_raw` and `raw_value` are the cells exactly as they appeared in the file,
  with one documented exception.
- **Bounded Exceptions text.** Google documents a limit of 50,000 characters per
  cell, and one oversized cell would make it refuse the whole publish. A
  `raw_value`, `sku_raw` or `message` longer than 40,000 UTF-16 units is
  therefore stored as its first characters plus
  ` [TRUNCATED] original length <n> characters`, where `<n>` counts characters
  (code points). The whole result, marker included, is at most 40,000 units, and
  a surrogate pair is never split. A value of 40,000 units or fewer that happens
  to contain the marker text is stored verbatim.
  - **Messages.** A message that quotes a supplier value (`INVALID_SKU`,
    `UNKNOWN_UNIT`, `AMBIGUOUS_PRICE`, `INVALID_PRICE`, `CURRENCY_MISMATCH`)
    quotes at most 39,000 units of it, with the same marker inside the quotes, so
    the explanation after the value survives. Other messages hold only row
    numbers, counts, codes and the file name, and take the 40,000-unit bound.
  - **Traceability.** `source_file` and `source_row` lead to the complete value in
    the supplier's file, which SheetOps never modifies. `source_file` is not
    shortened.
  - **Display only.** Bounding happens when the row is written. SKU identity,
    grouping, review IDs, exception IDs, deduplication and every decision use the
    complete value, and IDs hold no free text from the file.
  - **Business values are never shortened.** A value that can reach Catalog,
    Review or Changes is validated first: an SKU must match its pattern, a name is
    at most 200 characters, a unit is from the fixed list and a price is parsed to
    cents. Anything else rejects the row.
  - **Other columns.** `Catalog.last_issue` holds only codes and row numbers. It
    is not shortened: at the row limit its worst case is about 44,000 characters,
    above this bound but under Google's limit. `source_file` and
    `Run Log.source_name` hold the Drive file name whole.
  - **Run Log.** `error_message` keeps its own limit of 500 units, ending `...`,
    because its Exceptions rows hold the detail. It never splits a surrogate pair.

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
| `FAILED` | Separate write by this run, only after a **definitive** failure (section 12) | no |
| `INTERRUPTED` | Set by a later publishing run on a `STARTED` row 15 minutes or older, including a run whose publish outcome stayed unknown. It records that a later publish superseded the attempt, not that the attempt failed | no |
| `BLOCKED` | Single appended row; nothing processed | no (no batch) |

`IDLE`, `WAIT` and refused manual runs write nothing to the spreadsheet.

**Disappearance safety stop.** Denominator: SKUs `ACTIVE` in the catalog
before the run. Numerator: those not present in the file (section 6). Halt
when `numerator * 100 > 30 * denominator`; never when the denominator is 0.
A halted run publishes exactly one Exceptions row (`MASS_DISCONTINUE`,
severity REVIEW, raw value `numerator/denominator`, the missing SKUs in the
message) and the Run Log row. Catalog, Review and Changes are not written.

## 12. Google requests and publication

**Calls in a processing run, in order.** All go through n8n HTTP Request nodes
with the Google Service Account credential; URLs come from
`buildGoogleRequests` and `buildRunRowRequests`.

| Step | Call | Retries | If it fails |
|---|---|---|---|
| 1 | Drive `files.list` of the inbox (up to 51 entries, one page) | 3 tries, 5 s apart | Run stops; nothing written |
| 2 | Sheets `values.get` of Run Log | 3 tries | Run stops; nothing written |
| 3 | Sheets `values.append` of the `STARTED` row (`RAW`, `INSERT_ROWS`) | **none** (an append is not idempotent) | Run stops; a row may exist and is later marked `INTERRUPTED` |
| 4 | Drive `files.get?alt=media` (processing runs only), kept as a binary file and passed to the core as base64, never decoded as text on the way | 3 tries | Definitive failure `DOWNLOAD_FAILED` |
| 5 | Sheets `spreadsheets.get`: tab IDs, grid sizes and the version (the sheet ID of `_sheetops_version`) | 3 tries | Definitive failure `READ_FAILED` |
| 6 | Sheets `values.batchGet`: Catalog, Review, the Changes and Exceptions header rows and ID columns, and Run Log | 3 tries | Definitive failure `READ_FAILED` |
| 6a | Sheets `values.get` of Review, then `spreadsheets.get` of the decision column's `userEnteredValue`: the final check (section 8); only when the plan writes Review | 3 tries each | Definitive failure `REVIEW_READ_FAILED`; a changed decision or note is `REVIEW_CHANGED`; a decision that is not typed is `REVIEW_DECISION_NOT_LITERAL` |
| 7 | Sheets `spreadsheets.batchUpdate`: the publish | **none** | See "After a publish error" |

After a failure, up to two more calls follow:

| Step | Call | Retries | If it fails |
|---|---|---|---|
| 8 | Sheets `values.get` of this run's row | 3 tries | Nothing is written; the row stays `STARTED` |
| 9 | Sheets `values.update` (`RAW`) of this run's row with `FAILED`, after definitive failures only | 3 tries (rewriting the same values is idempotent) | The n8n execution fails; the row stays `STARTED` |

`BLOCKED` runs make calls 1, 2 and one `values.append` of their final row.
Values written with `RAW` are stored as given, never parsed as formulas. Every
read uses the render options in section 10.

**This run's row.** Step 3 appends the `STARTED` row. Google's reply names the
range it wrote (`updates.updatedRange`), which must be exactly one row,
`'Run Log'!A<n>:Z<n>` with n ≥ 2; anything else stops the run
(`RUNLOG_INVALID`). From then on, every write to this run's row covers
exactly columns A–Z (the 26 Run Log columns) of row n:

| Write | Range | Checked against | If the check fails |
|---|---|---|---|
| Commit marker, inside the publish | `updateCells` on the Run Log sheet, `startRowIndex` n−1, `endRowIndex` n, columns 0–26 | Step 6, read seconds earlier | Nothing is published (`RUN_ROW_UNVERIFIED`) |
| `FAILED` | `values.update` of `'Run Log'!A<n>:Z<n>` | Step 8, read just before | Nothing is written |

Each check requires row n to show this run's `run_id`, this `batch_id` and
`STARTED`. Appends by other runs never move existing rows. Sorting, inserting
or deleting Run Log rows during a run can, so the checks ensure such an edit
can at worst prevent this run's own final write. SheetOps never overwrites
another run's row. Stale `STARTED` rows due to be marked `INTERRUPTED` are
checked against step 6 in the same way; a row that has moved is skipped this
time and handled by a later run.

**One authoritative final status per run.** A run's row changes at most once,
from `STARTED` to a final status. Only these writers can make that change:

| Final status | Written by | Only when |
|---|---|---|
| `SUCCESS`, `SUCCESS_WITH_EXCEPTIONS`, `REJECTED_FILE`, `HALTED_REVIEW` | this run's publish (the commit marker) | Google applies the publish |
| `FAILED` | this run, step 9 | the failure is definitive and step 8 shows the row still `STARTED` |
| `INTERRUPTED` | a later run's publish | the row is still `STARTED` at least 15 minutes after it started, checked in that run's step 6 |
| `BLOCKED` | the append itself | the run was blocked before processing |

No write ever replaces a final status: each one replaces a row just checked
to be `STARTED`.

**Publication.** Each processing run publishes through **one**
`spreadsheets.batchUpdate` request. The official reference (checked
2026-10-27) documents:

- "Each request is validated before being applied."
- "If any request is not valid then the entire request will fail and nothing
  will be applied."
- "Requests will be applied in the order they are specified."
- "it is guaranteed that the updates in the request will be applied together
  atomically."

It also warns that "your changes may be altered with respect to collaborator
changes". It does not say how two concurrent API requests interact, and it
has no conditional-write option. SheetOps relies on the documented behavior;
the M2 live tests check it on the SheetOps sheet.

**The version check.** Atomicity alone does not make recovery safe: a publish
that lands late is still applied, whole, on top of whatever was published in
the meantime. Every publish therefore carries a version check:

- The spreadsheet holds one hidden tab, `_sheetops_version`, with one cell.
  Its **sheet ID is the state version**. SheetOps creates it on the first
  publish.
- Step 5 reads the version (the sheet ID of that tab, or none). It is read
  **before** the tabs in step 6, so a plan is never older than the version it
  carries.
- The publish starts with `deleteSheet` of that ID (when there is one) and
  `addSheet` of the tab with a new ID. If the tab with the planned ID no
  longer exists, or the title is already taken, Google rejects the whole
  request and nothing in it is applied.
- The new ID is the larger of (old ID + 1) and (1,000,000,000 + seconds since
  2026-01-01 at this run's start). IDs therefore only grow, even if the tab is
  deleted by hand, and an old ID is never recreated.

So a publish that lands after another publish has applied is rejected. This
rests on the documented validation, plus one inference: that `deleteSheet` of
a missing sheet ID counts as an invalid request. That two publishes planned
from the same version cannot both apply when they arrive **concurrently** is
not documented at all. It also assumes Google applies them one after the
other and validates each against the state it lands on. Only the live test
T-VERSION-2 can show it.

Request order:

1. The version check (`deleteSheet`, `addSheet`).
2. Grow grids where needed (`appendDimension`).
3. Replace the Catalog data rows (`updateCells`; cells not covered are cleared).
4. Replace the Review data rows.
5. Write new Changes rows at a fixed range (`updateCells`).
6. Write new Exceptions rows at a fixed range.
7. Mark stale `STARTED` rows `INTERRUPTED`.
8. Overwrite this run's `STARTED` row with its final row: the **commit marker**.

**Fixed ranges, not appends.** New Changes and Exceptions rows go to the rows
directly below the last row the step-6 ID-column read returned, with an
explicit range; `appendCells` is not used. Every write in the request is
therefore a function of the plan and the rows read. Sending the same request
twice rewrites the same cells instead of adding rows. The plan records these
start rows (`next_rows`). Rows below the last ID in column A belong to
SheetOps and may be overwritten.

Before building the request, the core checks the complete plan:

- unique IDs, with none already present in the tabs;
- row accounting and row limits;
- a request size of at most 2,000,000 bytes (`PUBLISH_TOO_LARGE`).

If any check fails, nothing is sent.

**Definitive and unknown failures.**

| Failure | Classification | Action |
|---|---|---|
| Steps 4–6 fail, the plan is refused (for example `CATALOG_INVALID`), or the final Review check fails (step 6a) | Definitive: nothing was sent | Steps 8 and 9: `FAILED` with that code |
| Publish answered with HTTP 4xx, except 408 | Definitive: Google refused it, nothing was applied | Steps 8 and 9: `FAILED` (`PUBLISH_REJECTED`) |
| Publish answered with HTTP 5xx or 408, timed out, or lost the connection | **Unknown**: the request may have been applied, or may still be applied later | Reconcile (below). This run **never** writes a failure status. |

A publish error is never retried automatically.

**Reconciling an unknown outcome.** Wait 20 seconds, then read this run's row
(step 8). The commit marker is part of the atomic publish, so the row shows
the final status if and only if the publish has been applied.

| Row n shows | Meaning | This run writes | The n8n execution reports |
|---|---|---|---|
| this run, this batch, and the final status the plan built | Applied | nothing | that status |
| `STARTED` | Not applied **so far** | nothing | `PUBLISH_OUTCOME_UNKNOWN` |
| unreadable, empty, or another run | Not known | nothing | `PUBLISH_OUTCOME_UNKNOWN` |

**Why nothing is written after an unknown outcome.** Sheets has no conditional
write. Suppose this run wrote `FAILED` and a delayed publish landed just before
that write. `FAILED` would then overwrite a committed status, and the run row
would contradict the data.

Instead, the row stays `STARTED`. The n8n execution record keeps the
`PUBLISH_OUTCOME_UNKNOWN` code, the HTTP status or network error, and the row
read. The next run decides from the Run Log it reads at that time:

- If the row now shows the final status, the batch is committed and there is
  nothing to do.
- If the row still shows `STARTED`, the publication is unresolved
  (section 2). By default, scheduled runs block until a person, having
  inspected the evidence, reprocesses the batch explicitly. With automatic
  recovery on, a run 15 minutes or more later processes it again. Either way,
  the reprocess marks the old row `INTERRUPTED` inside its own publish.

**Recovery.** A recovery run processes the same batch version (section 2),
downloads the same file version, reads the same state, and plans from the same
version. Unless someone edited Review in between, its data writes (Catalog,
Review, Changes, Exceptions) are byte-identical to the original's. Only the
Run Log writes and the new version ID differ. Each publication has one fixed
Run Log destination, its own run's row. Both publications delete the same
version, so at most one of them applies:

| What happens | Result |
|---|---|
| The original landed before the recovery's step 5 | The row shows the final status; the batch is committed; no recovery runs |
| The original lands after the recovery's step 5 but before its publish | The original applies; the recovery is rejected (HTTP 400) and writes `FAILED` (`PUBLISH_REJECTED`) on its own row |
| The original lands after the recovery committed | The original is rejected; the old row stays `INTERRUPTED` |
| The original never lands | The recovery's publish is the only one |

**Guarantees.** The labels below separate three kinds of support:

- **Documented:** follows from the quoted reference text, plus at most the
  stated inference.
- **Undocumented:** depends on behavior the reference does not describe;
  only a live test can show it.
- **Unconditional:** holds whatever Google does.

None of this has been observed live yet. The same is true of the typed-decision
check and the strict-encoding path: the offline fake models Google's documented
response, and the live tests T-FORMULA and T-ENCODING (docs/setup.md §5) must
confirm the real ones. Both fail closed if the real response differs.

1. *At most one publish per version applies.*
   - Sequentially, a publish that lands after another one applied changes
     nothing: documented, with the `deleteSheet` inference (T-VERSION-1).
   - For concurrent publishes: undocumented (T-VERSION-2).
2. *No duplicate history rows, no stale overwrite* (as guarantee 1). Every applied
   publish was planned from the state it lands on, and the plan filters out
   IDs already present, so no ID is written twice. Catalog and Review are
   never replaced by an older snapshot.
3. *Replaying an identical request adds no rows* (unconditional). Even if
   Google applied both the original and an identical recovery,
   Changes and Exceptions would contain each row once. Run Log would then show
   two committed rows for the batch. The offline test with the check switched
   off shows exactly that.
4. *One authoritative status per run* (documented). The commit marker is in the
   same atomic request as the data, so a run's row shows a committed status
   exactly when its publish applied.
5. *Order* (unconditional). No other batch is published while a publication is
   unresolved.

**Not guaranteed.**

- Exactly-once *processing*: a batch can be downloaded, planned and sent more
  than once. Guarantees 1 and 2 make its data appear in the tabs once.
- Edits by people. A Review edit inside the read-to-publish window may be
  lost (section 8). Rows typed by hand into managed tabs are not versioned.
  Editing, renaming or deleting `_sheetops_version` by hand is detected at
  the next publish or makes it fail safely, but the tab should not be touched.
- Progress without a person: an unresolved publication can block the queue
  until someone acts (`PUBLICATION_UNRESOLVED`, `RETRY_LIMIT`).
- Guarantees 1, 2 and 4 until T-VERSION-1 and T-VERSION-2 pass live. Until
  then, automatic recovery stays off (the default), and an unresolved
  publication blocks (`PUBLICATION_UNRESOLVED`) until a person decides. If
  Google does not enforce the check, it must stay off. Even an explicit
  reprocess then carries the risk described in docs/setup.md. Guarantee 3
  still holds.

**Cost.** After an unknown outcome, the row reads `STARTED`, and no other
batch is published, until a person reprocesses it after inspecting the
evidence (by default), or until a run 15 minutes or more later recovers it
(with automatic recovery on).

## 13. Failure policy

| Situation | Spreadsheet writes | Catalog | Status |
|---|---|---|---|
| Nothing to process | none (n8n execution record only) | unchanged | IDLE |
| Settings still hold placeholders or invalid IDs | none (n8n execution record only) | unchanged | — |
| Listing or Run Log read fails | none (n8n execution record only) | unchanged | — |
| More than 50 files listed, or the listing has more than one page | one append: the run row | unchanged | BLOCKED (`QUEUE_TOO_LARGE`) |
| An unresolved publication whose file version left the inbox, or several unresolved | one append: the run row | unchanged | BLOCKED (`PUBLICATION_UNRESOLVED`) |
| A publish planned from a version that has moved on (lost race) | nothing from the request; run row `FAILED` | unchanged by this run | FAILED (`PUBLISH_REJECTED`) |
| Pre-download check fails, or out of order | one request: Exceptions row + run row | unchanged | REJECTED_FILE |
| Invalid UTF-8, unreadable CSV, empty, too large, too many rows, missing or ambiguous column | one request: Exceptions row(s) + run row | unchanged | REJECTED_FILE |
| More than 30% of active SKUs absent | one request: Exceptions row + run row | unchanged | HALTED_REVIEW |
| Download or tab read fails after `STARTED` | run row `FAILED`, once step 8 confirms the row | unchanged | FAILED |
| Catalog, Review or Run Log tab invalid | run row `FAILED`, once step 8 confirms the row | unchanged | FAILED |
| A Review decision or note changed after the tab read, or the final Review read failed (step 6a) | run row `FAILED`, once step 8 confirms the row; no publish is sent | unchanged | FAILED (`REVIEW_CHANGED`, `REVIEW_READ_FAILED`) |
| A decision cell holds a formula or a value nobody typed there (step 6a) | run row `FAILED`, once step 8 confirms the row; no publish is sent; the cell is left as it is | unchanged | FAILED (`REVIEW_DECISION_NOT_LITERAL`) |
| Publish rejected (4xx except 408) | nothing from the request; run row `FAILED`, once step 8 confirms the row | unchanged | FAILED |
| Publish outcome unknown | all of the request or none of it; **no failure status** | all or nothing | the final status if applied; otherwise `STARTED`, later `INTERRUPTED` (n8n: `PUBLISH_OUTCOME_UNKNOWN`) |
| This run's row moved or cannot be confirmed (Run Log edited during the run, or step 8 failed) | none after the failure | unchanged | `STARTED`, later `INTERRUPTED` (n8n: `RUN_ROW_UNVERIFIED`) |
| Spreadsheet unwritable (403, deleted, quota) | probably nothing, **including Run Log** | unchanged | **n8n execution record only** |

SheetOps cannot always record its own failure in the spreadsheet. The n8n
execution record is the fallback diagnostic source. The workflow therefore
saves every execution (`saveDataSuccessExecution` and
`saveDataErrorExecution` are `all`), and the final **Done** node reports
`run_status`, `code` and `message` for every path. n8n prunes saved executions
after 14 days by default (`EXECUTIONS_DATA_MAX_AGE`).

## 14. Code reference

- File level: `NOT_A_CSV_FILE`, `BAD_FILENAME`, `WRONG_SUPPLIER`,
  `OUT_OF_ORDER_FILE`, `INVALID_ENCODING`, `CSV_PARSE_ERROR`, `FILE_EMPTY`, `FILE_TOO_LARGE`,
  `TOO_MANY_ROWS`, `MISSING_COLUMN`, `AMBIGUOUS_COLUMN`, `MASS_DISCONTINUE`.
- Row level: `FIELD_COUNT_MISMATCH`, `MISSING_SKU`, `INVALID_SKU`,
  `MISSING_NAME`, `NAME_TOO_LONG`, `MISSING_UNIT`, `UNKNOWN_UNIT`,
  `MISSING_PRICE`, `INVALID_PRICE`, `AMBIGUOUS_PRICE`, `CURRENCY_MISMATCH`,
  `DUPLICATE_COLLAPSED`, `CONFLICTING_DUPLICATE`, `SIBLING_ROW_INVALID`.
- Review reasons: `UNIT_CHANGED`, `LARGE_PRICE_CHANGE`, `NAME_CHANGED`.
- Run level: `QUEUE_TOO_LARGE`, `PUBLICATION_UNRESOLVED`, `BATCH_HALTED`, `RETRY_LIMIT`,
  `SETTINGS_INVALID`, `INVALID_LISTING`, `READ_FAILED`, `DOWNLOAD_FAILED`,
  `CATALOG_INVALID`, `REVIEW_INVALID`, `RUNLOG_INVALID`,
  `OUTPUT_SCHEMA_MISMATCH`, `PUBLISH_TOO_LARGE`, `PLAN_INVALID`,
  `PUBLISH_REJECTED`, `REVIEW_CHANGED`, `REVIEW_READ_FAILED`,
  `REVIEW_DECISION_NOT_LITERAL`.
- Not written to the spreadsheet (shown in n8n only): `RUN_IN_PROGRESS`
  (WAIT), `PUBLISH_OUTCOME_UNKNOWN`, `RUN_ROW_UNVERIFIED`, and the manual-run
  refusals `NOTHING_COMMITTED`,
  `TARGET_NOT_IN_INBOX`, `TARGET_PRECHECK_FAILED`, `TARGET_REJECTED`,
  `TARGET_OUT_OF_ORDER`.
