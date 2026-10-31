import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../App';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

it('following a link within the same screen keeps focus on that link', async () => {
  window.location.hash = '#/review?view=week2-published';
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Review' });
  const item = screen.getByRole('link', { name: /EGG-030/ });
  item.focus();
  // The first in-app navigation, and it stays on the Review screen.
  await navigate('#/review/EGG-030?view=week2-published');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: /EGG-030/ }));
});

it('moving to another screen still puts focus on its title', async () => {
  window.location.hash = '#/review?view=week2-published';
  await new Promise((resolve) => setTimeout(resolve, 0));
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Review' });
  await navigate('#/catalog?view=week2-published');
  expect(document.activeElement).toBe(await screen.findByRole('heading', { level: 1, name: 'Catalog' }));
});
