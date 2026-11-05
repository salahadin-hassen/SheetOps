import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DemoSource } from '../data/source';
import { STATUS_LABEL } from '../domain/runs';

async function open(hash: string) {
  window.location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  return screen.findByRole('heading', { level: 1 });
}
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('Incoming files', () => {
  it('says it is not the live Drive inbox and lists only recorded files', async () => {
    const h1 = await open('#/incoming?view=week2-published');
    expect(h1.textContent).toBe('Incoming files');
    const notice = screen.getByRole('region', { name: 'Recorded files, not the live Drive inbox' });
    expect(text(notice)).toContain('Files waiting in Drive are not recorded');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('rowheader').map((h) => text(h))).toEqual(['demo-supplier_2026-10-19.csvEffective 19 Oct 2026']);
    expect(text(table)).toContain('Published with exceptions');
  });

  it('keeps a committed file committed when a later attempt failed, and names that attempt', async () => {
    await open('#/incoming?view=review-changed');
    const row = screen.getByRole('rowheader', { name: /demo-supplier_2026-10-19/ }).closest('tr')!;
    expect(text(row)).toContain('Published with exceptions');
    expect(text(row)).toContain('Later attempt: run 1002, failed (REVIEW_CHANGED)');
    expect(within(row).getByRole('link', { name: '1001' })).toBeTruthy();
    expect(within(row).getByRole('link', { name: '1002' })).toBeTruthy();
  });

  it('does not call a file committed while a later publish outcome is unknown', async () => {
    await open('#/incoming?view=review-during-run');
    const row = screen.getByRole('rowheader', { name: /demo-supplier_2026-10-19/ }).closest('tr')!;
    expect(text(row)).toContain(STATUS_LABEL.started.label);
    expect(text(row)).not.toContain('Later attempt');
  });

  it('shows the queue count as what a run recorded, never as a live count', async () => {
    await open('#/incoming?view=week2-published');
    const queue = screen.getByRole('region', { name: 'Queue at the last run' });
    expect(text(queue)).toContain('0 files still in the queue, as run 1001 recorded');
    expect(text(queue)).toContain('not a live count');
  });

  it('before any run, invents no file and does not claim the inbox is empty', async () => {
    await open('#/incoming?view=before-first-run');
    expect(screen.queryByRole('table')).toBeNull();
    expect(text(screen.getByRole('main'))).toContain('No files recorded yet');
    expect(text(screen.getByRole('main'))).toContain('This does not mean the Drive inbox is empty');
    expect(text(screen.getByRole('region', { name: 'Queue at the last run' }))).toContain('Live Drive information is unavailable');
  });
});

describe('Connection', () => {
  it('states demo mode, no live verification and no credential', async () => {
    const h1 = await open('#/connection?view=week2-published');
    expect(h1.textContent).toBe('Connection');
    const source = screen.getByRole('region', { name: 'Data source' });
    expect(text(source)).toContain('Demo, offline');
    expect(text(source)).toContain('Using fixture dataYes');
    const live = screen.getByRole('region', { name: 'Live integration' });
    expect(text(live)).toContain('Not connected');
    expect(text(live)).toContain('Not verified');
    expect(text(live)).toContain('must never reach the browser');
  });

  it('offers nothing to press: no buttons, inputs or connect action', async () => {
    await open('#/connection?view=week2-published');
    const main = screen.getByRole('main');
    expect(within(main).queryAllByRole('button')).toEqual([]);
    expect(within(main).queryAllByRole('textbox')).toEqual([]);
    expect(within(main).queryAllByRole('link', { name: /connect|sign in/i })).toEqual([]);
  });
});

describe('navigation', () => {
  it('every nav item opens a screen with its own title', async () => {
    await open('#/?view=week2-published');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href')?.split('?')[0])).toEqual([
      '#/', '#/review', '#/exceptions', '#/incoming', '#/catalog', '#/changes', '#/runs', '#/connection',
    ]);
  });
});

describe('Runs filter', () => {
  it('filters by the statuses the Run Log holds', async () => {
    await open('#/runs?view=review-changed');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All · 2', 'Failed · 1', 'Published with exceptions · 1']);
    fireEvent.click(screen.getByRole('tab', { name: 'Failed · 1' }));
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Run 1002']);
    expect(text(screen.getByRole('table'))).toContain('REVIEW_CHANGED');
  });

  it('marks a blank count as not recorded, never zero', async () => {
    await open('#/runs?view=review-changed');
    const row = screen.getByRole('rowheader', { name: 'Run 1002' }).closest('tr')!;
    expect(within(row).getAllByText('not recorded')).toHaveLength(3);
  });

  it('shows no filter when there is only one status to choose', async () => {
    await open('#/runs?view=week2-published');
    expect(screen.queryAllByRole('tab')).toEqual([]);
  });
});

describe('Exception records', () => {
  it('opens a record from its row, with the full detail, and returns focus on Escape', async () => {
    await open('#/exceptions?view=week2-published');
    const open5 = screen.getAllByRole('button', { name: 'Details for row 5' })[0];
    open5.focus();
    fireEvent.click(open5);
    const dialog = screen.getByRole('dialog', { name: 'Row 5' });
    expect(text(dialog)).toContain('AMBIGUOUS_PRICE');
    expect(text(dialog)).toContain('“12,5”');
    expect(text(dialog)).toContain('In the catalog now110.00 ETB per kg');
    expect(text(dialog)).toContain('EX|drv-week2@2026-10-19T06:00:00.000Z|5|AMBIGUOUS_PRICE|unit_price');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Row 5' })).toBeNull();
    expect(document.activeElement).toBe(open5);
  });
});

describe('very long exception values', () => {
  it('cuts them in the table, says how much is hidden, and shows all of it in the drawer', async () => {
    const long = 'x'.repeat(40000);
    const source = new DemoSource();
    const read = source.read.bind(source);
    source.read = async (id: string) => {
      const snapshot = await read(id);
      const row = snapshot.tabs.Exceptions[0];
      Object.assign(row, { raw_value: long, sku_raw: long, message: long });
      return snapshot;
    };
    window.location.hash = '#/exceptions?view=week2-published';
    await new Promise((resolve) => setTimeout(resolve, 0));
    render(<App source={source} />);
    await screen.findByRole('heading', { level: 1 });
    const table = screen.getByRole('table');
    expect(table.textContent!.length).toBeLessThan(10000);
    expect(text(table)).toContain('39,960 more characters');
    fireEvent.click(screen.getAllByRole('button', { name: /^Details for row/ })[0]);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(long);
  });
});

describe('Review records from the keyboard', () => {
  it('offers a jump from the selected item into its detail', async () => {
    await open('#/review?view=week2-published');
    const jump = screen.getByRole('link', { name: /Jump to this change/ });
    fireEvent.click(jump);
    expect(document.activeElement).toBe(within(screen.getByRole('article')).getByRole('heading', { level: 2 }));
  });

  it('keeps proposed and catalog values in separate, labelled columns', async () => {
    await open('#/review/EGG-030?view=week2-published');
    const table = within(screen.getByRole('article')).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Field', 'In the catalog now', 'Proposed · not applied']);
    const price = within(table).getByRole('rowheader', { name: 'Price (ETB)' }).closest('tr')!;
    const [current, proposed] = within(price).getAllByRole('cell');
    expect(current.textContent).toBe('300.00');
    expect(text(proposed)).toContain('420.00');
    expect(text(proposed)).toContain('+120.00 (+40.0%)');
  });

  it('on one column, moves focus into the record and back to its link on return', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('860px'), addEventListener: () => {}, removeEventListener: () => {},
    }));
    vi.stubGlobal('CSS', { escape: (v: string) => v });
    await open('#/review?view=week2-published');
    const { act } = await import('@testing-library/react');
    await act(async () => { window.location.hash = '#/review/EGG-030?view=week2-published'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(document.activeElement).toBe(within(screen.getByRole('article')).getByRole('heading', { level: 2 }));
    await act(async () => { window.location.hash = '#/review?view=week2-published'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /EGG-030/ }));
  });
});

describe('incident summaries keep safety information visible', () => {
  // Everything outside the closed details: what a reader sees without a click.
  const visible = (region: HTMLElement) => {
    const copy = region.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('details').forEach((d) => d.remove());
    return text(copy);
  };

  it('REVIEW_CHANGED: state, run, code, nothing applied and the kept edit, with no action button', async () => {
    await open('#/review?view=review-changed');
    const banner = screen.getByRole('region', { name: 'Run 1002 published nothing: Review changed during the run' });
    const shown = visible(banner);
    for (const part of ['FAILED', 'REVIEW_CHANGED', 'Nothing was applied', 'TEA-001 APPROVE', 'It is not applied yet', 'View run 1002']) expect(shown).toContain(part);
    expect(within(banner).getByRole('link', { name: 'View run 1002' })).toBeTruthy();
    expect(within(banner).queryAllByRole('button')).toEqual([]);
    expect(banner.querySelector('details')!.open).toBe(false);
    expect(text(banner.querySelector('details'))).toContain('This console cannot start a run.');
  });

  it('a formula in a decision cell keeps its own title and code', async () => {
    const source = new DemoSource();
    const read = source.read.bind(source);
    source.read = async (id: string) => {
      const snapshot = await read(id);
      const failed = snapshot.tabs['Run Log'].find((r) => r.status === 'FAILED')!;
      failed.error_code = 'REVIEW_DECISION_NOT_LITERAL';
      return snapshot;
    };
    window.location.hash = '#/review?view=review-changed';
    await new Promise((resolve) => setTimeout(resolve, 0));
    render(<App source={source} />);
    await screen.findByRole('heading', { level: 1 });
    expect(visible(screen.getByRole('region', { name: 'Run 1002 published nothing: a decision cell was not typed' }))).toContain('REVIEW_DECISION_NOT_LITERAL');
  });

  it('while a run shows STARTED, the warning and the unlocked sheet are not behind a click', async () => {
    await open('#/review?view=review-during-run');
    const shown = visible(screen.getByRole('region', { name: /Run 1002 has started/ }));
    expect(shown).toContain('do not edit Review in the sheet');
    expect(shown).toContain('the Google Sheet itself is not locked');
  });

  it('an unknown outcome says it is not failed and not to edit, without a click', async () => {
    await open('#/?view=outcome-unknown');
    const shown = visible(screen.getByRole('region', { name: /outcome of run 1001 is unknown/ }));
    expect(shown).toContain('This run is not marked Failed');
    expect(shown).toContain('Do not edit the Review tab');
    expect(shown).not.toContain('FAILED');
  });
});

describe('Review comparison', () => {
  it('marks only changed proposed values as changed, and never as the catalog value', async () => {
    await open('#/review/TEA-001?view=review-changed');
    const table = within(screen.getByRole('article')).getByRole('table');
    const row = (name: string) => within(table).getByRole('rowheader', { name }).closest('tr')!;
    const proposed = (name: string) => within(row(name)).getAllByRole('cell')[1];
    expect(proposed('Unit').className).toContain('changed');
    expect(text(proposed('Unit'))).toBe('box (changed)');
    expect(proposed('Name').className).toContain('same');
    expect(within(row('Unit')).getAllByRole('cell')[0].textContent).toBe('pack');
  });
});

describe('colour carries meaning', () => {
  it('an unknown outcome is never presented with the failure tone', () => {
    expect(STATUS_LABEL.unresolved.tone).not.toBe('red');
    expect(STATUS_LABEL.unresolved.label).toBe('Outcome unknown');
  });
});
