import { useId, type ReactNode } from 'react';
import type { Tone } from '../domain/runs';
import { Icon } from './Icon';

/**
 * A compact incident or notice: state, title, code and link on one line, then
 * what must be known now. Longer guidance goes in `details`, one click away.
 * Safety information belongs in `children`, never only in `details`.
 */
export function Banner({ tone, title, status, code, action, details, detailsLabel = 'What to do', children }: {
  tone: Tone;
  title: string;
  /** The state as a word: FAILED, STARTED, UNKNOWN. */
  status?: string;
  /** An error code, exactly as the Run Log holds it. */
  code?: string;
  action?: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`banner tone-${tone}`} aria-labelledby={id}>
      <div className="banner-head">
        {status ? <span className="banner-status">{status}</span> : null}
        <h2 id={id}>{title}</h2>
        {code ? <span className="banner-code mono">{code}</span> : null}
        {action ? <span className="banner-action">{action}</span> : null}
      </div>
      {children ? <div className="banner-body">{children}</div> : null}
      {details ? (
        <details className="banner-details">
          <summary><Icon name="chevronRight" size={13} />{detailsLabel}</summary>
          <div className="banner-body">{details}</div>
        </details>
      ) : null}
    </section>
  );
}

/** Secondary explanatory text: quiet, never a card. */
export function Note({ children }: { children: ReactNode }) {
  return <div className="note">{children}</div>;
}
