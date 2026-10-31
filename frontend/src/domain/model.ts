import type { ChangeRow, SheetSnapshot } from '../types';
import { exceptionBatches, type ExceptionBatch } from './exceptions';
import { formatPct, formatPrice, isBlank } from './format';
import { publishingState, readRuns, type PublishingState, type Run } from './runs';
import { readReview, type ReviewItem } from './review';

/** Everything the screens show, read once from a snapshot. */
export interface ConsoleModel {
  snapshot: SheetSnapshot;
  runs: Run[];
  latest: Run | null;
  lastCommitted: Run | null;
  publishing: PublishingState;
  review: ReviewItem[];
  exceptionBatches: ExceptionBatch[];
}

export function buildModel(snapshot: SheetSnapshot): ConsoleModel {
  const runs = readRuns(snapshot);
  return {
    snapshot,
    runs,
    latest: runs[0] ?? null,
    lastCommitted: runs.find((r) => r.committed) ?? null,
    publishing: publishingState(runs),
    review: readReview(snapshot),
    exceptionBatches: exceptionBatches(snapshot.tabs.Exceptions, runs),
  };
}

// ---------------------------------------------------------------------------
// Change history wording (contract §10).

export const CHANGE_TYPE: Record<string, string> = {
  NEW_ITEM: 'New item',
  REACTIVATED: 'Reactivated',
  PRICE_CHANGED: 'Price',
  UNIT_CHANGED: 'Unit',
  NAME_CHANGED: 'Name',
  DISCONTINUED: 'Discontinued (absent from list)',
  REVIEW_SUPERSEDED: 'Review superseded',
};

const STATUS_WORD: Record<string, string> = { ACTIVE: 'Active', DISCONTINUED: 'Discontinued' };

export function changeValue(row: ChangeRow, which: 'old_value' | 'new_value'): string {
  const value = row[which];
  if (isBlank(value)) return '—';
  if (row.change_type === 'PRICE_CHANGED') return formatPrice(value);
  if (row.change_type === 'NEW_ITEM') return String(value).split(' | ').join(' · ');
  return STATUS_WORD[String(value)] ?? String(value);
}

export const changePct = (row: ChangeRow): string => (isBlank(row.change_pct) ? '—' : formatPct(row.change_pct));

export const APPLIED = new Set(['APPLIED', 'APPLIED_AFTER_REVIEW']);
