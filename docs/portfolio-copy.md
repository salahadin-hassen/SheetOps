# SheetOps: portfolio copy (drafts)

Drafts for the owner to edit. Nothing here has been published. Every claim
matches `docs/case-study.md`; keep them in step if either changes.

## GitHub profile or portfolio paragraph

SheetOps automates a recurring business chore: turning a supplier's weekly CSV
price list into an up-to-date product catalog in Google Sheets. It validates
every row, applies safe changes, holds risky ones (such as a 40% price jump)
for a person to approve, and keeps an append-only record of what changed and
why. It also refuses to guess: when a Google update times out, the run is
reported as "outcome unknown" rather than "failed", and later updates wait
until someone checks. The business rules live in one dependency-free
JavaScript module, orchestrated by n8n and covered by 252 offline tests. A
replay in the real n8n engine matches all 16 recorded scenarios, using recorded
responses. Nothing has been verified against live Google yet, and it is not
production-ready; all data is synthetic.

## Upwork portfolio entry

**Title:** Safe supplier price-list automation: n8n + Google Sheets

**Overview:**
A weekly supplier CSV lands in Google Drive. SheetOps checks it and updates a
Google Sheets catalog without letting bad data through:

- Invalid rows (missing SKU, negative price, wrong currency, ambiguous
  "12,5") are recorded, never applied.
- Price changes of 25% or more, unit changes and name changes wait for a
  person to approve in the sheet.
- A truncated file can't wipe the catalog: if more than 30% of products are
  missing, the run stops.
- An old file can't overwrite newer prices.
- Every run is logged, and an uncertain update is reported as uncertain, not
  as failed.

**Built with:** n8n, Google Sheets and Drive APIs, JavaScript (Node.js).

**Evidence:** 252 offline tests; 16/16 scenarios replayed in n8n 2.41.7 with
recorded Google responses. Live Google tests are planned, not yet run.
Includes a read-only operator console (169 tests) on offline demo data; it is
not connected to Google.

## Demonstration script (about 2½ minutes)

> **[Screen: the supplier CSV]** Every week this supplier sends a price list.
> This one has 19 rows, and some of them are wrong. There's a blank SKU, a
> negative price, a price in dollars, two different prices for the same spice,
> and a sugar price written "12,5". Nobody can tell whether that's twelve fifty
> or a hundred and twenty-five.
>
> **[Screen: fixtures/README.md]** Before writing any code, I worked out by
> hand what should happen to every row. Six accepted, five rejected, three
> held for review, three held because rows for the same product disagree, one
> exact duplicate and one blank. All 19 are accounted for.
>
> **[Screen: terminal, npm test]** The tests check the code against that hand
> calculation, plus the dangerous cases. 252 tests, no network, about
> fifteen seconds.
>
> **[Screen: v16-02 Review]** Eggs went from 300 to 420. That's 40%, so it
> isn't applied; it waits for a person. Wheat flour went up 7.9%, which is
> normal, so that one is applied.
>
> **[Screen: v16-04 Approved]** Approving doesn't change the catalog
> immediately. It's a recorded decision, shown in blue rather than green. The
> price changes when a list that still says 420 is processed.
>
> **[Screen: v16-08 Audit trail]** And the history shows the whole story:
> held, approved with a note, then applied.
>
> **[Screen: v16-01 Overview]** Now the hard case. The update to Google timed
> out. Did it land or not? Most automations would retry or mark it failed, and
> both can corrupt data. SheetOps marks it "unknown", writes nothing, blocks
> later updates and asks a person to check.
>
> **[Screen: v16-06 Unknown outcome]** There is deliberately no retry button,
> just the steps to establish what actually happened.
>
> **[Screen: terminal, npm run verify:n8n]** The same scenarios run in the real
> n8n engine with recorded responses: 16 out of 16 match.
>
> **[Closing]** What's left is testing against a live Google spreadsheet. That
> includes checking how Google handles two updates arriving at once, which
> Google doesn't document. Until then, I describe this as tested offline, not
> live.

## Strongest screenshots

All are in `docs/case-study-assets/`, rendered from the published version-16
design files.

| Screenshot | What it proves |
|---|---|
| `v16-02-review-held-change.png` | Risky changes are explained and held; current versus proposed is unambiguous |
| `v16-04-approved-not-committed.png` | Approval is a decision, not a change: the catalog still shows 300.00 |
| `v16-01-overview-outcome-unknown.png` | Uncertainty is reported honestly, with the next action first |
| `v16-06-unknown-outcome-no-retry.png` | No blind retry; editing is paused with a stated reason |
| `v16-08-audit-trail.png` | Every change is traceable from file to catalog |
| `v16-05-run-investigation.png` | Spreadsheet evidence and n8n evidence are kept separate |

Terminal captures of `npm test` and `npm run verify:n8n` would add credible
engineering evidence. They are not included yet; see the case study's open
items.
