import { explainRun } from '../domain/explain';
import { formatTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { useHref } from '../router';
import { Banner } from './Banner';

/** What a definitive failure left behind, stated beside the title. */
const AFTERMATH: Record<string, string> = {
  REVIEW_CHANGED: 'The catalog is unchanged. The edit in the sheet is kept and not applied.',
  REVIEW_DECISION_NOT_LITERAL: 'The catalog is unchanged. The decision cell was not changed, and a formula never counts as an approval.',
};

/**
 * The console-wide status summary: a STARTED row (in progress or unresolved)
 * outranks everything; otherwise the latest run, if it failed.
 */
export function RunBanner({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const { publishing, latest, runs } = model;

  if (publishing.kind === 'unresolved') {
    const run = publishing.run;
    return (
      <Banner tone="amber" status="UNKNOWN" title={`Publishing is paused: the outcome of run ${run.id} is unknown`}
        action={<a href={href(`/runs/${run.id}`)}>Investigate run {run.id}</a>}
        detailsLabel="What this means"
        details={(
          <>
            <p>
              Run {run.id} started processing <span className="mono">{run.row.source_name || 'a file'}</span> at {formatTime(run.row.started_at)}.
              Runs are configured to stop after 5 minutes; the n8n execution record shows what happened.
            </p>
            <ul>
              <li>No status has been written over the row, and automatic recovery is off by default.</li>
              <li>Scheduled runs stop until a person resolves it; newer files wait.</li>
            </ul>
          </>
        )}>
        <p>
          The Run Log still shows STARTED after {run.ageMinutes} minutes, so the sheet cannot show whether the update was applied.
          This run is not marked Failed: no evidence shows that it failed.
          Do not edit the Review tab in the sheet while that row shows STARTED.
        </p>
      </Banner>
    );
  }

  if (publishing.kind === 'started') {
    const run = publishing.run;
    return (
      <Banner tone="blue" status="STARTED" title={`Run ${run.id} has started and has no result yet`}
        action={<a href={href(`/runs/${run.id}`)}>View run {run.id}</a>}>
        <p>
          Run {run.id}&rsquo;s Run Log row shows STARTED, written at {formatTime(run.row.started_at)}
          {run.row.source_name ? <> for <span className="mono">{run.row.source_name}</span></> : null}, {run.ageMinutes} minute{run.ageMinutes === 1 ? '' : 's'} ago, with no final status yet.
          This console reads the sheet, not n8n.
        </p>
      </Banner>
    );
  }

  if (latest && latest.kind === 'failed') {
    const why = explainRun(latest, runs);
    return (
      <Banner tone="red" status="FAILED" code={latest.row.error_code || 'No code recorded'}
        title={`Run ${latest.id} failed: nothing was published`}
        action={<a href={href(`/runs/${latest.id}`)}>View run {latest.id}</a>}
        details={(
          <>
            <p>{why.meaning}</p>
            <p><strong>Operator:</strong> {why.operator}</p>
          </>
        )}>
        <p>{AFTERMATH[latest.row.error_code] ?? 'The catalog is unchanged.'}</p>
      </Banner>
    );
  }

  return null;
}
