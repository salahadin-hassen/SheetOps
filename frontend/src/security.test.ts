// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards for this milestone: no credential, no Google call and no
// browser-exposed environment variable anywhere in the console's source.

const root = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'security.test.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const sources = [...files(join(root, 'src')), ...files(join(root, 'scripts')),
  join(root, 'index.html'), join(root, 'vite.config.ts'), join(root, 'package.json')]
  .filter((p) => !p.endsWith(SELF));

const read = (p: string) => readFileSync(p, 'utf8');

describe('no credentials or live calls in the console', () => {
  it.each([
    ['a private key', /BEGIN (RSA )?PRIVATE KEY|private_key/],
    ['a service-account file', /service-account\.json|client_email|\.gserviceaccount\.com/],
    ['a Google API host', /googleapis\.com|accounts\.google\.com|oauth2/i],
    ['a browser-exposed env variable', /import\.meta\.env|VITE_[A-Z_]+/],
  ])('no file contains %s', (_what, pattern) => {
    const hits = sources.filter((p) => pattern.test(read(p))).map((p) => p.slice(root.length));
    expect(hits).toEqual([]);
  });

  it('the browser code makes no network requests', () => {
    const browser = files(join(root, 'src')).filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p));
    const hits = browser.filter((p) => /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(read(p)));
    expect(hits).toEqual([]);
  });

  it('no .env file sits in the frontend', () => {
    expect(readdirSync(root).filter((n) => n.startsWith('.env'))).toEqual([]);
  });
});
