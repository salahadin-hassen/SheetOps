# SheetOps operator console (frontend, milestone 1)

A read-only web console for SheetOps. This milestone runs entirely offline on
synthetic demo data. It is not connected to Google and is not production-ready.

## Scope expansion

Version one of SheetOps excludes "any frontend" (`docs/requirements.md`,
out-of-scope list). That scope is unchanged: v1 is the n8n workflow, the
deterministic core and the Google Sheet. This console is a **deliberate scope
expansion for the next development phase**, started on 30 October 2026. It
lives only in `frontend/` and changes nothing in the core, the workflow, the
tests or the fixtures.

## Run it

Needs Node 22 or later. From `frontend/`:

```bash
npm install --ignore-scripts   # React, Vite, TypeScript, Vitest; no install scripts needed
npm run dev                    # http://127.0.0.1:5173
npm test                       # unit and screen tests (Vitest + jsdom)
npm run build                  # type-checks, then writes static files to dist/
npm run preview                # serves dist/ on http://127.0.0.1:4173
npm run data                   # regenerate src/data/demo-data.json
npm run data:check             # fail if demo-data.json is stale
```

Each screen has its own link, for example
`#/runs/1002?view=review-changed`. The scenario picker at the top switches
between demo scenarios.

## Where the data comes from

`scripts/generate-demo-data.cjs` runs the real generated n8n workflow
(`workflow/build.js`) with the real core (`src/sheetops-core.js`) in the offline
n8n simulator against the fake Google (`test/support/`), on the synthetic week-2
fixture. It saves the five tabs exactly as the workflow leaves them. Nothing in
`demo-data.json` is written by hand.

| Scenario | What happened |
|---|---|
| `before-first-run` | The starting catalog; no run yet |
| `week2-published` | Run 1001 published: 5 changes applied, 3 held, 9 exceptions |
| `review-changed` | TEA-001 approved in the sheet during manual reprocess 1002; the final Review check stopped the publish: **FAILED, REVIEW_CHANGED** |
| `review-during-run` | After 1001, manual reprocess 1002's publish got no answer; read 3 minutes later (STARTED) |
| `publish-refused` | Google refused run 1001's publish (HTTP 403): FAILED, PUBLISH_REJECTED |
| `run-started` | Run 1001's publish got no answer; read 3 minutes later |
| `outcome-unknown` | The same, read 21 minutes later: an unresolved publication |

The console reads only what a spreadsheet read returns: the five tabs and the
time of the read. It never sees n8n, and says so where that matters.

## Architecture

- **React 19 + Vite + TypeScript.** The screens are many small stateful views of
  the same typed data (filters, selection, scenario switching); React keeps them
  as reusable components with typed props. Vite builds a static bundle with no
  server; TypeScript types the five tab schemas. Runtime dependencies are React,
  React DOM and two self-hosted font packages (Public Sans, IBM Plex Mono). There
  is no router library (a 50-line hash router), no CSS framework and no state
  library. The production bundle is about 320 KB of JavaScript (88 KB gzipped).
- `src/types.ts`: the five tabs, column by column (contract §10).
- `src/data/source.ts`: the `SheetSource` interface, and `DemoSource`, its only
  implementation. A future live source must run behind a server the operator
  controls, which holds the Google credential and returns a `SheetSnapshot`.
  The browser never holds a credential and never calls Google.
- `src/domain/`: presentation rules (status labels, the stage track, the
  15-minute window, explanations, review decision state). Each rule restates the
  data contract; the console decides nothing the workflow has not decided.
  `decisionState` mirrors the core's rule (contract §10). It is used only to show
  what a decision cell says now, next to the `status` the last publish wrote.
- `src/components/`: AppShell, StatusPill, Banner, Panel, Tile,
  DefinitionList, EmptyState, LedgerTable, StageTrack, Tabs, PageHead,
  RunBanner.
- `src/pages/`: Overview, Runs and Run details, Review, Exceptions.
- `src/styles/tokens.css`: the design tokens from the design canvas
  (version 19, "Triage"). Components use token names only.

## Security

- No credential, key, token or `.env` file is in `frontend/`, and none is
  needed. The Google service-account key stays outside the repository. Nothing
  here reads it.
- No `import.meta.env` or `VITE_*` variables. The browser code makes no network
  requests (no `fetch`, XHR or WebSocket). `src/security.test.ts` enforces both.
- No backend and no OAuth in this milestone.

## Review behaviour shown

- **Read-only.** Every Review screen says decisions are typed in the Google
  Sheet. There are no inputs or decision buttons.
- **During a STARTED run** the console says not to edit Review in the sheet,
  and that the console has no controls to pause; **the Google Sheet itself is
  not locked**.
- **REVIEW_CHANGED** shows:
  - the run as **Failed**;
  - the Publish stage as **Not sent**;
  - the operator's APPROVE kept in the sheet, and **not applied** (the status
    column still says PENDING; the catalog keeps unit pack);
  - **no retry button**: the console cannot start a run.

## Differences from the version-19 design

- **Fewer screens.** Incoming files, Catalog and Change history are not built;
  the Overview has catalog and recent-change summaries instead. The nav shows
  only built screens.
- **No approval dialog.** Review is read-only, with no Approve button or note
  field. The design's "decisions are locked" wording becomes "do not edit
  Review in the sheet"; the console has nothing to lock.
- **No "Next scheduled run" tile.** The sheet does not record the schedule.
- **A demo notice and scenario picker** replace the design's "Illustrative
  scenario" chip.
- **Real data, not illustrative.** Run numbers and times come from the
  generated data (run 1002 at 12:00 EAT), not the design's run 1004.
- **Darker dashed border.** The "Not in the sheet" dashed border is `#7B8594`
  (design `#9CA3AF`, 2.5:1 on white), for 3:1 non-text contrast.
- **Approved items are counted by the decision cell.** On Review, an APPROVE
  typed after the last publish counts under "Approved", with a note that the
  status column still says PENDING.

## Known limitations

- Demo data only; the live data source and its server do not exist yet.
- jsdom tests do not check layout. Layout, contrast of rendered text, overflow
  and keyboard order were checked in headless Chrome at 320, 375, 768 and
  1280 px. No screen-reader pass has been done on this build.
- Focus moves to the page title after navigation, not on first load.
