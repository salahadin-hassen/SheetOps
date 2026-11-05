import type { Stage, StageState } from '../domain/runs';
import { Icon, type IconName } from './Icon';

const ICON: Record<StageState, IconName> = {
  done: 'check',
  pending: 'clock',
  'not-in-sheet': 'dash',
  'not-reached': 'dash',
  unknown: 'question',
  failed: 'cross',
  stopped: 'pause',
  rejected: 'fileX',
  recorded: 'check',
  replaced: 'replaced',
};

/** The five-stage stepper. Each stage word is written out; colour is never the only signal. */
export function StageTrack({ stages, label }: { stages: Stage[]; label: string }) {
  return (
    <ol className="stages" aria-label={label}>
      {stages.map((s, i) => (
        <li key={s.name} className={`stage ${s.state}`}>
          <span className="stage-rail" aria-hidden="true">
            <span className="stage-node"><Icon name={ICON[s.state]} size={11} /></span>
            <span className="stage-line" />
          </span>
          <span className="stage-name">{i + 1} · {s.name}</span>
          <span className="stage-word">{s.word}</span>
        </li>
      ))}
    </ol>
  );
}

/** Only the one marking that the written stage word does not already explain. */
export function StageLegend({ stages }: { stages: Stage[] }) {
  if (!stages.some((s) => s.state === 'not-in-sheet')) return null;
  return (
    <p className="xsmall subtle">
      A dashed stage leaves no record in the sheet until the publish, so the sheet cannot show what happened there.
    </p>
  );
}
