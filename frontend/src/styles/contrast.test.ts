// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WCAG 2.2 AA: 4.5:1 for text, 3:1 for focus rings, field borders and the
// stage-node borders. Every pair here is used together in app.css.

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(tokens[a]), luminance(tokens[b])].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT: Array<[string, string]> = [
  // Body text on every surface
  ...['color-bg', 'color-surface', 'color-surface-muted', 'color-surface-sunken', 'color-selected', 'color-accent-subtle'].flatMap(
    (bg): Array<[string, string]> => [['color-text', bg], ['color-text-secondary', bg], ['color-text-tertiary', bg]]),
  // Links and accents
  ['color-accent', 'color-surface'], ['color-accent', 'color-bg'], ['color-accent', 'color-surface-muted'], ['color-accent', 'color-selected'],
  ['color-accent-hover', 'color-surface'], ['color-accent-hover', 'color-surface-sunken'], ['warning-text', 'color-surface-sunken'], ['color-accent-hover', 'color-accent-subtle'], ['color-on-accent', 'color-text'],
  // Solid primary button, at rest, hovered and pressed
  ['color-on-accent', 'color-accent'], ['color-on-accent', 'color-accent-hover'], ['color-on-accent', 'color-accent-pressed'],
  // Status text on its own tint, and on plain surfaces
  ...['success', 'warning', 'danger', 'info', 'neutral'].flatMap((t): Array<[string, string]> => [
    [`${t}-text`, `${t}-bg`], [`${t}-text`, 'color-surface'], ['color-text', `${t}-bg`], ['color-text-secondary', `${t}-bg`],
  ]),
  ['warning-text', 'color-selected'], ['color-accent', 'info-bg'], ['color-accent', 'danger-bg'],
];

const NON_TEXT: Array<[string, string]> = [
  ['color-focus', 'color-surface'], ['color-focus', 'color-bg'], ['color-field-border', 'color-surface'],
  ['color-accent', 'color-selected'],
  // Stage nodes: the border carries the state alongside the written word
  ['success-dot', 'success-bg'], ['info-dot', 'color-surface'], ['danger-dot', 'danger-bg'], ['warning-dot', 'warning-bg'],
  ['neutral-dot', 'neutral-bg'],
];

describe('token contrast', () => {
  it.each(TEXT)('text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(NON_TEXT)('%s on %s is at least 3:1', (fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});
