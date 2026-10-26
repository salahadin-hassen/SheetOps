# SheetOps requirements

Version 2.1. Rules referenced as "contract §n" are in
[data-contract.md](data-contract.md).

## Brief

A small shop receives a weekly price list (CSV) from one wholesale supplier.
SheetOps takes each list from a Google Drive inbox, cleans and validates it,
holds back ambiguous or risky changes for a person to approve, and publishes a
trustworthy catalog, a change history, an exception list and a run log to one
Google Sheet. Reruns never duplicate rows, and a failed run is never reported
as a success.

## Status of evidence

| Kind | Meaning |
|---|---|
| **Offline** | Automated `node --test` tests in `test/`. No network, no Google account. M1. |
| **Live** | Tests against a dedicated synthetic spreadsheet, run by hand with authorization. M2. |
| **Drill** | Deliberate failure exercises with recorded results. M3. |

Only offline evidence exists at the end of M1.

## Functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| FR-001 | Queue: process well-named versions in order-key order, one per run; report malformed names once each; reject anything older than the latest committed batch; block on halted or retry-exhausted versions (contract §2). | Offline `queue.test.js`: backlog of three in order; modified file becomes a new version; correction of the committed file processed; older date and older version rejected as `OUT_OF_ORDER_FILE`; malformed names reported once, oldest first; `BLOCKED` for halted and retry-exhausted versions; `WAIT` on a fresh `STARTED` row; `INBOX_TOO_LARGE`. |
| FR-002 | Map headers through the alias table; reject the file on a missing or ambiguous column (contract §4). | Offline `fields.test.js` and `safety.test.js`: alias headers accepted; `MISSING_COLUMN` and `AMBIGUOUS_COLUMN` give `REJECTED_FILE` with no Catalog or Review write. |
| FR-003 | Parse RFC 4180 CSV: quoted fields, commas and line breaks inside quotes, escaped quotes, thousands separators in quoted prices; logical record numbering (contract §3). | Offline `csv.test.js` with `fixtures/parser/quoting.csv`; malformed-quote cases give `CSV_PARSE_ERROR` with the line; an unquoted comma gives `FIELD_COUNT_MISMATCH`, never a shifted row. |
| FR-004 | Apply only the documented safe clean-ups; reject invalid fields with code, field, raw value and source row (contract §5). | Offline `fields.test.js` table tests; week-2: the 5 rejected rows give exactly the 5 hand-written `ERROR` exceptions. |
| FR-005 | Group rows by SKU: collapse identical rows; hold conflicting groups and valid rows sharing a SKU with a rejected row (contract §6). | Offline week-2: SPC-020 rows 8–9 and SUG-001 row 20 are `HELD_CONFLICT`; catalog keeps 600.00 and 110.00. `review.test.js`: sibling-invalid and conflict cases. |
| FR-006 | Apply automatic changes: NEW_ITEM, PRICE_CHANGED below 25%, REACTIVATED, DISCONTINUED (contract §7). | Offline week-2: exactly 5 `APPLIED` Changes rows, hand-computed percentages 7.9 and 4.8. |
| FR-007 | Hold unit changes, name changes and price changes of 25% or more; keep all previous catalog values for the row (contract §7). | Offline week-2: TEA-001, EGG-030, BTR-002 `HELD_REVIEW`; 3 `PENDING` items; catalog unchanged for them. `review.test.js`: boundary 25.00% held and 24.99% applied; unit, name and large-price cases. |
| FR-008 | Resolve reviews with `APPROVE`; supersede changed or vanished proposals; never apply an invalid decision (contract §7). | Offline `review.test.js`: approval applies with the note copied; changed proposal supersedes; absent SKU supersedes; invalid decision kept verbatim and not applied. |
| FR-009 | Preserve the operator's decision and note on every normal write; detect edits made during a run (contract §8). | Offline `review.test.js`: notes survive a normal reprocess; an approval survives a run that cannot apply it; rejected and halted runs do not write Review; `detectReviewEdits` finds changed, added and removed rows; tampered same-batch proposal gives `REVIEW_INVALID`. |
| FR-010 | Protect the catalog: never delete rows; never discontinue a present SKU; halt when more than 30% of active SKUs are absent; override only for an explicit batch (contract §11). | Offline `safety.test.js`: 5/10 absent halts with one `MASS_DISCONTINUE` exception and no Catalog, Review or Changes write; 3/10 proceeds; override proceeds. |
| FR-011 | Account for every row: `rows_read = accepted + collapsed + rejected + held_conflict + held_review + blank` (contract §6). | Offline week-2: 19 = 6 + 1 + 5 + 3 + 3 + 1; the invariant is also checked inside the core on every run. |
| FR-012 | Keep one Run Log row per run; finalize it inside the publish request; classify publish errors; reconcile unknown outcomes before declaring failure (contract §11–12). | Offline `publish.test.js`: run row overwritten in place as the last request; 4xx (not 408) definitive, 5xx/408/timeout unknown; reconciliation never writes `FAILED` after a confirmed `SUCCESS`; inconclusive writes nothing. Live (M2): T-LOST. |
| FR-013 | Publish each run through one atomic `spreadsheets.batchUpdate` request; check the plan first (contract §12). | Offline `publish.test.js`: request order and contents; halted and rejected plans contain no Catalog or Review requests; text written as `stringValue`; `PUBLISH_TOO_LARGE`; `OUTPUT_SCHEMA_MISMATCH`. Live (M2): T-ATOM-1, T-ATOM-2, T-SEC-1. |
| FR-014 | Reruns and recovery (contract §9). See R1–R6 below. | Offline `rerun.test.js`. Live (M2): T-RECOVER, T-LOST. |

### Rerun properties (FR-014)

| ID | Property | Offline test |
|---|---|---|
| R1 | The same inputs give a byte-identical plan; run information changes only the Run Log row. | `rerun.test.js` R1 |
| R2 | A rerun never emits an event or exception ID already present. | `rerun.test.js` R2 |
| R3 | Automatically applied changes are not reported again once the catalog reflects them. | `rerun.test.js` R2/R3 |
| R4 | Pending reviews stay traceable without duplicates: same IDs, no new `HELD` rows; a later batch with the same proposal only updates `last_seen`. | `rerun.test.js` R4 |
| R5 | A committed version is skipped by scheduled runs; `SUCCESS_WITH_EXCEPTIONS` counts as committed. | `queue.test.js` |
| R6 | A failed or interrupted run is recoverable: an unapplied publish rebuilds the same plan; a stale `STARTED` row counts as an attempt and is marked `INTERRUPTED`. | `rerun.test.js` R6, `queue.test.js` |

A rerun of week 2 still reports 3 `HELD_REVIEW` rows and the same outcome
counts. That is correct: the source still disagrees with the trusted catalog
until someone decides.

## Non-functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| NFR-001 | Deterministic core: no clock reads, no randomness, no network; time and metadata are inputs; money in integer cents; sorting by plain string comparison. | R1 test; code review of `src/sheetops-core.js`. |
| NFR-002 | Traceability: every output row carries its batch ID; exceptions and changes carry source rows or review IDs. | Week-2 expected files. |
| NFR-003 | Bounds: file ≤ 2,000,000 bytes and ≤ 2,000 records; catalog ≤ 2,000 rows; ≤ 50 listed files; publish request ≤ 2,000,000 bytes; ≤ 3 automatic attempts per version. | `safety.test.js`, `queue.test.js`, `publish.test.js`. |
| NFR-004 | Security: credentials only in n8n; Drive shared as Viewer; values written as text or numbers, never formulas. | `publish.test.js` (formula-like text as `stringValue`); live T-SEC-1; M2 secret scan of the workflow export. |
| NFR-005 | Offline tests: no dependencies, no network, no Google account. | `npm test` with `package.json` listing no dependencies. |
| NFR-006 | Portability: the core runs in a standard n8n Code node (no `require`, no Node-only globals). | M2: paste-and-run check; core avoids `require`, `Buffer` and `TextEncoder`. |
| NFR-007 | Reproducible setup from the README. | M3. |

## Out of scope for version one

Multiple suppliers or currencies, REJECT decisions, SKU rename mapping,
archiving of old Changes and Exceptions rows, AI features, any frontend.
