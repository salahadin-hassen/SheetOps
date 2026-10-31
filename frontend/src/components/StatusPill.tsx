import type { ReactNode } from 'react';
import { STATUS_LABEL, type Run, type Tone } from '../domain/runs';
import { Icon, type IconName } from './Icon';

const TONE_ICON: Record<Tone, IconName> = {
  blue: 'clock', green: 'check', violet: 'question', red: 'cross', amber: 'pause', neutral: 'dash',
};

/** A tinted badge: reserved for states that matter (status, decision, severity). */
export function Pill({ tone, icon, children }: { tone: Tone; icon?: IconName | null; children: ReactNode }) {
  const name = icon === null ? null : icon ?? TONE_ICON[tone];
  return (
    <span className={`badge tone-${tone}`}>
      {name ? <Icon name={name} size={12} /> : null}
      {children}
    </span>
  );
}

/** A quiet status: a coloured dot and text, for dense tables. */
export function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className="status-text"><span className={`dot ${tone}`} aria-hidden="true" />{children}</span>;
}

export function RunStatusPill({ run }: { run: Run }) {
  const { label, tone } = STATUS_LABEL[run.kind];
  const icon: IconName | undefined = run.kind === 'rejected' ? 'fileX' : run.kind === 'superseded' ? 'replaced' : undefined;
  return <Pill tone={tone} icon={icon}>{label}</Pill>;
}
