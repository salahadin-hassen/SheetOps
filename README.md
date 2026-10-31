# SheetOps

Supplier price-list reconciliation for Google Sheets. Each week a supplier's
CSV price list lands in a Google Drive folder. SheetOps validates it, compares
it with the current catalog, applies safe changes, holds risky ones for a
person to approve, and publishes five tabs to one spreadsheet: Catalog,
Review, Changes, Exceptions and Run Log. n8n runs the workflow; the processing
logic is one dependency-free JavaScript file.

## Status

- **M1 (offline core): complete.**
- **M2 (n8n workflow): built and verified without Google.**
  - The workflow is generated from the core.
  - It runs end to end in a simulator against a fake Google.
  - Its scenarios replay node for node in the real n8n 2.41.7 engine.
  - Live tests on a real spreadsheet are next; they need the setup in
    [docs/setup.md](docs/setup.md).
- **M3 (failure drills, handover documentation): not started.**

Nothing in this repository has run against a real spreadsheet yet.

## Run the tests

Requires Node.js 22 or later (developed on v24.21.0). There is nothing to install.

```
npm test                 # offline tests, about 5 seconds, no network
npm run build:workflow   # regenerate workflow/sheetops.workflow.json after changes
npm run verify:n8n       # replay 14 scenarios in the local n8n (about 2 minutes, no network)
node scripts/live/run-live-tests.js all --dry-run   # the live suite against the fake Google
```

The tests use no network, no Google account and no paid services.

## Layout

| Path | Contents |
|---|---|
| `docs/requirements.md` | Requirements, acceptance evidence, rerun properties |
| `docs/data-contract.md` | File naming, queue order, parsing, field rules, review policy, IDs, output tabs, publication and failure policy |
| `docs/workflow.md` | Workflow traceability: each node mapped to its contract section, requirement and evidence; run states, retries, permissions, rollback |
| `docs/setup.md` | Google, n8n and credential setup for a dedicated test spreadsheet; live test plan |
| `src/sheetops-core.js` | The deterministic core: pure functions, no clock, no randomness, no I/O |
| `workflow/` | `build.js` (the generator), `nodes/` (glue code per Code node), `sheetops.workflow.json` (the importable workflow) |
| `scripts/` | n8n replay check, local n8n start script, tab-header helper |
| `test/` | Offline tests (`node --test`), including the n8n simulator and fake Google in `test/support/` |
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
