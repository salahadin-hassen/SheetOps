# SheetOps

Supplier price-list reconciliation for Google Sheets. Each week a supplier's
CSV price list lands in a Google Drive folder. SheetOps validates it, compares
it with the current catalog, applies safe changes, holds risky ones for a
person to approve, and publishes five tabs to one spreadsheet: Catalog,
Review, Changes, Exceptions and Run Log. n8n runs the workflow; the processing
logic is one dependency-free JavaScript file.

## Status

- **M1 (offline core): complete.**
- **M2 (n8n workflow): built and verified without Google.** Committed on the
  `m2-frontend` branch, which is not merged; `main` holds
  only M1 (`4addaa1`).
  - The workflow is generated from the core.
  - It runs end to end in a simulator against a fake Google.
  - Its scenarios replay node for node in the real n8n 2.41.7 engine.
  - Live tests on a real spreadsheet are next; they need the setup in
    [docs/setup.md](docs/setup.md).
- **Operator console: read-only, on offline demo data.** A deliberate scope
  expansion beyond version one; also on `m2-frontend`. It has Overview, Runs, Run
  details, Review, Exceptions, Incoming files (files the sheet has a record of),
  Catalog, Change history and Connection. The live Drive inbox, live Google data
  and any write action are not implemented. See [frontend/README.md](frontend/README.md).
- **M3 (failure drills, handover documentation): not started.**

**The workflow file changed on 5 November 2026 (33 nodes): any copy already imported
into n8n is out of date and must be replaced before a manual test.**

**Nothing in this repository has run against a real spreadsheet yet.** SheetOps
is not production-ready. All results below are offline or simulated.

Offline evidence, 5 November 2026: root tests 171/171 at `eeac3a1`, and 252/252 with the later runner, audit and contract v2.6 changes; n8n replay 16/16 scenarios matching the simulator, plus the import round-trip and built-in checks; frontend tests 169/169; typecheck and production build pass.

## Run the tests

Requires Node.js 22 or later (developed on v24.21.0). There is nothing to install.

```
npm test                 # offline tests, about 15 seconds, no network
npm run build:workflow   # regenerate workflow/sheetops.workflow.json after changes
npm run verify:n8n       # replay 16 scenarios in the local n8n (about 6 minutes on a memory-constrained laptop, no network; set SHEETOPS_VERIFY_DIR to use another folder)
node scripts/live/run-live-tests.js all --dry-run   # the live suite against the fake Google
```

The tests use no network, no Google account and no paid services.

The live runner exits 0 only when every test the selected phases require has
passed; a single phase is reported as PARTIAL VERIFICATION, and a live T-VERSION-2
needs at least 8 trials. Failed, inconclusive, errored, missing or malformed results exit 1, and
each keeps its own classification in the terminal summary and in `report.json`.
A runner that cannot start or report exits 2. A dry-run pass says nothing about
real Google behaviour.

## Layout

| Path | Contents |
|---|---|
| `docs/requirements.md` | Requirements, acceptance evidence, rerun properties |
| `docs/data-contract.md` | File naming, queue order, parsing, field rules, review policy, IDs, output tabs, publication and failure policy |
| `docs/workflow.md` | Workflow traceability: each node mapped to its contract section, requirement and evidence; run states, retries, permissions, rollback |
| `docs/setup.md` | Google, n8n and credential setup for a dedicated test spreadsheet; live test plan |
| `src/sheetops-core.js` | The deterministic core: pure functions, no clock, no randomness, no I/O |
| `workflow/` | `build.js` (the generator), `nodes/` (glue code per Code node), `sheetops.workflow.json` (the importable workflow) |
| `scripts/` | n8n replay check, live-test runner and its result reporting (`live/`), local n8n start script, tab-header helper |
| `scripts/mutation/` | Mutation harness: selected deliberate defects run against the offline tests; see its README |
| `test/` | Offline tests (`node --test`), including the n8n simulator and fake Google in `test/support/` |
| `frontend/` | Read-only operator console on offline demo data; see its README |
| `fixtures/` | Synthetic data and hand-calculated expected outputs; `fixtures/README.md` shows the arithmetic |

## What the tests prove, and what they don't

The offline tests prove that, for the documented inputs, the core:

- produces the hand-calculated results
- accounts for every row
- holds risky changes
- never duplicates IDs on rerun
- builds the publish request in the documented order
- writes `FAILED` only over its own verified `STARTED` row, and never after
  an unknown publish outcome
- refuses a late publish planned from an older state (a version check inside
  every publish), and writes history rows at fixed ranges, so a replayed
  request adds no rows
- never treats an old `STARTED` row as safe because of its age: an
  uncertain publication blocks until a person reprocesses it, after
  inspecting the evidence

The simulator runs the real workflow against a fake Google. The replay shows
that the real n8n engine produces the same node outputs and the same requests.

They do **not** prove:

- that Google applies the publish request atomically and enforces the
  version check (live tests T-ATOM and T-VERSION)
- that the fake Google matches the real APIs in every detail
- anything about live credentials

Those are the live tests in [docs/setup.md](docs/setup.md).
