import type { CatalogRow, ChangeRow, ReviewRow, SheetSnapshot } from '../types';
import { formatDate, formatPrice } from './format';
import { decisionState } from './review';
import type { Run } from './runs';

// The Catalog tab as the console shows it: committed values only (contract
// §10). Notes under a product are read from the other tabs, never invented:
// a held proposal from Review, this list's applied change from Changes, and
// the last_issue cell as written.

export type CatalogFilter = 'ALL' | 'ACTIVE' | 'DISCONTINUED' | 'AWAITING_REVIEW' | 'ISSUES';

export interface CatalogNote {
  kind: 'proposal' | 'applied' | 'issue';
  text: string;
}

export interface CatalogItem {
  row: CatalogRow;
  notes: CatalogNote[];
}

const STATUS_WORD: Record<string, string> = { ACTIVE: 'Active', DISCONTINUED: 'Discontinued' };
export const statusWord = (status: string): string => STATUS_WORD[status] ?? status;

function proposalNote(review: ReviewRow | undefined, reviewId: string): CatalogNote {
  if (!review) return { kind: 'proposal', text: `Held for review (${reviewId}); the Review row is not in the sheet` };
  const reasons = review.reasons.split(',').map((r) => r.trim());
  const parts: string[] = [];
  if (reasons.includes('NAME_CHANGED')) parts.push(`name “${review.proposed_name}”`);
  if (reasons.includes('UNIT_CHANGED')) parts.push(`unit “${review.proposed_unit}”`);
  // A unit change holds a new price too, with no price reason of its own.
  if (reasons.includes('LARGE_PRICE_CHANGE') || String(review.proposed_price) !== String(review.current_price)) parts.push(formatPrice(review.proposed_price));
  const what = parts.length ? `Proposed ${parts.join(', ')}` : 'Proposed change';
  const state = decisionState(review.decision) === 'APPROVED'
    ? 'approved in the sheet, not applied yet'
    : decisionState(review.decision) === 'INVALID_DECISION' ? 'decision not recognised' : 'awaiting review';
  return { kind: 'proposal', text: `${what} · ${state}` };
}

const APPLIED_NOTE: Record<string, string> = {
  NEW_ITEM: 'New in the {list} list',
  REACTIVATED: 'Reactivated in the {list} list',
  DISCONTINUED: 'Not in the {list} list',
};

export function readCatalog(snapshot: SheetSnapshot, lastCommitted: Run | null): CatalogItem[] {
  const reviews = new Map(snapshot.tabs.Review.map((r) => [r.review_id, r]));
  const latestChanges: ChangeRow[] = lastCommitted
    ? snapshot.tabs.Changes.filter((c) => c.batch_id === lastCommitted.row.batch_id && c.disposition.startsWith('APPLIED'))
    : [];
  return [...snapshot.tabs.Catalog]
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
    .map((row) => {
      const notes: CatalogNote[] = [];
      if (row.pending_review) notes.push(proposalNote(reviews.get(row.pending_review), row.pending_review));
      for (const change of latestChanges.filter((c) => c.sku === row.sku)) {
        const template = APPLIED_NOTE[change.change_type];
        if (template) notes.push({ kind: 'applied', text: template.replace('{list}', formatDate(change.effective_date)) });
      }
      if (row.last_issue) notes.push({ kind: 'issue', text: `Issue in the latest list: ${row.last_issue}` });
      return { row, notes };
    });
}

export function matchesFilter(item: CatalogItem, filter: CatalogFilter): boolean {
  switch (filter) {
    case 'ACTIVE': return item.row.status === 'ACTIVE';
    case 'DISCONTINUED': return item.row.status === 'DISCONTINUED';
    case 'AWAITING_REVIEW': return item.row.pending_review !== '';
    case 'ISSUES': return item.row.last_issue !== '';
    default: return true;
  }
}

/** Case-insensitive match on SKU or product name; blank matches everything. */
export function matchesQuery(sku: string, name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || sku.toLowerCase().includes(q) || name.toLowerCase().includes(q);
}
