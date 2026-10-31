import { useId, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

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

export function EmptyState({ title, children, level = 2, icon = 'inbox' }: { title: string; children?: ReactNode; level?: 2 | 3; icon?: IconName }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={18} /></span>
      <Heading>{title}</Heading>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}
