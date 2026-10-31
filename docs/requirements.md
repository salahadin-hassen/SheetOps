# SheetOps requirements

Version 2.4. Rules referenced as "contract §n" are in
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
| **Offline** | Automated `node --test` tests in `test/`. No network, no Google account. The workflow scenarios run the real workflow JSON in a small n8n interpreter against a fake Google (**simulated**). |
| **Replay** | `npm run verify:n8n`: recorded scenarios replayed in the real n8n 2.41.7 engine, with HTTP nodes stood in by recorded responses. Real engine, no Google. |
| **Live** | Tests against a dedicated synthetic spreadsheet, run with authorization by `scripts/live/run-live-tests.js` through n8n (docs/setup.md §5). The harness itself is checked offline in `live-harness.test.js`: every test passes against the fake Google, and the version tests fail against a fake that ignores sheet checks. Its ledger settles a publication only by evidence: a `STARTED` row whose publish may have been sent blocks it at every age tested (1 minute to 3 days), with nothing written. M2, not run yet. |
| **Drill** | Deliberate failure exercises with recorded results. M3. |

Offline and replay evidence exist. No live evidence exists yet.

## Functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| FR-001 | Queue: process well-named versions in order-key order, one per run; report pre-download failures once each; reject anything older than the latest committed batch; block on halted or retry-exhausted versions; block as `QUEUE_TOO_LARGE`, with recovery steps, whenever the listing may be partial; while a publication is unresolved, process only its batch (contract §2). | Offline `queue.test.js`: backlog of three in order; modified file becomes a new version; correction of the committed file processed; older date and older version rejected as `OUT_OF_ORDER_FILE`; malformed names reported once, oldest first; Google-native files and oversize listings rejected before download; `BLOCKED` for halted and retry-exhausted versions; `QUEUE_TOO_LARGE` for 51 files and for a second page, with the exact recovery messages; `WAIT` on a fresh `STARTED` row; with an unresolved publication only its batch runs (older and newer files wait; halts and the retry limit still block; manual runs for other batches refused; `PUBLICATION_UNRESOLVED` when its file version is gone or two batches are unresolved). Offline `simulate.test.js`: an older file that arrives during an unresolved publication is not published first, and is later rejected as `OUT_OF_ORDER_FILE`; a Google-native file and a file listed at 2,000,001 bytes are rejected and the download node never runs; `QUEUE_TOO_LARGE` writes only the `BLOCKED` row. |
| FR-002 | Map headers through the alias table; reject the file on a missing or ambiguous column (contract §4). | Offline `fields.test.js` and `safety.test.js`: alias headers accepted; `MISSING_COLUMN` and `AMBIGUOUS_COLUMN` give `REJECTED_FILE` with no Catalog or Review write. |
| FR-003 | Parse RFC 4180 CSV: quoted fields, commas and line breaks inside quotes, escaped quotes, thousands separators in quoted prices; logical record numbering (contract §3). | Offline `csv.test.js` with `fixtures/parser/quoting.csv`; malformed-quote cases give `CSV_PARSE_ERROR` with the line; an unquoted comma gives `FIELD_COUNT_MISMATCH`, never a shifted row. |
| FR-004 | Apply only the documented safe clean-ups; reject invalid fields with code, field, raw value and source row (contract §5). | Offline `fields.test.js` table tests; week-2: the 5 rejected rows give exactly the 5 hand-written `ERROR` exceptions. |
| FR-005 | Group rows by SKU: collapse identical rows; hold conflicting groups and valid rows sharing a SKU with a rejected row (contract §6). | Offline week-2: SPC-020 rows 8–9 and SUG-001 row 20 are `HELD_CONFLICT`; catalog keeps 600.00 and 110.00. `review.test.js`: sibling-invalid and conflict cases. |
| FR-006 | Apply automatic changes: NEW_ITEM, PRICE_CHANGED below 25%, REACTIVATED, DISCONTINUED (contract §7). | Offline week-2: exactly 5 `APPLIED` Changes rows, hand-computed percentages 7.9 and 4.8. |
| FR-007 | Hold unit changes, name changes and price changes of 25% or more; keep all previous catalog values for the row (contract §7). | Offline week-2: TEA-001, EGG-030, BTR-002 `HELD_REVIEW`; 3 `PENDING` items; catalog unchanged for them. `review.test.js`: boundary 25.00% held and 24.99% applied; unit, name and large-price cases. |
| FR-008 | Resolve reviews with `APPROVE`; supersede changed or vanished proposals; never apply an invalid decision (contract §7). | Offline `review.test.js`: approval applies with the note copied; changed proposal supersedes; absent SKU supersedes; invalid decision kept verbatim and not applied. |
| FR-009 | Preserve the operator's decision and note on every normal write; read Review immediately before planning; just before publishing, read Review again and publish nothing (`FAILED`, `REVIEW_CHANGED` or `REVIEW_READ_FAILED`) if any decision or note differs or the read fails; document that an edit saved between that final read and Google applying the publish may still be lost (contract §8, v2.5). | Offline `review.test.js`: notes survive a normal reprocess; an approval survives a run that cannot apply it; sorting the tab by hand changes nothing; rejected and halted runs do not write Review; a tampered same-batch proposal gives `REVIEW_INVALID`. Offline `simulate.test.js`: an `APPROVE` and notes stay byte-identical through a scheduled run and a manual reprocess that cannot apply them, then the approval applies with its note; an approval typed after the final Review read is still lost and not applied. Offline `review.test.js` (final check): unchanged Review passes in any row order and with short rows; a changed decision, a cleared approval, a changed note, a type change (`5` vs `"5"`), an added, removed or duplicated item, and a changed header give `REVIEW_CHANGED`; a failed or malformed final read gives `REVIEW_READ_FAILED`. Offline `simulate.test.js`: an approval or a note saved before the final read aborts the run with no publish request, `FAILED` written over this run's row, and the edit kept; a failed final read (three tries) aborts with no publish and the next run processes the file; a rejected file skips the check; a late original landing before the final read is caught (`REVIEW_CHANGED`, the recovery sends nothing). Replay: `review-changed-abort`. Live: not run. |
| FR-010 | Protect the catalog: never delete rows; never discontinue a present SKU; halt when more than 30% of active SKUs are absent; override only for an explicit batch (contract §11). | Offline `safety.test.js`: 5/10 absent halts with one `MASS_DISCONTINUE` exception and no Catalog, Review or Changes write; 3/10 proceeds; override proceeds. |
| FR-011 | Account for every row: `rows_read = accepted + collapsed + rejected + held_conflict + held_review + blank` (contract §6). | Offline week-2: 19 = 6 + 1 + 5 + 3 + 3 + 1; the invariant is also checked inside the core on every run. |
| FR-012 | Keep one Run Log row per run with one authoritative final status: the commit marker inside the publish, `FAILED` only after a definitive failure and only over this run's own `STARTED` row (checked by reading exactly `'Run Log'!A<n>:Z<n>`), never a failure status after an unknown publish outcome (contract §11–12). | Offline `publish.test.js`: run row overwritten in place as the last request; 4xx (not 408) definitive, 5xx/408/timeout unknown; `FAILED` refused over an unreadable, empty, foreign or final row; an unknown outcome never writes and is confirmed for all four final statuses; the publish is refused when row n is not this run's `STARTED` row, and moved stale rows are not marked. Offline `simulate.test.js` and replay: lost response confirmed without a write; 503 writes nothing, scheduled runs then block with `PUBLICATION_UNRESOLVED` whatever the row's age, and an explicit reprocess marks the row `INTERRUPTED`; a publish that lands after the reconcile read leaves the row and the data in agreement; a Run Log sorted mid-run blocks every overwrite; a stale row changed mid-run keeps its new status. Live (M2): T-LOST. |
| FR-013 | Publish each run through one atomic `spreadsheets.batchUpdate` request that starts with the version check and writes history rows at fixed ranges; check the plan first (contract §12). | Offline `publish.test.js`: request order and contents; the version check deletes the planned version and adds a strictly higher one, and two plans from one version delete the same ID; history rows at the fixed range below the rows read, growing the grid; the same plan builds the same request; no `appendCells`; halted and rejected plans contain no Catalog or Review requests; text written as `stringValue`; `PUBLISH_TOO_LARGE`; `OUTPUT_SCHEMA_MISMATCH`. Live (M2): T-ATOM-1, T-ATOM-2, T-SEC-1, T-VERSION-1, T-VERSION-2. |
| FR-014 | Reruns and recovery (contract §9, §12). See R1–R7 below. | Offline `rerun.test.js`, `simulate.test.js`. Replay: both late-landing races. Live (M2): T-RECOVER, T-LOST, T-VERSION-2. |
| FR-015 | Ship an importable n8n workflow that wires the core to Google: generated from the core, no secrets, idempotent-only retries, every route tested (contract §12–13). | Offline `workflow.test.js`: the committed JSON equals a fresh build; every Code node embeds the current core; no secrets or credential IDs; references resolve; retry policy; every failure reads the run row before `Write FAILED row`, which is reachable only through `Resolve failure`; every execution is saved. the version is read before the tabs. Offline `simulate.test.js`: 31 end-to-end scenarios. Replay: 14 scenarios match node by node in real n8n 2.41.7, covering every Switch output; the production JSON survives an import/export round trip. |
| FR-016 | Build Google request URLs and check every Google response before using it (contract §12). | Offline `google.test.js`: exact encoded URLs, including `valueRenderOption=UNFORMATTED_VALUE` and `dateTimeRenderOption=SERIAL_NUMBER` on every read and the run row's exact range; settings refused while they hold placeholders; listing, value-range, metadata, append and publish responses checked. Offline `safety.test.js`: date cells read with the documented convention (serials 1, 60, 61, 46300, 46314, 2958465 and ISO text), and 0, negatives, fractions, 2958466, digit strings and impossible dates refused in Catalog and Review. Live (M2): the same calls against Google. |

### Rerun properties (FR-014)

| ID | Property | Offline test |
|---|---|---|
| R1 | The same inputs give a byte-identical plan; run information changes only the Run Log row. | `rerun.test.js` R1 |
| R2 | A rerun never emits an event or exception ID already present. | `rerun.test.js` R2 |
| R3 | Automatically applied changes are not reported again once the catalog reflects them. | `rerun.test.js` R2/R3 |
| R4 | Pending reviews stay traceable without duplicates: same IDs, no new `HELD` rows; a later batch with the same proposal only updates `last_seen`. | `rerun.test.js` R4 |
| R5 | A committed version is skipped by scheduled runs; `SUCCESS_WITH_EXCEPTIONS` counts as committed. | `queue.test.js` |
| R6 | A failed or interrupted run is recoverable: an unapplied publish rebuilds the same plan. A `STARTED` row 15 minutes or older counts as an attempt and is an unresolved publication: by default it blocks scheduled runs, whatever its age, until a person reprocesses it explicitly, which marks it `INTERRUPTED`; with `auto_recover_uncertain` on, a scheduled run reprocesses it. | `rerun.test.js` R6, `queue.test.js` |
| R7 | An uncertain publication that lands late, while a recovery runs, leaves every tab as one publication would and no duplicate ID; the recovery's data writes equal the original's. Without Google's sheet checks, fixed ranges still prevent duplicate rows. | `simulate.test.js`: original lands after the recovery committed (rejected), between the recovery's read and publish (recovery rejected), and with the check switched off |

A rerun of week 2 still reports 3 `HELD_REVIEW` rows and the same outcome
counts. That is correct: the source still disagrees with the trusted catalog
until someone decides.

## Non-functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| NFR-001 | Deterministic core: no clock reads, no randomness, no network; time and metadata are inputs; money in integer cents; sorting by plain string comparison. | R1 test; code review of `src/sheetops-core.js`. |
| NFR-002 | Traceability: every output row carries its batch ID; exceptions and changes carry source rows or review IDs. | Week-2 expected files. |
| NFR-003 | Bounds: file ≤ 2,000,000 bytes and ≤ 2,000 records; catalog ≤ 2,000 rows; ≤ 50 listed files; publish request ≤ 2,000,000 bytes; ≤ 3 automatic attempts per version; per-call timeouts 20 s (reads), 60 s (download, publish); 300 s per run. | `safety.test.js`, `queue.test.js`, `publish.test.js`, `workflow.test.js`. |
| NFR-004 | Security: credentials only in n8n; Drive shared as Viewer; values written as text or numbers, never formulas. | Offline `workflow.test.js` (secret scan of the export); `publish.test.js` and `simulate.test.js` (formula-like text stored as text); live T-SEC-1. |
| NFR-005 | Offline tests: no dependencies, no network, no Google account. | `npm test` with `package.json` listing no dependencies. |
| NFR-006 | Portability: the core runs unchanged in a standard n8n Code node. | Replay: the core runs in six Code nodes of the real n8n 2.41.7 task runner with outputs identical to Node; the core uses no `require`, `Buffer` or `TextEncoder`. |
| NFR-007 | Reproducible setup from the README. | M3. |

## Out of scope for version one

Multiple suppliers or currencies, REJECT decisions, SKU rename mapping,
archiving of old Changes and Exceptions rows, AI features, any frontend.
