import type { ReactNode } from 'react';
import { STATUS_LABEL, type Run, type Tone } from '../domain/runs';

/** A state that matters: a dot and a word. Failed and pending words also take the state's colour. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status-text state tone-${tone}`}><span className={`dot ${tone}`} aria-hidden="true" />{children}</span>;
}

/** A quiet status: a coloured dot and text, for dense tables. */
export function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className="status-text"><span className={`dot ${tone}`} aria-hidden="true" />{children}</span>;
}

export function RunStatusPill({ run }: { run: Run }) {
  const { label, tone } = STATUS_LABEL[run.kind];
  return <Pill tone={tone}>{label}</Pill>;
}
