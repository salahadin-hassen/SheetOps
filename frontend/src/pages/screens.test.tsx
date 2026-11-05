import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import type { SheetSource } from '../data/source';

async function open(hash: string, source?: SheetSource) {
  window.location.hash = hash;
  // jsdom fires hashchange for this assignment asynchronously; let it pass
  // before mounting, as a browser does not fire one on page load.
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App source={source} />);
  return screen.findByRole('heading', { level: 1 });
}

const main = () => screen.getByRole('main');
const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('REVIEW_CHANGED run details', () => {
  it('shows a definitive failure with the publish not sent', async () => {
    const h1 = await open('#/runs/1002?view=review-changed');
    expect(h1.textContent).toBe('Run 1002');
    const m = main();
    expect(within(m).getAllByText('Failed').length).toBeGreaterThan(0);
    expect(text(m)).toContain('REVIEW_CHANGED');

    const stages = within(m).getByRole('list', { name: 'Run 1002 stages' });
    const items = within(stages).getAllByRole('listitem').map(text);
    expect(items).toEqual(['1 · Queue checkDone', '2 · DownloadDone', '3 · ValidateDone', '4 · PlanDone', '5 · PublishNot sent']);
  });

  it('keeps the operator’s edit and does not show it as applied', async () => {
    await open('#/runs/1002?view=review-changed');
    const outcome = screen.getByRole('region', { name: 'Publication outcome' });
    expect(text(outcome)).toContain('Not sent');
    expect(text(outcome)).toMatch(/Kept in the sheet: TEA-001 decision APPROVE/);
    expect(text(outcome)).toContain('Not applied');
  });

  it('offers no retry or any other action button', async () => {
    await open('#/runs/1002?view=review-changed');
    expect(within(main()).queryAllByRole('button')).toEqual([]);
    expect(text(main())).not.toMatch(/\bretry (now|run)\b/i);
  });

  it('shows the blank counts as not recorded', async () => {
    await open('#/runs/1002?view=review-changed');
    const panel = screen.getByRole('region', { name: 'Processing statistics' });
    // Twelve blank cells are named in one line, not repeated as twelve rows;
    // queue_remaining (0) is the one count a FAILED row records, and it stays a table row.
    expect(text(panel)).toContain('12 counts not recorded: Accepted, Duplicate collapsed, Rejected, Held: conflicting rows, Held for review, Blank, Rows read, Changes applied, Reviews opened, Reviews pending, New exceptions, Exceptions in this batch.');
    expect(text(panel)).toContain('blank means not recorded, not zero');
    const stats = screen.getByRole('region', { name: /Run 1002 counts/ });
    expect(within(stats).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Files still in the queue']);
    const queue = within(stats).getByRole('rowheader', { name: 'Files still in the queue' }).closest('tr')!;
    expect(text(queue)).toBe('Files still in the queue0');
  });
});

describe('Review is read-only', () => {
  it('after REVIEW_CHANGED, lists TEA-001 as approved in the sheet but not applied', async () => {
    await open('#/review/TEA-001?view=review-changed');
    const m = main();
    expect(text(m)).toContain('Run 1002 published nothing: Review changed during the run');
    const detail = within(m).getByRole('article');
    expect(within(detail).getByRole('heading', { level: 2 }).textContent).toBe('Black tea (100 bags)');
    expect(text(detail)).toContain('Approved · applies on next list');
    expect(text(detail)).toMatch(/status column still says PENDING, as run 1001 wrote it/);
    expect(text(detail)).toMatch(/Nothing has been applied: the catalog keeps unit pack/);
    expect(text(detail)).not.toMatch(/\b(committed|was applied)\b/i);
  });

  it('has no inputs or decision buttons', async () => {
    await open('#/review?view=week2-published');
    const m = main();
    expect(within(m).queryAllByRole('textbox')).toEqual([]);
    expect(within(m).queryAllByRole('button').every((b) => b.getAttribute('role') === 'tab')).toBe(true);
    expect(text(m)).toContain('Read-only.');
  });

  it('while a run shows STARTED, says not to edit the sheet and that the sheet is not locked', async () => {
    await open('#/review?view=review-during-run');
    const banner = screen.getByRole('region', { name: /Run 1002 has started and has no result yet/ });
    expect(text(banner)).toContain('the Google Sheet itself is not locked');
    expect(text(main())).not.toMatch(/sheet is locked|locks the sheet|decisions are locked/i);
  });

  it('filter tabs move with the arrow keys', async () => {
    await open('#/review?view=review-changed');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Awaiting decision · 2', 'Approved · 1', 'All · 3']);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    const selected = screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(selected.textContent).toBe('Approved · 1');
    expect(document.activeElement).toBe(selected);
    expect(text(screen.getByRole('tabpanel'))).toContain('TEA-001');
  });

  it('after following a link to an item, the filter tabs still move freely', async () => {
    await open('#/review/TEA-001?view=review-changed');
    const all = screen.getByRole('tab', { name: 'All · 3' });
    expect(all.getAttribute('aria-selected')).toBe('true');
    all.focus();
    fireEvent.keyDown(all, { key: 'Home' });
    const first = screen.getByRole('tab', { name: 'Awaiting decision · 2' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(first);
  });

  it('is an empty state when nothing is held', async () => {
    await open('#/review?view=before-first-run');
    expect(text(main())).toContain('Nothing is held for review');
  });
});

describe('Overview', () => {
  it('outcome unknown pauses publishing and is not called failed', async () => {
    await open('#/?view=outcome-unknown');
    const banner = screen.getByRole('region', { name: 'Publishing is paused: the outcome of run 1001 is unknown' });
    expect(text(banner)).toContain('This run is not marked Failed');
  });

  it('week 2: last committed run with row accounting, review and exceptions summaries', async () => {
    await open('#/?view=week2-published');
    const m = main();
    expect(text(m)).toContain('3 changes awaiting a decision');
    expect(text(m)).toContain('9 exceptions from run 1001');
    expect(text(m)).toContain('Every row accounted for: 19 read');
    expect(within(m).getByRole('region', { name: /Changes applied by run 1001/ })).toBeTruthy();
  });

  it('before the first run shows empty states, not zeros', async () => {
    await open('#/?view=before-first-run');
    expect(text(main())).toContain('No committed run yet');
    expect(text(main())).toContain('No runs recorded');
  });

  it('a refused publish is a red banner with the code', async () => {
    await open('#/?view=publish-refused');
    const banner = screen.getByRole('region', { name: 'Run 1001 failed: nothing was published' });
    expect(text(banner)).toContain('PUBLISH_REJECTED');
  });
});

describe('Exceptions', () => {
  it('lists every exception with severity, code, raw value and what to do', async () => {
    await open('#/exceptions?view=week2-published');
    const table = screen.getByRole('table');
    expect(text(table)).toContain('AMBIGUOUS_PRICE');
    expect(text(table)).toContain('“12,5”');
    expect(text(table)).toContain('What to do:');
    fireEvent.click(screen.getByRole('tab', { name: 'Held · 3' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows.length).toBe(1 + 3 * 2);
  });

  it('is an empty state when the tab is empty', async () => {
    await open('#/exceptions?view=publish-refused');
    expect(text(main())).toContain('No exceptions recorded');
  });
});

describe('shell', () => {
  it('labels demo data and marks the current screen', async () => {
    await open('#/review?view=week2-published');
    expect(text(screen.getByRole('region', { name: 'Demo data' }))).toContain('Demo · offline synthetic data. Not connected to Google.');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const current = within(nav).getByRole('link', { name: 'Review, 3 awaiting a decision' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Exceptions, 9 in run 1001' })).toBeTruthy();
  });

  it('keeps focus at the start on first load, then moves it to the title on a screen change', async () => {
    const h1 = await open('#/?view=week2-published');
    expect(document.activeElement).not.toBe(h1);
    await act(async () => { window.location.hash = '#/runs?view=week2-published'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    const next = await screen.findByRole('heading', { level: 1, name: 'Runs' });
    expect(document.activeElement).toBe(next);
  });

  it('shows an error and no data when the source cannot be read', async () => {
    const failing: SheetSource = {
      mode: 'demo', origin: 'test',
      listViews: async () => [],
      read: async () => { throw new Error('Simulated read failure'); },
    };
    const h1 = await open('#/', failing);
    expect(h1.textContent).toBe('The data could not be read');
    expect(text(main())).toContain('Simulated read failure');
  });

  it('an unknown path is a not-found screen', async () => {
    const h1 = await open('#/nowhere?view=week2-published');
    expect(h1.textContent).toBe('Page not found');
  });
});
