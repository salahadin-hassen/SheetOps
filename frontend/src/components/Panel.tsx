import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { PHONE, useMedia } from './useMedia';

/** A card with a header. `flush` lets tables run edge to edge. */
export function Panel({ title, aside, sub, children, level = 2, flush = false, foot, labelledBy }: {
  title: string;
  aside?: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  level?: 2 | 3;
  flush?: boolean;
  foot?: ReactNode;
  labelledBy?: string;
}) {
  const generated = useId();
  const id = labelledBy ?? generated;
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-head">
        <div>
          <Heading id={id}>{title}</Heading>
          {sub ? <div className="card-sub">{sub}</div> : null}
        </div>
        {aside}
      </div>
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
      {foot ? <div className="card-foot">{foot}</div> : null}
    </section>
  );
}

/**
 * Sets a <details> open or closed for the current width without taking control
 * of it: the reader's own toggle stands until the breakpoint changes.
 */
function useResponsiveDetails() {
  const phone = useMedia(PHONE);
  const ref = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.open = !phone;
  }, [phone]);
  return ref;
}

/** A panel that starts collapsed on a phone, so long secondary detail stays one tap away. */
export function CollapsiblePanel({ title, sub, flush = false, children }: { title: string; sub?: ReactNode; flush?: boolean; children: ReactNode }) {
  const ref = useResponsiveDetails();
  return (
    <details ref={ref} className="card card-details">
      <summary className="card-head">
        <div>
          <h2>{title}</h2>
          {sub ? <div className="card-sub">{sub}</div> : null}
        </div>
        <Icon name="chevronRight" size={14} />
      </summary>
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </details>
  );
}

/** Detail that stays one click away, without a box around it. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary><Icon name="chevronRight" size={13} />{title}</summary>
      {children}
    </details>
  );
}

/** Label and value rows: quiet figures for a side panel. */
export function Figures({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="figures">
      {items.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd className="num">{value}</dd></div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, note }: { label: string; value: number | string | null; note?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      {value === null
        ? <div className="stat-value not-recorded">Not recorded</div>
        : <div className="stat-value">{value}</div>}
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function DefinitionList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="deflist">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt>{term}</dt>
          <dd>{value === '' || value === null || value === undefined ? <span className="subtle">Not recorded</span> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, children, level = 2 }: { title: string; children?: ReactNode; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="empty">
      <Heading>{title}</Heading>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}
