import { useId } from 'react';
import { Icon } from './Icon';

/** A labelled search box. Filtering happens as you type; nothing is submitted. */
export function SearchField({ label, value, onChange, hint }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="search-wrap">
        <Icon name="search" size={15} />
        <input id={id} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={hint}
          autoComplete="off" spellCheck={false} />
      </span>
    </div>
  );
}

export function SelectField<V extends string>({ label, value, options, onChange }: {
  label: string;
  value: V;
  options: Array<{ value: V; label: string }>;
  onChange: (value: V) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** Announces how many rows a filter left, for screen-reader users. */
export function ResultCount({ children }: { children: string }) {
  return <p className="xsmall muted" role="status" aria-live="polite">{children}</p>;
}
