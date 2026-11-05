import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import catalogBefore from '../../../fixtures/week2/catalog_before.json';
import catalogAfter from '../../../fixtures/week2/expected/catalog_after.json';
import changesNew from '../../../fixtures/week2/expected/changes_new.json';
import { scenario } from '../test/fixtures';

async function open(hash: string) {
  window.location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  return screen.findByRole('heading', { level: 1 });
}

const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const rowFor = (sku: string) => screen.getByRole('rowheader', { name: sku }).closest('tr')!;

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('demo data comes from the repository fixtures', () => {
  it('the starting catalog is fixtures/week2/catalog_before.json, unchanged', () => {
    expect(scenario('before-first-run').tabs.Catalog).toEqual(catalogBefore);
  });
  it('after run 1001 the catalog and changes equal the fixture expected outputs', () => {
    expect(scenario('week2-published').tabs.Catalog).toEqual(catalogAfter);
    expect(scenario('week2-published').tabs.Changes).toEqual(changesNew);
  });
});

describe('Catalog', () => {
  it('shows the 11 starting products before any run, with no invented notes', async () => {
    await open('#/catalog?view=before-first-run');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('11 products');
    expect(text(screen.getByRole('main'))).toContain('Starting catalog: no SheetOps run has published yet');
    expect(bodyRows()).toHaveLength(11);
    expect(document.querySelectorAll('.cell-note')).toHaveLength(0);
  });

  it('filter tabs count the committed catalog after run 1001', async () => {
    await open('#/catalog?view=week2-published');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All · 12', 'Active · 11', 'Discontinued · 1', 'Awaiting review · 3', 'Issues · 2',
    ]);
    fireEvent.click(tab(/^Discontinued/));
    expect(bodyRows().map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['RCE-005']);
    fireEvent.click(tab(/^Awaiting review/));
    expect(bodyRows().map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['BTR-002', 'EGG-030', 'TEA-001']);
    fireEvent.click(tab(/^Issues/));
    expect(bodyRows().map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['SPC-020', 'SUG-001']);
  });

  it('searches by SKU and by product name, case-insensitively', async () => {
    await open('#/catalog?view=week2-published');
    const search = screen.getByRole('searchbox', { name: 'Find a product' });
    fireEvent.change(search, { target: { value: 'flr' } });
    expect(bodyRows().map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['FLR-001', 'FLR-002']);
    fireEvent.change(search, { target: { value: 'BLACK TEA' } });
    expect(bodyRows().map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['TEA-001']);
    expect(screen.getByRole('status').textContent).toBe('Showing 1 of 12 products');
    fireEvent.change(search, { target: { value: 'no such product' } });
    expect(text(screen.getByRole('main'))).toContain('No products match');
  });

  it('formats prices, previous price, status and dates', async () => {
    await open('#/catalog?view=week2-published');
    expect(screen.getByRole('columnheader', { name: 'Price (ETB)' })).toBeTruthy();
    const oil = rowFor('OIL-010');
    expect(text(oil)).toContain('1,520.00');
    expect(text(oil)).toContain('1,450.00');
    expect(text(oil)).toContain('19 Oct 2026');
    const rice = rowFor('RCE-005');
    expect(text(rice)).toContain('Discontinued');
    expect(text(rice)).toContain('Not in the 19 Oct 2026 list');
    expect(text(rice)).toContain('12 Oct 2026');
  });

  it('shows held proposals as notes and keeps the committed price', async () => {
    await open('#/catalog?view=week2-published');
    const egg = rowFor('EGG-030');
    // The committed price and the proposal are separate elements, and only the
    // committed one is the price.
    const priceCell = within(egg).getAllByRole('cell')[2];
    expect(priceCell.querySelector('.price-committed')!.textContent).toBe('300.00');
    expect(priceCell.querySelector('.proposed')!.textContent).toBe('Proposed 420.00 · awaiting review');
    expect(priceCell.querySelector('.price-committed')!.contains(priceCell.querySelector('.proposed'))).toBe(false);
    expect(text(rowFor('BTR-002'))).toContain('Proposed name “Margarine” · awaiting review');
    expect(text(rowFor('HNY-001'))).toContain('New in the 19 Oct 2026 list');
    expect(text(rowFor('SUG-001'))).toContain('Issue in the latest list: AMBIGUOUS_PRICE (row 5); SIBLING_ROW_INVALID (row 20)');
  });

  it('after REVIEW_CHANGED, the approval is shown as not applied and the unit is still pack', async () => {
    await open('#/catalog?view=review-changed');
    const tea = rowFor('TEA-001');
    expect(text(tea)).toContain('Proposed unit “box” · approved in the sheet, not applied yet');
    expect(within(tea).getAllByRole('cell')[1].textContent).toBe('pack');
  });

  it('keeps the wide table inside a scrollable, focusable region', async () => {
    await open('#/catalog?view=week2-published');
    const region = screen.getByRole('region', { name: /Catalog, 12 of 12 products \(table, scrolls sideways\)/ });
    expect(region.getAttribute('tabindex')).toBe('0');
  });
});

describe('Change history', () => {
  it('lists the 8 changes of the 19 Oct list with applied and held kept apart', async () => {
    await open('#/changes?view=week2-published');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All · 8', 'Applied · 5', 'Held for review · 3']);
    expect(screen.getByRole('heading', { level: 2, name: '19 Oct 2026 list · run 1001' })).toBeTruthy();
    const dispositions = bodyRows().filter((r) => !r.classList.contains('detail-row'))
      .map((r) => [within(r).getByRole('rowheader').textContent, within(r).getAllByRole('cell')[2].textContent]);
    expect(dispositions).toEqual([
      ['BTR-002', 'Held for review'], ['EGG-030', 'Held for review'], ['FLR-002', 'Applied'], ['HNY-001', 'Applied'],
      ['LNT-003', 'Applied'], ['OIL-010', 'Applied'], ['RCE-005', 'Applied'], ['TEA-001', 'Held for review'],
    ]);
    expect(text(screen.getByRole('main'))).toContain('8 rows: 5 applied, 3 held for review.');
  });

  it('filters by disposition and by SKU or product', async () => {
    await open('#/changes?view=week2-published');
    fireEvent.click(tab(/^Held for review/));
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['BTR-002', 'EGG-030', 'TEA-001']);
    fireEvent.click(tab(/^All/));
    fireEvent.change(screen.getByRole('searchbox', { name: 'SKU or product' }), { target: { value: 'sunflower' } });
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['OIL-010']);
    expect(screen.getByRole('status').textContent).toBe('Showing 1 of 8 changes');
  });

  it('shows event ID, review ID, note and where a held change is now', async () => {
    await open('#/changes?view=week2-published');
    const toggle = within(rowFor('EGG-030')).getByRole('button', { name: /Details for EGG-030/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rowFor('EGG-030').nextElementSibling?.classList.contains('detail-row')).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(detail).toBe(rowFor('EGG-030').nextElementSibling);
    const pairs = Object.fromEntries([...detail.querySelectorAll('dt')].map((dt) => [dt.textContent, text(dt.nextElementSibling as HTMLElement)]));
    expect(pairs['Event ID']).toBe('RV|EGG-030|drv-week2@2026-10-19T06:00:00.000Z|PRICE_CHANGED|HELD');
    expect(pairs['Review ID']).toBe('RV|EGG-030|drv-week2@2026-10-19T06:00:00.000Z');
    expect(pairs['Effective date']).toBe('19 Oct 2026');
    expect(pairs['Note']).toBe('None');
    expect(pairs['Where it is now']).toMatch(/^Awaiting a decision in the Review tab\. .* Open in Review$/);
    expect(text(rowFor('EGG-030'))).toContain('+40.0%');
    expect(text(rowFor('HNY-001'))).toContain('Honey · kg · 480.00');
  });

  it('after REVIEW_CHANGED, adds no row and describes TEA-001 as approved but not applied', async () => {
    await open('#/changes?view=review-changed');
    expect(screen.getAllByRole('tab')[0].textContent).toBe('All · 8');
    expect(screen.queryByText('Applied after review', { selector: 'td *' })).toBeNull();
    fireEvent.click(within(rowFor('TEA-001')).getByRole('button', { name: /Details for TEA-001/ }));
    const detail = rowFor('TEA-001').nextElementSibling as HTMLElement;
    expect(text(detail)).toContain('Approved in the Review tab, not applied yet');
  });

  it('is an honest empty state when no run has published', async () => {
    await open('#/changes?view=before-first-run');
    expect(text(screen.getByRole('main'))).toContain('No changes recorded yet');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('points rejected source rows to Exceptions instead of listing them as changes', async () => {
    await open('#/changes?view=week2-published');
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Exceptions' })).toBeTruthy();
  });
});

describe('navigation', () => {
  it('links Catalog and Change history and marks the current one', async () => {
    await open('#/changes?view=week2-published');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Change history' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Catalog' }).getAttribute('href')).toBe('#/catalog?view=week2-published');
  });
});
