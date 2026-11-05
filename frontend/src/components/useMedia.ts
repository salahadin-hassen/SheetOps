import { useEffect, useState } from 'react';

/** True while a media query matches. False where matchMedia is unavailable. */
export function useMedia(query: string): boolean {
  const read = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Where the Review list and detail become two separate views; matches app.css. */
export const SINGLE_COLUMN = '(max-width: 860px)';
/** Where long secondary sections start collapsed; matches app.css. */
export const PHONE = '(max-width: 640px)';
