# Design-to-requirements review

Reviewed 29 October 2026 against the operator-console design (canvas
version 16), the eight screenshots in `docs/case-study-assets/`, the data
contract, the requirements, and the current M2 working tree.

The design is a concept. Nothing here is evidence that Google Sheets
integration works.

## Evidence levels

| Code | Meaning | Status today |
|---|---|---|
| **D** | Design: a screen shows the behaviour | Canvas v16; screenshots rendered from v16 files |
| **U** | Offline unit, fixture and property tests of the core | 171/171 pass (`npm test`, 29 Oct, after contract v2.5) |
| **S** | Whole workflow in the simulator against a fake Google | 31 scenarios, inside the 171 |
| **R** | Real n8n 2.41.7 engine, recorded Google responses | 14/14 (`npm run verify:n8n`, 29 Oct, after contract v2.5) |
| **L** | Live Google Sheets and Drive | **None.** No live run exists |

## Mapping

| Design area | What the screen communicates | Required behaviour | Evidence | Gaps |
|---|---|---|---|---|
| **Overview** (`v16-01`) | Publishing paused by an unknown outcome; last committed run; row accounting; items needing attention | One authoritative final status per run; `rows_read` = sum of outcomes; a STARTED row ≥ 15 min is unresolved and blocks publishing | U: week-2 run row exact, accounting invariant checked on every run, `queue`: "an old one is an unresolved publication". S, R: final outcome of all 14 scenarios | L. The console is not built: in v1 this information exists only as Run Log rows and the n8n execution record |
| **Incoming Files** | Queue order; pre-download rejections; a stale file rejected; queue paused behind an unresolved run | Order key (effective date, modified, created, file ID); `OUT_OF_ORDER_FILE`; pre-download codes reported once; `PUBLICATION_UNRESOLVED`; `QUEUE_TOO_LARGE` | U: 18 `queue` tests. S: native/oversize files, malformed name, paged listing, older file during an unresolved run. R: `bad-filename`, `blocked-halted`, `blocked-unresolved-old-started`, `idle-committed` | L: real Drive listing, paging and `modifiedTime` precision untested. The screen lists files the sheet never records (waiting files); showing them would need a Drive read that v1 does not have |
| **Review, editable** (`v16-02`) | Why a change is held; current vs proposed; APPROVE only; consequences of approving | Hold at ≥ 25.00% in cents, unit and name changes; APPROVE applies only when a later list still proposes the value; supersede on change or absence; decisions and notes preserved by `review_id` | U: `review` 25.00% held / 24.99% applied, approval applies with note, superseding, invalid decision kept, hand-sorting harmless, notes preserved. S: APPROVE survives reprocessing, then applies | L. The final Review check (v2.5) aborts on a change before the publish, but an edit after that check can still be lost (see below). In v1 the operator types APPROVE in the sheet; the console's Approve button is design only |
| **Review, read-only** | Decisions locked while a run shows STARTED, with the reason | Contract §8: "Do not edit the Review tab while a run is active" | D only | **Gap: nothing enforces the lock.** SheetOps applies no sheet protection, so an operator can still edit Review during a run. The screen shows a safeguard the product does not have; today it is an operating rule |
| **Approval dialog** (`v16-03`), **approved state** (`v16-04`) | Approved ≠ committed; catalog still 300.00 | APPROVE is a recorded decision; the catalog changes only in a later committed publish | U: `review` "APPROVE applies a held change on reprocessing". S: approval applied by a manual reprocess | L. The dialog's behaviour (focus, announcements) is design evidence from the canvas runtime and Orca, not product behaviour |
| **Catalog** (`v16-07`) | Committed values only; held proposals as notes; previous price; last issue | Catalog replaced in full from the plan; only documented changes; reruns change nothing | U: week-2 `catalog_after` exact; `rerun` R1–R4 (byte-identical plan, no added rows). R: happy path | L: T-LIVE-1 (live tabs equal the expected fixture) not run |
| **Change History** (`v16-08`) | Append-only trail from held to applied after review | Event IDs; fixed-range writes; no duplicates on replay; `APPLIED_AFTER_REVIEW` with note | U: `changes_new` exact; `publish` fixed ranges; `rerun` R6. S: "if Google did not enforce the version check, the fixed-range writes still prevent duplicate rows" | L: T-ATOM-1/2, T-VERSION-1 |
| **Exceptions** | Every row not applied, with raw value and action | Codes and severities per contract §5–6; raw values verbatim | U: `fields`, `csv`, week-2 `exceptions_new` exact (9 rows) | L |
| **Run Details**, unknown outcome (`v16-05`, `v16-06`) | Stage track limited to what the sheet proves; no retry; investigation steps | 4xx except 408 definitive → FAILED only over this run's own verified STARTED row; 5xx/408/timeout/lost → nothing written; later reprocess marks INTERRUPTED | U: `publish` classification, FAILED only over own row, nothing after unknown. S: 403, 503, lost response, late landing, unreadable marker, sorted Run Log. R: the same 8 failure scenarios | **L: T-LOST-A, T-LOST-B, T-VERSION-1/2.** Steps 2–4 detail exists only in n8n; the screen correctly shows "not in the sheet" |
| **Run statuses** | Halted, blocked, rejected, superseded, failed cards | `>` 30% absent halts (3/10 proceeds, 4/10 halts); RETRY_LIMIT after 3 attempts; BATCH_HALTED | U: `safety` 3/10 and 4/10, override; `queue` retry limit. S: 50% halt. R: `blocked-halted`, `download-failed` | L |
| **State inventory** | Loading and empty states; state matrix | None in v1: there is no console to load | D only | Design reference for a future frontend; no behaviour to verify |
| **Prototype journey** | File → validation → review → approval → publication → audit | As above | D, plus run-1002 values computed by the core offline | The journey is simulated; no Google or n8n operation runs |

## Findings

1. **Review was read once; since contract v2.5 it is checked again before
   publishing.** On the owner's decision of 29 October 2026, the workflow now
   runs `Read working tabs → Plan and build → Re-read Review → Check Review →
   Publish`. If any decision or note differs from the read the plan was built
   from, or the final read fails, nothing is published and the run ends
   `FAILED` (`REVIEW_CHANGED`, `REVIEW_READ_FAILED`). This shortens the window
   but does not close it: an edit saved between the final read and Google
   applying the publish can still be lost (contract §8, "Remaining loss").
   Google's reference itself notes that changes "may be altered with respect
   to collaborator changes".
2. **The read-only Review lock is design only.** In v1 it is an operating
   rule, not a control.
3. **The concurrency guarantee of the version check is unproven.** Google
   documents that `batchUpdate` validates every request and applies all or
   nothing. The version check also relies on the inference that deleting a
   missing sheet ID is an invalid request. What happens when two publishes
   arrive concurrently is not documented; only T-VERSION-2 can show it.
4. **No live evidence of any kind.** SheetOps' own n8n instance has never
   been started on this machine (`var/n8n` is absent), so no credential and no
   imported workflow exist. The Google project, service account, spreadsheet
   and inbox could not be confirmed.

## Google documentation relied on

From the `spreadsheets.batchUpdate` reference (checked 29 October 2026):
"Requests will be applied in the order they are specified. If any request is
not valid, no requests will be applied", and "it is guaranteed that the
updates in the request will be applied together atomically". These are
documented guarantees, not observed results.
