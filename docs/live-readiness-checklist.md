# Live-test readiness checklist

Use this before the first live Google run. It follows `docs/setup.md` and
adds what a review of `scripts/live/` found on 27 October 2026. Nothing here
has run against Google yet.

**Live execution needs the owner's explicit go-ahead**, given at the time of
the run. Completing this checklist is preparation, not authorization.

## 1. Google Cloud (setup §1)

- [ ] A **dedicated** project used only for this test, for example `sheetops-demo`.
- [ ] **Google Sheets API** and **Google Drive API** enabled. Nothing else is needed, and nothing used here is a paid API.
- [ ] A service account, for example `sheetops-n8n`, with **no project roles**.
- [ ] A JSON key stored **outside the repository**, never pasted into chat, code, screenshots or issues.

## 2. Synthetic spreadsheet and inbox (setup §2)

- [ ] Spreadsheet title contains **`synthetic`**. The runner refuses any other title (`scripts/live/lib.js`).
- [ ] Exactly five visible tabs: `Catalog`, `Review`, `Changes`, `Exceptions`, `Run Log`. `Sheet1` is renamed or deleted, and there are no other tabs.
- [ ] Each tab formatted as **Plain text** before pasting.
- [ ] Headers pasted from `node scripts/print-headers.js`. The lines come from the core's own column constants.
- [ ] Demo catalog pasted into `Catalog!A2` from `node scripts/print-headers.js --demo-catalog`.
- [ ] **No** `_sheetops_version` tab created by hand. SheetOps creates it on its first publish.
- [ ] Spreadsheet shared with the service account as **Editor**; inbox folder shared as **Viewer**.
- [ ] Inbox holds **exactly one** file: `fixtures/week2/demo-supplier_2026-10-19.csv`, uploaded unchanged.
- [ ] No real business data anywhere in the project, spreadsheet or folder.

## 3. n8n (setup §3–4)

- [ ] LeadIntel's n8n stopped. Only one n8n runs at a time; SheetOps uses port 5680 and `var/n8n`.
- [ ] `scripts/start-n8n.sh` started; local owner account created.
- [ ] Credential **Google Service Account API**, named exactly `SheetOps Google service account`, with the two scopes from setup §4.
- [ ] **The current** `workflow/sheetops.workflow.json` imported (33 nodes), replacing any earlier import: an earlier import is out of date, and the runner refuses two workflows with the same name. All twelve Google nodes show the credential.
- [ ] Encode CSV and Read Review decisions are present; Download CSV returns a file.
- [ ] Settings: `PASTE_SPREADSHEET_ID` and `PASTE_FOLDER_ID` replaced.
- [ ] Workflow **not activated**.

## 4. Manual UI verification (setup §5, T-UI and T-LIVE-1)

- [ ] One run from **Run manually**. **Done** shows `run_status: SUCCESS_WITH_EXCEPTIONS`.
- [ ] The spreadsheet now has the hidden version tab. Do not unhide or edit it.
- [ ] n8n stopped (Ctrl+C) before the runner starts. The runner refuses while any n8n process is running.

## 5. Runner (setup §5)

- [ ] Offline first: `npm test` passes. It includes the runner's `--dry-run` and `--broken-google` checks.
- [ ] Time set aside: the guide estimates about 45 minutes, including T-LOST-B's 16-minute wait. That estimate is not yet measured.
- [ ] With explicit authorization: `node scripts/live/run-live-tests.js all`.
- [ ] If it stops with `PUBLICATION_UNRESOLVED`: run `node scripts/live/run-live-tests.js reconcile` (read-only), inspect the evidence, and only then consider `--declare=…:not-applied --reason="…"`.
- [ ] Never type `FAILED` or `INTERRUPTED` into Run Log by hand.

## 6. Reading the result correctly

These points were found by reading the runner. They are not covered by the setup guide.

- **Exit codes** (changed 4 November 2026). 0 means every test the selected phases require passed; a single phase prints `PARTIAL VERIFICATION PASSED` and records `verification: PARTIAL`, not the full suite. 1 means at least one result is failed, inconclusive, errored, unresolved, skipped when required, missing or malformed. 2 means the runner could not start or report. The terminal summary and the `summary` block in `report.json` come from one assessment and list each class separately.
- **An inconclusive result is neither a pass nor a failure.** It exits 1 and keeps its classification. Read its details in `report.json` and its evidence folder. For the version tests the runner also prints "VERSION CHECK NOT CONFIRMED", and automatic recovery stays off.
- **`--reps=N`** must be a positive whole number, and at least 8 on a live `harness` or `all` run: fewer is refused before any live step. A live T-VERSION-2 with fewer than 8 passing trials can never count as a pass.
- **Phases.** `all` runs `check` (T-UI, T-LIVE-1), then `harness` (T-ATOM-1/2, T-SEC-1, T-VERSION-1/2), then `recovery` (T-LOST-A, T-LOST-B). An error in one phase skips the later ones. The individual phases and `--reps=N` (T-VERSION-2 trials, default 8) exist but are documented only in the runner's header comment.
- **Evidence** is saved under `var/live/live-<time>/`, and the ledger under `var/live/ledger-<spreadsheet ID>.json`. Both are gitignored; keep them.

## 7. Documented test list versus the runner

Every test in setup §5 is implemented in `scripts/live/run-live-tests.js`:
T-UI, T-LIVE-1, T-ATOM-1, T-ATOM-2, T-SEC-1, T-VERSION-1, T-VERSION-2
(8 trials by default), T-LOST-A and T-LOST-B (including the 16-minute wait).
The runner adds nothing beyond the guide except the phase names and `--reps`.
T-ENCODING and T-FORMULA are the exception: they are manual checks in setup §5, and
the runner's result does not include them.
Live behaviour, timing and Google's answers remain unverified until the run.
