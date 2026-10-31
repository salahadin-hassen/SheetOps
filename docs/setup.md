# Setting up SheetOps (dedicated test spreadsheet)

This guide connects SheetOps to **one synthetic spreadsheet and one Drive folder
made only for testing**. Do not point it at real business data until the live
tests in section 5 have passed.

You need a Google account and about 20 minutes. Nothing here costs money.

## 1. Google Cloud: a service account

1. Open <https://console.cloud.google.com> and create a project, for example
   `sheetops-demo`.
2. **APIs & Services → Library**: enable **Google Sheets API** and
   **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create service account**, for example
   `sheetops-n8n`. Grant it no roles; it gets access only to what you share
   with it in section 2.
4. Open the account, **Keys → Add key → Create new key → JSON**. A file
   downloads.
   - Keep the file outside this repository (`*.key.json` is gitignored, but
     safer is a folder you never commit).
   - Never paste its contents into chat, code, screenshots or issues.

Note the account's email address (`...@...iam.gserviceaccount.com`).

## 2. Google Drive: the spreadsheet and the inbox

1. Create a spreadsheet whose title contains `synthetic`, for example
   **SheetOps demo (synthetic)**, with five tabs named exactly: `Catalog`,
   `Review`, `Changes`, `Exceptions`, `Run Log`. Rename or delete the
   default `Sheet1`; the test runner refuses any other tab. Keep all five
   visible.
2. Before pasting anything, select the whole sheet in each tab and choose
   **Format → Number → Plain text**. Otherwise Sheets turns pasted dates into
   date values. SheetOps reads those as dates (contract §10), but text is
   clearer.
3. Run `node scripts/print-headers.js` and paste each printed line into cell
   **A1** of its tab. Sheets splits it across the columns.
4. For the week-2 demo, run `node scripts/print-headers.js --demo-catalog` and
   paste the catalog rows into **Catalog!A2**.
5. SheetOps adds one more tab itself on its first publish: `_sheetops_version`,
   hidden, one cell, empty, with a sheet ID above 1,000,000,000. It is the
   publication version check (contract §12). Do not create it yourself, and do
   not unhide, edit, rename or delete it.
6. Share the spreadsheet with the service account email as **Editor**.
   Untick "Notify people".
7. Create a Drive folder, for example **SheetOps inbox**. Share it with the
   service account as **Viewer**; SheetOps never changes source files.
8. Copy the two IDs from the browser address bar:
   - spreadsheet: `docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
   - folder: `drive.google.com/drive/folders/<FOLDER_ID>`

## 3. n8n: SheetOps' own instance

1. Stop LeadIntel's n8n if it is running. This laptop should run one n8n at a
   time.
2. Run `scripts/start-n8n.sh`. It keeps everything in `var/n8n` (gitignored),
   listens on <http://localhost:5680>, queues overlapping scheduled runs
   (`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`) and stops any run after 300 seconds.
3. Open <http://localhost:5680> and create the local owner account.

## 4. Credential, workflow and settings

1. **Credentials → Add credential → Google Service Account API.**
   - Name it exactly `SheetOps Google service account`.
   - Service Account Email: `client_email` from the key file.
   - Private Key: `private_key` from the key file.
   - Turn on **Set up for use in HTTP Request node** and enter these scopes:
     `https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly`
2. **Workflows → Import from file**: `workflow/sheetops.workflow.json`.
   The eleven Google nodes refer to the credential by that exact name. If a node
   still shows no credential, select it on that node.
3. Open **Settings** and replace `PASTE_SPREADSHEET_ID` and `PASTE_FOLDER_ID`.
4. Do **not** activate the workflow yet. Run it with **Test workflow** while the
   live tests below are done.

## 5. Live tests (M2, on the test spreadsheet only)

**Before you start:**
- Sections 1–4 are done.
- The spreadsheet's title contains `synthetic`.
- The inbox holds exactly one file: `fixtures/week2/demo-supplier_2026-10-19.csv`, uploaded unchanged.

**The two accepted spreadsheet states.** The runner accepts exactly these and
refuses anything else, before any write:

| State | Tabs | When |
|---|---|---|
| Uninitialized | Exactly `Catalog`, `Review`, `Changes`, `Exceptions`, `Run Log`, all visible, with SheetOps' header rows | After section 2, before the first run |
| Initialized | The same five, plus `_sheetops_version`: hidden, 1×1, no values, sheet ID between 1,000,000,001 and 2,147,483,645 | After the first publishing run (step 2 below), and after every later one |

Refused: a missing business tab; any other tab, including `Sheet1`; a hidden
business tab; a wrong header; two tabs with one sheet ID; a near-miss name
such as `_SheetOps_Version`; a version tab that is visible, not 1×1, holds a
value, or has an ID SheetOps never creates.

Expected state at each stage:
- **After section 2:** uninitialized.
- **After your UI run (step 2 below):** initialized. That run creates the
  version tab exactly as the runner expects; an offline test runs the same
  initialization and checks that the next validation accepts it.
- **During the runner:** each test group, and each T-VERSION-2 trial, resets
  the spreadsheet to one of the two states on purpose, then checks it.

**Your part, in the n8n UI (T-UI, T-LIVE-1).**

1. Open the imported workflow. Open each of the eleven Google nodes and check
   that **Credential** shows `SheetOps Google service account`:
   - List inbox
   - Read Run Log
   - Append STARTED row
   - Append BLOCKED row
   - Download CSV
   - Read sheet metadata
   - Read working tabs
   - Re-read Review
   - Publish
   - Read run row
   - Write FAILED row
2. Run it once from **Run manually** (Test workflow). The **Done** node should
   show `run_status: SUCCESS_WITH_EXCEPTIONS`.
3. Stop n8n (Ctrl+C in the terminal running `scripts/start-n8n.sh`). The
   runner uses the same database through the n8n CLI and needs the server
   stopped.

**Then the runner** (about 45 minutes, including a 16-minute wait):

```
node scripts/live/run-live-tests.js all
```

How the runner works:
- **Google calls:** every call goes through n8n with the configured
  credential, so the key is never read outside n8n.
- **Settings:** the spreadsheet and folder IDs come from the Settings node of
  your imported workflow, and the credential's ID from n8n's database. The
  credential's data is never read.
- **Ledger:** before sending any write, the runner records it in
  `var/live/ledger-<spreadsheet ID>.json`, then records what the answer
  establishes. The ledger survives between runs. Only this evidence settles an
  outcome:

  | Outcome | Evidence |
  |---|---|
  | not submitted | the publish was never sent; or the n8n run finished without building one; or the connection failed before it was made (DNS failure, connection refused, or a host under `.invalid`, which never resolves) |
  | rejected | Google answered 4xx, other than 408 |
  | committed | Google answered 2xx, or the run's own commit marker is in Run Log |
  | unknown | anything else: 5xx, 408, a timeout, a lost connection, a crash |

  Time passing never changes an outcome. An old `STARTED` row is not "stale
  and safe", and neither is a stopped n8n process.
- **Preflight (fail-closed):** before every reset, the runner stops with
  `PUBLICATION_UNRESOLVED`, writing nothing, unless all of these hold:
  - no n8n process is running;
  - the spreadsheet is in one of the two accepted states;
  - every write in the ledger is established, after first checking unknown
    ones against their commit markers;
  - every `STARTED` row belongs to a run the ledger shows as not submitted
    or rejected.

  A `STARTED` row the ledger knows nothing about blocks the runner, whatever
  its age. So does a row someone set to `FAILED` by hand while its outcome
  is unknown. See "An unresolved publication" below.
- **Resets:** a reset clears the business tabs and writes the demo catalog,
  plus the trial's own `STARTED` rows. It never deletes a business tab, so
  their sheet IDs stay the same.
  - The reset deletes the version tab it read, so it is refused if anything
    changed the version since.
  - It then leaves the spreadsheet **uninitialized**, or **initialized** with
    a new version ID. That ID follows the core's own rule and is above every
    ID the runner has seen.
  - The runner reads the spreadsheet back and compares every cell, its type
    and every tab's ID with what the reset intended. On any difference it
    stops before preparing a test request.
- **T-VERSION-2 trials:** each of the eight trials gets its own reset and
  readback, alternating initialized (the race on deleting the same version
  tab) and uninitialized (the race on adding the first one). Both requests
  are then built from that one read. The runner checks that both carry its
  version, sends them together, and reads the final state twice, 20 seconds
  apart. Evidence for each trial is saved separately under
  `T-VERSION-2/trial-<n>/`. A trial in which neither request won, or a
  response was lost, is reported **INCONCLUSIVE**, never as a pass. A lost
  response also stops the remaining trials.
- **Evidence:** saved to `var/live/live-<time>/` (gitignored): every request,
  response and full before-and-after snapshot (every cell with its type, every
  tab's properties, the version tab), plus `report.json`.
- **Offline checks first:** `--dry-run` runs the same suite against the fake
  Google, and `--broken-google` against a fake that ignores the version
  check. Both run in `npm test`.

| Test | What happens | Pass when |
|---|---|---|
| T-UI | Read n8n's records of your import and run | All eleven Google nodes reference the credential by its ID, the workflow is inactive, and a successful manual run published week 2 |
| T-LIVE-1 | Snapshot after your UI run | Catalog, Review, Changes and Exceptions equal `fixtures/week2/expected/` (with the real Drive file ID in the batch IDs); one Run Log row with the expected counts; a hidden version tab |
| T-ATOM-1 | A valid publish with one invalid request appended | HTTP 400, and the full snapshot is unchanged (tabs, grid sizes, version tab) |
| T-ATOM-2 | The same publish without the invalid request | HTTP 200, and the full snapshot equals the oracle: the fake Google applying the same request to the before-snapshot |
| T-SEC-1 | Part of T-ATOM-2: a name that looks like a formula | The cell's `userEnteredValue` is a `stringValue`, not a `formulaValue` |
| T-VERSION-1 | Publish A, then publish B, planned from the version before A | A: HTTP 200 and equal to the oracle. B: HTTP 400 and the full snapshot unchanged; B's row still `STARTED`; no duplicate IDs |
| T-VERSION-2 | Eight trials, each from its own verified baseline: two different publishes planned from that baseline's version, sent in one HTTP Request node run, so both are in flight at once | In every trial exactly one gets HTTP 200. The final snapshot equals the oracle for the winner alone and is still the same 20 s later; the loser's row is still `STARTED`; no duplicate IDs; version IDs never go backwards. The responses, `date` headers and timings are recorded for each trial |
| T-LOST-A | The Publish timeout shortened until the reply is lost although Google applied the request (several timeouts are tried) | **Done** reports the committed status, `Write FAILED row` never runs, the tabs equal T-LIVE-1, and the next run is `IDLE` and sends no publish |
| T-LOST-B | Publish addressed to `sheets.googleapis.invalid`, so it provably never reaches Google | SheetOps reports `PUBLISH_OUTCOME_UNKNOWN`, because it cannot know, and only the `STARTED` row changed. The runner's ledger records it as not submitted. A run one minute later is `WAIT`; after 16 minutes the scheduled run is `BLOCKED` (`PUBLICATION_UNRESOLVED`) and publishes nothing. An explicit reprocess with `target_batch_id` then recovers: the old row is `INTERRUPTED`, week 2 is published once, and its data writes equal the original's in a new request |

**Concurrency evidence is partly indirect.** That both requests are in
flight at once comes from n8n's source code: HTTP Request 4.2 starts every
item's request before awaiting any. The runner also records the node's total
time against single publishes. Google's own ordering of the two is not
visible.

**Automatic recovery stays off** (`auto_recover_uncertain`, contract §2)
unless T-VERSION-1 and T-VERSION-2 pass. If they fail or are inconsistent, it
must stay off, and every uncertain publication waits for a person.

**When the runner stops with `PUBLICATION_UNRESOLVED`**, run:

```
node scripts/live/run-live-tests.js reconcile
```

This is read-only. It settles what the spreadsheet itself establishes (commit
markers) and lists everything still unknown, with the evidence. If, after
inspecting the evidence below, you conclude a publication was not applied,
record that explicitly:

```
node scripts/live/run-live-tests.js reconcile --declare=<entry ID>:not-applied --reason="what you inspected"
```

(For a `STARTED` row the runner never sent, use `run:<run ID>` in place of
the entry ID.) A declaration is refused without a reason, for an outcome
already established, and when the spreadsheet contradicts it. When accepted,
the outcome stays **unknown**, with your declaration beside it. Every later
report lists it as unverified. It is never turned into "rejected" or
"failed".


## Day-to-day rules

- Name supplier files `demo-supplier_YYYY-MM-DD.csv`, where the date is the
  price list's effective date.
- Approve held changes by typing `APPROVE` in Review's `decision` column. They
  apply on the next processed file; to apply now, set `reprocess_latest` in
  **Manual run options** and run manually.
- Do not edit Review while Run Log shows a `STARTED` row. An edit saved in
  the few seconds between SheetOps reading Review and publishing **may be
  lost**: the item keeps its old decision and note, nothing is applied, and you
  type the edit again. Do not add columns to the managed tabs; use Review's
  `note` column.
- Do not sort, insert or delete Run Log rows while a run is active. SheetOps
  then refuses to overwrite anything; the run's row stays `STARTED` and a
  later run recovers it.
- **A `STARTED` row that stays,** or `BLOCKED` with `PUBLICATION_UNRESOLVED`:
  see "An unresolved publication" below. Until it is resolved, SheetOps
  publishes nothing else.
- **`BLOCKED` with `QUEUE_TOO_LARGE`.** SheetOps processes nothing while
  the listing might be incomplete:
  - more than 50 files: move files whose Run Log row is committed or
    `REJECTED_FILE` into another folder, for example **SheetOps processed**,
    until at most 50 remain, then run again;
  - "more than one page" with fewer files: run again; Drive sometimes splits a
    listing early. If it repeats, reduce the inbox as above.
- If the spreadsheet itself cannot be written (for example, permission
  removed), SheetOps cannot log that in Run Log. Check n8n's **Executions**
  list; every execution is saved, and n8n deletes saved executions after 14
  days by default.

## An unresolved publication

A run's row shows `STARTED` after the run ended, and SheetOps blocks with
`PUBLICATION_UNRESOLVED`. Its age only shows that the run is no longer
active. Whether its publish never left, was refused, or applied with a lost
answer has to be established from evidence. Inspect, in this order:

1. **The n8n execution of that run** (Executions; the run ID is the execution
   ID). Read three nodes:
   - **Done**: the code and message.
   - **Publish**: an HTTP status of 2xx means committed, and 4xx other than
     408 means refused. Anything else establishes nothing. Only an error
     showing the connection was never made ("The connection cannot be
     established", "refused the connection", a DNS error) shows the
     request never left.
   - **Plan and build**: the version the publish was planned from
     (`deleteSheet`) and the one it creates (`addSheet`).
2. **The spreadsheet.** Check the run's Run Log row: `STARTED` means its
   commit marker is not there now. Then check whether Changes or Exceptions
   hold rows with that run's batch ID. They are written in the same atomic
   request as the marker, so rows without the marker are a contradiction:
   stop and investigate. Do not unhide `_sheetops_version` to read its ID.
   The runner's `reconcile` reads it for you.
3. **n8n's age of the execution record:** n8n deletes executions after 14
   days. Inspect before then.

Then decide:

| What the evidence shows | What to do |
|---|---|
| Not sent, or refused (4xx) | Reprocess it: a manual run with **Manual run options** `target_batch_id` set to that row's batch ID. Safe. |
| Committed | It cannot still show `STARTED`. Investigate the contradiction before anything else. |
| Unknown (5xx, 408, timeout, lost connection, no record) | The publish may still land. Either wait and check again (if it lands, the row shows its final status and nothing more is needed), or reprocess it explicitly as above, accepting the risk below. |

**The risk of reprocessing an unknown publication.** The reprocess plans from
the current version and moves it, so the original, if it lands later, should
be rejected by the version check. That is Google's documented behavior,
confirmed for SheetOps only once T-VERSION-1 and T-VERSION-2 pass. If the
check did not hold, a late original could replace Catalog and Review with its
older snapshot, and Run Log could show two committed rows for the batch.
Changes and Exceptions would still not repeat rows: they are written at fixed
ranges. Note in Review or in your own records what you inspected and why you
reprocessed.

**Never type `FAILED` or `INTERRUPTED` over the row by hand.** That claims an
outcome no evidence established. SheetOps would then move on to newer files
with nothing to stop the original landing on top of them. If the file version
has left the inbox, move the same file back: re-uploading creates a new
version, which is not the same batch. If it is gone for good, the queue stays
blocked until you decide. Any manual change to Run Log is a forced recovery
with exactly the risk above, and you should record it.
