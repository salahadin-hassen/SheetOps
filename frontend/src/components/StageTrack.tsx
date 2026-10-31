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
            <span className="stage-node"><Icon name={ICON[s.state]} size={12} /></span>
            <span className="stage-line" />
          </span>
          <span className="stage-name">{i + 1} · {s.name}</span>
          <span className="stage-word">{s.word}</span>
        </li>
      ))}
    </ol>
  );
}

export function StageLegend() {
  const items: Array<[StageState, string]> = [
    ['done', 'Done'], ['pending', 'No result yet'], ['not-in-sheet', 'Not in the sheet (dashed)'],
    ['not-reached', 'Not reached'], ['unknown', 'Unknown'], ['failed', 'Failed or not sent'],
  ];
  return (
    <ul className="legend" aria-label="Stage legend">
      {items.map(([state, text]) => (
        <li key={state}><Icon name={ICON[state]} size={12} />{text}</li>
      ))}
    </ul>
  );
}
