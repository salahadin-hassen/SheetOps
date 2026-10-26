# SheetOps

Supplier price-list reconciliation for Google Sheets. Each week a supplier's
CSV price list lands in a Google Drive folder. SheetOps validates it, compares
it with the current catalog, applies safe changes, holds risky ones for a
person to approve, and publishes five tabs to one spreadsheet: Catalog,
Review, Changes, Exceptions and Run Log. n8n runs the workflow; the processing
logic is one dependency-free JavaScript file.

## Status

**Milestone 1 (offline core) is complete.** Not built yet:

- the n8n workflow (M2)
- the Google Drive and Sheets integration (M2)
- live tests on a spreadsheet (M2)
- failure drills and handover documentation (M3)

Nothing in this repository has run against a real spreadsheet.

## Run the tests

Requires Node.js 22 or later (developed on v24.21.0). There is nothing to install.

```
npm test
```

The tests use no network, no Google account and no paid services.

## Layout

| Path | Contents |
|---|---|
| `docs/requirements.md` | Requirements, acceptance evidence, rerun properties |
| `docs/data-contract.md` | File naming, queue order, parsing, field rules, review policy, IDs, output tabs, publication and failure policy |
| `src/sheetops-core.js` | The deterministic core: pure functions, no clock, no randomness, no I/O |
| `test/` | Offline tests (`node --test`) |
| `fixtures/` | Synthetic data and hand-calculated expected outputs; `fixtures/README.md` shows the arithmetic |

## What the offline tests prove, and what they don't

They prove that, for the documented inputs, the core:

- produces the hand-calculated results
- accounts for every row
- holds risky changes
- never duplicates IDs on rerun
- builds the publish request in the documented order

They do **not** prove that Google applies that request atomically, that the
n8n Code node runs the core unchanged, or anything about live credentials.
Those are M2 tests.
