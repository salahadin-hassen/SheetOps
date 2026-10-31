import type { CatalogRow, ReviewRow, SheetSnapshot } from '../types';
import { cellText, formatPct, formatPrice, isBlank } from './format';
import type { Tone } from './runs';

// Review items as the console shows them. The operator types decisions into
// the sheet; the console only reads them.

export type DecisionState = 'PENDING' | 'APPROVED' | 'INVALID_DECISION';

/**
 * Contract §10: Review `status` is "derived from decision". This restates the
 * core's decisionState (src/sheetops-core.js): trimmed, case-insensitive;
 * empty is PENDING, APPROVE is APPROVED, anything else is INVALID_DECISION.
 * The console uses it only to show what the decision cell says now; the
 * `status` column is what the last publish wrote.
 */
export function decisionState(decision: ReviewRow['decision']): DecisionState {
  const text = cellText(decision).trim().toUpperCase();
  if (text === '') return 'PENDING';
  if (text === 'APPROVE') return 'APPROVED';
  return 'INVALID_DECISION';
}

export const DECISION_CHIP: Record<DecisionState, { label: string; tone: Tone }> = {
  PENDING: { label: 'Awaiting decision', tone: 'amber' },
  APPROVED: { label: 'Approved · applies on next list', tone: 'blue' },
  INVALID_DECISION: { label: 'Decision not recognised', tone: 'red' },
};

export interface ReviewItem {
  row: ReviewRow;
  /** What the decision cell says now. */
  decision: DecisionState;
  /** True when the decision cell no longer matches the status the last publish wrote. */
  decidedSinceLastPublish: boolean;
  reasons: string[];
  batchId: string;
  catalog: CatalogRow | null;
}

const batchOf = (reviewId: string): string => reviewId.split('|').slice(2).join('|');

export function readReview(snapshot: SheetSnapshot): ReviewItem[] {
  const catalog = new Map(snapshot.tabs.Catalog.map((c) => [c.sku, c]));
  return snapshot.tabs.Review.map((row) => {
    const decision = decisionState(row.decision);
    return {
      row,
      decision,
      decidedSinceLastPublish: decision !== row.status,
      reasons: row.reasons.split(',').map((r) => r.trim()).filter(Boolean),
      batchId: batchOf(row.review_id),
      catalog: catalog.get(row.sku) ?? null,
    };
  });
}

export const REASON_TEXT: Record<string, string> = {
  LARGE_PRICE_CHANGE: 'price change of 25% or more',
  UNIT_CHANGED: 'unit change',
  NAME_CHANGED: 'name change',
};

/** The short headline for the list, e.g. "Price +40.0%" or "Unit pack → box". */
export function headline(item: ReviewItem): string {
  const r = item.row;
  if (item.reasons.includes('LARGE_PRICE_CHANGE')) return `Price ${formatPct(r.change_pct)}`;
  if (item.reasons.includes('UNIT_CHANGED')) return `Unit ${r.current_unit} → ${r.proposed_unit}`;
  if (item.reasons.includes('NAME_CHANGED')) return 'Name change';
  return item.reasons.join(', ') || 'Held';
}

export interface Comparison {
  field: string;
  current: string;
  proposed: string;
  difference: string;
  changed: boolean;
}

export function compare(item: ReviewItem): Comparison[] {
  const r = item.row;
  const priceChanged = !isBlank(r.change_pct) || cellText(r.current_price) !== cellText(r.proposed_price);
  const diff = (Number(r.proposed_price) - Number(r.current_price));
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return [
    { field: 'Name', current: r.current_name, proposed: r.proposed_name, changed: r.current_name !== r.proposed_name,
      difference: r.current_name !== r.proposed_name ? 'Changed' : 'Unchanged' },
    { field: 'Unit', current: r.current_unit, proposed: r.proposed_unit, changed: r.current_unit !== r.proposed_unit,
      difference: r.current_unit !== r.proposed_unit ? 'Changed' : 'Unchanged' },
    { field: 'Price (ETB)', current: formatPrice(r.current_price), proposed: formatPrice(r.proposed_price), changed: priceChanged,
      difference: priceChanged
        ? `${sign}${formatPrice(Math.abs(diff))}${isBlank(r.change_pct) ? '' : ` (${formatPct(r.change_pct)})`}`
        : 'Unchanged' },
  ];
}
