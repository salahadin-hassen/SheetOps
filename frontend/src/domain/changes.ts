import type { ChangeRow, SheetSnapshot } from '../types';
import { decisionState } from './review';
import type { Run, Tone } from './runs';

// The Changes tab (contract §10): append-only, one row per recorded change.
// A row exists only if the publish that wrote it was committed. Rejected
// source rows are not changes; they are in the Exceptions tab.

export const DISPOSITION: Record<string, { label: string; tone: Tone; meaning: string }> = {
  APPLIED: { label: 'Applied', tone: 'green', meaning: 'in the catalog since that run was published' },
  APPLIED_AFTER_REVIEW: { label: 'Applied after review', tone: 'blue', meaning: 'applied once a person approved it' },
  HELD_FOR_REVIEW: { label: 'Held for review', tone: 'amber', meaning: 'recorded, not in the catalog' },
  NOT_APPLIED: { label: 'Superseded', tone: 'neutral', meaning: 'closed without being applied' },
};

export const DISPOSITION_ORDER = ['APPLIED', 'APPLIED_AFTER_REVIEW', 'HELD_FOR_REVIEW', 'NOT_APPLIED'] as const;

export interface ChangeBatch {
  batchId: string;
  effectiveDate: string;
  rows: ChangeRow[];
  /** The committed run that published these rows. */
  run: Run | null;
}

/** Changes grouped by batch, newest list first; rows keep the tab's order. */
export function changeBatches(snapshot: SheetSnapshot, runs: Run[]): ChangeBatch[] {
  const order: string[] = [];
  const groups = new Map<string, ChangeRow[]>();
  for (const row of snapshot.tabs.Changes) {
    if (!groups.has(row.batch_id)) { groups.set(row.batch_id, []); order.push(row.batch_id); }
    groups.get(row.batch_id)!.push(row);
  }
  return order
    .map((batchId) => {
      const rows = groups.get(batchId)!;
      return { batchId, effectiveDate: rows[0].effective_date, rows, run: runs.find((r) => r.committed && r.row.batch_id === batchId) ?? null };
    })
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0));
}

export function dispositionCounts(rows: ChangeRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;
  return counts;
}

/** Where a held change stands now, read from the Review tab. */
export function heldStatus(row: ChangeRow, snapshot: SheetSnapshot): string {
  const review = snapshot.tabs.Review.find((r) => r.review_id === row.review_id);
  if (!review) return 'No longer in the Review tab. Later rows in this history show what happened to it.';
  switch (decisionState(review.decision)) {
    case 'APPROVED':
      return 'Approved in the Review tab, not applied yet. When a published run applies it, a new row is added here as Applied after review; this row is never edited.';
    case 'INVALID_DECISION':
      return 'In the Review tab with a decision that is not recognised (only APPROVE is). It stays held.';
    default:
      return 'Awaiting a decision in the Review tab. The catalog keeps its current value. When it is applied, a new row is added here as Applied after review; this row is never edited.';
  }
}
