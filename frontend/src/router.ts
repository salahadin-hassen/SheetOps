import { createContext, useContext, useEffect, useState } from 'react';

// A small hash router: the console is a static page, so every screen has a
// link (#/runs/1002?view=review-changed) and Back works, with no server
// routes. The demo scenario rides along in `view`.

export type Route =
  | { page: 'overview' }
  | { page: 'runs' }
  | { page: 'run'; runId: string }
  | { page: 'review'; sku: string | null }
  | { page: 'exceptions' }
  | { page: 'catalog' }
  | { page: 'changes' }
  | { page: 'not-found'; path: string };

export interface Location {
  route: Route;
  view: string | null;
  /** How many in-page navigations happened since load (0 on first load). */
  navigations: number;
}

export function parseHash(hash: string): Location {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const view = new URLSearchParams(query).get('view');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  let route: Route;
  if (parts.length === 0) route = { page: 'overview' };
  else if (parts[0] === 'runs' && parts.length === 1) route = { page: 'runs' };
  else if (parts[0] === 'runs' && parts.length === 2) route = { page: 'run', runId: parts[1] };
  else if (parts[0] === 'review' && parts.length <= 2) route = { page: 'review', sku: parts[1] ?? null };
  else if (parts[0] === 'exceptions' && parts.length === 1) route = { page: 'exceptions' };
  else if (parts[0] === 'catalog' && parts.length === 1) route = { page: 'catalog' };
  else if (parts[0] === 'changes' && parts.length === 1) route = { page: 'changes' };
  else route = { page: 'not-found', path };
  return { route, view, navigations: 0 };
}

export function useLocation(): Location {
  const [location, setLocation] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setLocation((prev) => ({ ...parseHash(window.location.hash), navigations: prev.navigations + 1 }));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return location;
}

/** Builds hrefs that keep the current demo scenario. */
export const LinkContext = createContext<(path: string) => string>((path) => `#${path}`);
export const useHref = () => useContext(LinkContext);

/** True once the user has moved between screens; page titles take focus only then. */
export const NavigatedContext = createContext(false);

export function hrefFor(path: string, view: string | null): string {
  return `#${path}${view ? `?view=${encodeURIComponent(view)}` : ''}`;
}
