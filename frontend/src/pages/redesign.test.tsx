import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';

async function open(hash: string) {
  window.location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  return screen.findByRole('heading', { level: 1 });
}
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('catalog product drawer', () => {
  it('opens from the SKU, separates committed values from the held proposal, and returns focus on Escape', async () => {
    await open('#/catalog?view=week2-published');
    const sku = screen.getByRole('button', { name: 'EGG-030' });
    expect(sku.getAttribute('aria-haspopup')).toBe('dialog');
    sku.focus();
    fireEvent.click(sku);
    const dialog = screen.getByRole('dialog', { name: 'Eggs (tray of 30)' });
    const committed = within(dialog).getByRole('region', { name: 'Committed in the catalog' });
    expect(text(committed)).toContain('300.00');
    expect(text(committed)).not.toContain('420.00');
    const held = within(dialog).getByRole('region', { name: 'Held for review' });
    expect(text(held)).toContain('Awaiting decision');
    expect(text(held)).toContain('420.00 (+40.0%)');
    expect(text(held)).toContain('Not applied');
    expect(text(within(dialog).getByRole('region', { name: 'Change history' }))).toContain('Held for review');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Eggs (tray of 30)' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'EGG-030' }));
  });

  it('after REVIEW_CHANGED shows the approval as typed in the sheet, not applied', async () => {
    await open('#/catalog?view=review-changed');
    fireEvent.click(screen.getByRole('button', { name: 'TEA-001' }));
    const dialog = screen.getByRole('dialog', { name: 'Black tea (100 bags)' });
    const held = within(dialog).getByRole('region', { name: 'Held for review' });
    expect(text(held)).toContain('Approved · applies on next list');
    expect(text(held)).toContain('unit “box”');
    expect(text(within(dialog).getByRole('region', { name: 'Committed in the catalog' }))).toContain('per pack');
  });
});

describe('shell', () => {
  it('opens the navigation drawer from the menu button and closes it with the close button', async () => {
    await open('#/catalog?view=week2-published');
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(menu);
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('link', { name: 'Catalog' }).getAttribute('aria-current')).toBe('page');
    expect(within(drawer).getByRole('combobox', { name: 'Scenario' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
  });

  it('keeps the demo-data indicator visible in the top bar on every screen', async () => {
    await open('#/runs?view=week2-published');
    expect(text(screen.getByRole('banner'))).toContain('Demo data · offline');
  });

  it('treats an empty ?view= as the default scenario instead of an error', async () => {
    const h1 = await open('#/?view=');
    expect(h1.textContent).toBe('Overview');
    expect(text(screen.getByRole('main'))).not.toContain('could not be read');
  });
});

describe('review filter and links', () => {
  it('following a link to an item outside the current filter widens it to show that item', async () => {
    await open('#/review?view=review-changed');
    expect(screen.getByRole('tab', { name: 'Awaiting decision · 2' }).getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      window.location.hash = '#/review/TEA-001?view=review-changed';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('tab', { name: 'All · 3' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('article')).getByRole('heading', { level: 2 }).textContent).toBe('Black tea (100 bags)');
  });
});

describe('responsive tables', () => {
  it('stacked tables keep explicit table roles and label every cell for the narrow layout', async () => {
    await open('#/catalog?view=week2-published');
    const table = screen.getByRole('table');
    expect(table.getAttribute('role')).toBe('table');
    const egg = screen.getByRole('rowheader', { name: 'EGG-030' }).closest('tr')!;
    expect(egg.getAttribute('role')).toBe('row');
    const labels = [...egg.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Product', 'Unit', 'Price (ETB)', 'Previous', 'Status', 'Last changed', 'Last seen']);
  });
});

describe('overview latest-run summary', () => {
  it('summarises the latest run with the real Run Log counts', async () => {
    await open('#/?view=week2-published');
    const latest = screen.getByRole('region', { name: 'Latest run' });
    expect(within(latest).getByRole('heading', { level: 2 }).textContent).toBe('Run 1001 · Published with exceptions');
    expect(text(latest)).toContain('Rows read19');
    expect(text(latest)).toContain('Changes applied5');
    expect(text(latest)).toContain('Held for review3');
    expect(text(latest)).toContain('Rejected rows5');
  });

  it('for a failed latest run shows counts as not recorded and the last committed run separately', async () => {
    await open('#/?view=review-changed');
    const latest = screen.getByRole('region', { name: 'Latest run' });
    expect(within(latest).getByRole('heading', { level: 2 }).textContent).toBe('Run 1002 · Failed');
    // One sentence instead of five "Not recorded" tiles; blank is still never zero.
    expect(text(latest)).toContain('A failed run leaves its counts blank in the Run Log: not recorded, not zero.');
    expect(latest.querySelectorAll('.stat')).toHaveLength(0);
    expect(text(latest)).toContain('The catalog is as run 1001 published it.');
    expect(within(screen.getByRole('region', { name: 'Last committed run' })).getByRole('heading', { level: 2 }).textContent)
      .toBe('Run 1001 · Published with exceptions');
  });
});
