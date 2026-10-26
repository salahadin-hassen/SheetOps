# Fixtures

All data here is synthetic. `demo-supplier` is a made-up supplier, and the
Drive file IDs (`drv-week2`) are invented.

The expected outputs were written by hand from the rules in
`docs/data-contract.md` **before** the core was implemented. They are never
regenerated from the core's own output. If a test fails, the first question is
whether the code or the hand calculation is wrong, and the answer is recorded.

## week2/

| File | Role |
|---|---|
| `catalog_before.json` | Catalog tab before the run: 11 SKUs, 10 ACTIVE, LNT-003 DISCONTINUED |
| `demo-supplier_2026-10-19.csv` | The supplier's file: 19 data records (rows 2–20), with aliased headers |
| `input.json` | Config, Drive metadata and run information for the run |
| `expected/*.json` | Hand-calculated results |

Batch ID: `drv-week2@2026-10-19T06:00:00.000Z` (written `B` below).

### Row outcomes

| Row | Content | Outcome | Reason |
|---|---|---|---|
| 2 | ` flr-001 `, KG, 95.00 | ACCEPTED | trims and uppercases to FLR-001; equal to catalog |
| 3 | FLR-002, 75.50 | ACCEPTED | PRICE_CHANGED 70.00 → 75.50, below 25% |
| 4 | OIL-010, `pcs`, `"1,520.00"` | ACCEPTED | pcs → each; PRICE_CHANGED 1450.00 → 1520.00 |
| 5 | SUG-001, `"12,5"` | REJECTED | AMBIGUOUS_PRICE |
| 6 | COF-100, `"Coffee beans"` | ACCEPTED | equal to catalog |
| 7 | COF-100, `Coffee  beans` | COLLAPSED | identical to row 6 after whitespace collapse |
| 8, 9 | SPC-020 at 600.00 and 650.00 | HELD_CONFLICT | CONFLICTING_DUPLICATE |
| 10 | TEA-001, unit box | HELD_REVIEW | UNIT_CHANGED pack → box |
| 11 | LNT-003, 140.00 | ACCEPTED | REACTIVATED, values equal |
| 12 | HNY-001 | ACCEPTED | NEW_ITEM |
| 13 | blank SKU | REJECTED | MISSING_SKU |
| 14 | OIL-011, -300.00 | REJECTED | INVALID_PRICE |
| 15 | MLK-001, USD | REJECTED | CURRENCY_MISMATCH |
| 16 | `,,,,` | BLANK | |
| 17 | `SLT-9!!` | REJECTED | INVALID_SKU |
| 18 | EGG-030, 420.00 | HELD_REVIEW | LARGE_PRICE_CHANGE |
| 19 | BTR-002, Margarine | HELD_REVIEW | NAME_CHANGED |
| 20 | SUG-001, 115.00 | HELD_CONFLICT | SIBLING_ROW_INVALID (row 5 rejected) |

Row accounting: 6 accepted (2, 3, 4, 6, 11, 12) + 1 collapsed (7) + 5 rejected
(5, 13, 14, 15, 17) + 3 held for conflict (8, 9, 20) + 3 held for review
(10, 18, 19) + 1 blank (16) = 19 records.

### Arithmetic (integer cents)

| SKU | Old | New | abs(diff) × 100 vs 25 × old | Review? | Tenths: floor((2·diff·1000 + old) / (2·old)) | % |
|---|---|---|---|---|---|---|
| FLR-002 | 7000 | 7550 | 55,000 < 175,000 | no | floor(1,107,000 / 14,000) = 79 | 7.9 |
| OIL-010 | 145000 | 152000 | 700,000 < 3,625,000 | no | floor(14,145,000 / 290,000) = 48 | 4.8 |
| EGG-030 | 30000 | 42000 | 1,200,000 ≥ 750,000 | **yes** | floor(24,030,000 / 60,000) = 400 | 40.0 |

### Disappearance check

Denominator: 10 ACTIVE SKUs before the run (all except LNT-003).
Present in the file: every catalog SKU except RCE-005 (SUG-001 and SPC-020 are
present even though not accepted). Numerator: 1. Check: 1 × 100 = 100, not
greater than 30 × 10 = 300, so no halt.

### Totals

- Changes: 5 APPLIED (FLR-002, OIL-010, LNT-003, HNY-001, RCE-005) + 3
  HELD_FOR_REVIEW (TEA-001, EGG-030, BTR-002) = 8 rows.
- Exceptions: 5 ERROR (rows 5, 13, 14, 15, 17) + 3 REVIEW (8, 9, 20) + 1 INFO
  (7) = 9 rows.
- Review: 3 PENDING items.
- Catalog: 12 rows (11 + HNY-001); 11 ACTIVE, RCE-005 DISCONTINUED.
- Status: SUCCESS_WITH_EXCEPTIONS.

### Scenarios derived from week 2 (expected values in the tests)

| Scenario | State before | Expected |
|---|---|---|
| Rerun, same batch | expected after-state | identical catalog and review; 0 new Changes or Exceptions rows; same outcome counts |
| Same content as a new batch dated 2026-10-26 | expected after-state | 0 new Changes rows; same 3 review IDs with `last_seen` 2026-10-26; 9 new Exceptions rows (new batch, so new IDs) |
| APPROVE on TEA-001, reprocess | after-state + decision | TEA-001 ACCEPTED, unit box; 1 Changes row APPLIED_AFTER_REVIEW with the note; 2 items left |
| Truncated file (rows 2–6 only) | catalog_before | 5 of 10 ACTIVE absent = 50% → HALTED_REVIEW; only an Exceptions row and the run row |

## parser/

`quoting.csv` exercises RFC 4180 quoting. `quoting.expected.json` is the
hand-written parse result: logical record numbers, starting physical lines and
field values. Record 4 spans lines 4–5 because of a quoted line break, so
record 5 starts on line 6. Record 6 has an unquoted comma in its name, so it
has 5 fields against a 4-field header and must be rejected
(`FIELD_COUNT_MISMATCH`), never shifted.
