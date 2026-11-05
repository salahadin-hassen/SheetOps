import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';

// These tests render the whole app, and role queries walk its whole tree, which
// is slow in jsdom. They use plain DOM lookups for structure, and role queries
// only inside a small subtree or where the role itself is what is being tested.
async function open(hash: string) {
  window.location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  await waitFor(() => expect(document.querySelector('h1')).not.toBeNull());
}
const nav = () => document.querySelector<HTMLElement>('nav[aria-label="Main"]')!;
const navLinks = () => [...nav().querySelectorAll('a')];

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('sidebar navigation', () => {
  it('names its groups for screen readers, in order, with every item under the right group', async () => {
    await open('#/?view=week2-published');
    const group = (name: string) => within(within(nav()).getByRole('list', { name })).getAllByRole('link').map((l) => l.textContent);
    expect(within(nav()).getAllByRole('list').map((l) => l.getAttribute('aria-labelledby'))).toEqual(['nav-rail-Operate', 'nav-rail-Records', 'nav-rail-System']);
    expect(group('Operate')).toEqual(['Overview', 'Review3', 'Exceptions9', 'Incoming files']);
    expect(group('Records')).toEqual(['Catalog', 'Change history', 'Runs']);
    expect(group('System')).toEqual(['Connection']);
  });

  it.each([
    ['#/', 'Overview'],
    ['#/review', 'Review, 3 awaiting a decision'],
    ['#/review/EGG-030', 'Review, 3 awaiting a decision'],
    ['#/exceptions', 'Exceptions, 9 in run 1001'],
    ['#/incoming', 'Incoming files'],
    ['#/catalog', 'Catalog'],
    ['#/changes', 'Change history'],
    ['#/runs', 'Runs'],
    ['#/runs/1001', 'Runs'],
    ['#/connection', 'Connection'],
  ])('at %s marks only "%s" as the current page', async (path, name) => {
    await open(`${path}?view=week2-published`);
    const current = navLinks().filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.getAttribute('aria-label') ?? l.textContent)).toEqual([name]);
  });

  it('marks nothing as current on an unknown path', async () => {
    await open('#/nowhere?view=week2-published');
    expect(navLinks().filter((l) => l.hasAttribute('aria-current'))).toEqual([]);
  });

  it('keeps every label visible, and every icon hidden from screen readers', async () => {
    await open('#/?view=week2-published');
    const links = navLinks();
    expect(links).toHaveLength(8);
    for (const link of links) {
      expect(link.querySelector('.nav-label')!.textContent).not.toBe('');
      const icons = link.querySelectorAll('svg');
      expect(icons).toHaveLength(1);
      expect(icons[0].getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('keeps the scenario in the demo panel, with its description reachable', async () => {
    await open('#/?view=review-changed');
    const panel = document.querySelector<HTMLElement>('section.env')!;
    expect(panel.getAttribute('aria-label')).toBe('Demo data');
    const select = within(panel).getByRole('combobox', { name: 'Scenario' });
    const description = document.getElementById(select.getAttribute('aria-describedby')!)!;
    expect(description.textContent).toContain('REVIEW_CHANGED');
  });
});

describe('navigation drawer', () => {
  const openDrawer = () => {
    const menu = document.querySelector<HTMLElement>('.menu-button')!;
    expect(menu.getAttribute('aria-label')).toBe('Open navigation');
    menu.focus();
    fireEvent.click(menu);
    const drawer = document.querySelector<HTMLDialogElement>('dialog.drawer.left')!;
    const title = document.getElementById(drawer.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Navigation');
    return { menu, drawer };
  };

  it('uses its own group names, so ids never collide with the rail', async () => {
    await open('#/?view=week2-published');
    const { drawer } = openDrawer();
    expect(within(drawer).getByRole('list', { name: 'Operate' }).getAttribute('aria-labelledby')).toBe('nav-drawer-Operate');
  });

  it('closes on Escape and returns focus to the menu button', async () => {
    await open('#/?view=week2-published');
    const { menu, drawer } = openDrawer();
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(document.querySelector('dialog.drawer.left .nav-drawer a')).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('closes on a backdrop click', async () => {
    await open('#/?view=week2-published');
    const { drawer } = openDrawer();
    fireEvent.click(drawer);
    expect(document.querySelector('dialog.drawer.left .nav-drawer a')).toBeNull();
  });

  it('closes when a link is followed', async () => {
    await open('#/?view=week2-published');
    const { drawer } = openDrawer();
    const link = within(drawer).getByRole('link', { name: 'Catalog' });
    await act(async () => {
      fireEvent.click(link);
      window.location.hash = '#/catalog?view=week2-published';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(document.querySelector('dialog.drawer.left .nav-drawer a')).toBeNull();
    await waitFor(() => expect(document.querySelector('h1')!.textContent).toBe('Catalog'));
  });
});
