import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabOption<K extends string> {
  key: K;
  label: string;
}

/**
 * Filter tabs (WAI-ARIA tabs pattern): one tab stop, arrow keys move between
 * tabs, Home and End jump to the ends. Selection follows focus.
 */
export function Tabs<K extends string>({ label, options, value, onChange, children }: {
  label: string;
  options: TabOption<K>[];
  value: K;
  onChange: (key: K) => void;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.key === value));

  const move = (to: number) => {
    const next = (to + options.length) % options.length;
    onChange(options[next].key);
    refs.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(options.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <>
      <div role="tablist" aria-label={label} className="tabs" onKeyDown={onKeyDown}>
        {options.map((o, i) => (
          <button key={o.key} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" className="tab"
            id={`${base}-tab-${o.key}`} aria-selected={i === index} aria-controls={`${base}-panel`}
            tabIndex={i === index ? 0 : -1} onClick={() => onChange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="tabs-panel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${options[index]?.key}`}>
        {children}
      </div>
    </>
  );
}
