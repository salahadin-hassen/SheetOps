// The five SheetOps tabs, exactly as the console reads them (contract §10).
// Cells are what the Sheets API returns with UNFORMATTED_VALUE: text, numbers,
// or "" for an empty cell. Nothing here is computed; see src/domain for the
// presentation rules.

export type Cell = string | number | boolean;

export interface CatalogRow {
  sku: string;
  name: string;
  unit: string;
  unit_price: Cell;
  currency: string;
  status: string;
  previous_price: Cell;
  first_seen: string;
  last_seen: string;
  last_changed: string;
  pending_review: string;
  last_issue: string;
}

export interface ReviewRow {
  review_id: string;
  sku: string;
  status: string;
  reasons: string;
  current_name: string;
  current_unit: string;
  current_price: Cell;
  proposed_name: string;
  proposed_unit: string;
  proposed_price: Cell;
  change_pct: Cell;
  first_seen: string;
  last_seen: string;
  source_row: Cell;
  decision: Cell;
  note: Cell;
}

export interface ChangeRow {
  event_id: string;
  batch_id: string;
  effective_date: string;
  sku: string;
  change_type: string;
  disposition: string;
  old_value: Cell;
  new_value: Cell;
  change_pct: Cell;
  review_id: string;
  note: Cell;
}

export interface ExceptionRow {
  exception_id: string;
  batch_id: string;
  source_file: string;
  source_row: Cell;
  sku_raw: Cell;
  severity: string;
  code: string;
  field: string;
  raw_value: Cell;
  message: string;
  action: string;
}

export interface RunLogRow {
  run_id: Cell;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string;
  batch_id: string;
  source_file_id: string;
  source_name: string;
  effective_date: string;
  source_modified_at: string;
  source_created_at: string;
  rows_read: Cell;
  accepted: Cell;
  collapsed: Cell;
  rejected: Cell;
  held_conflict: Cell;
  held_review: Cell;
  blank: Cell;
  changes_applied: Cell;
  reviews_opened: Cell;
  reviews_pending: Cell;
  exceptions: Cell;
  exceptions_new: Cell;
  queue_remaining: Cell;
  error_code: string;
  error_message: string;
}

export interface SheetTabs {
  Catalog: CatalogRow[];
  Review: ReviewRow[];
  Changes: ChangeRow[];
  Exceptions: ExceptionRow[];
  'Run Log': RunLogRow[];
}

/** One read of the spreadsheet: the tabs, and when they were read. */
export interface SheetSnapshot {
  spreadsheetTitle: string;
  /** ISO time the tabs were read. Ages (e.g. of a STARTED row) count from here. */
  checkedAt: string;
  tabs: SheetTabs;
}

/** A demo scenario: a snapshot plus a description of how it was produced. */
export interface DemoScenario extends SheetSnapshot {
  id: string;
  title: string;
  description: string;
}
