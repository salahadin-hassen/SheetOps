import { explainRun } from '../domain/explain';
import { formatTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { useHref } from '../router';
import { Banner } from './Banner';

/**
 * The console-wide status banner: a STARTED row (in progress or unresolved)
 * outranks everything; otherwise the latest run, if it failed.
 */
export function RunBanner({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const { publishing, latest, runs } = model;

  if (publishing.kind === 'unresolved') {
    const run = publishing.run;
    return (
      <Banner tone="violet" title={`Publishing is paused: the outcome of run ${run.id} is unknown`}>
        <p>
          Run {run.id} started processing <span className="mono">{run.row.source_name || 'a file'}</span> at {formatTime(run.row.started_at)}.
          The Run Log still shows STARTED after {run.ageMinutes} minutes. No final status is recorded, so the sheet cannot show
          whether the update was applied. Runs are configured to stop after 5 minutes; the n8n execution record shows what happened.
        </p>
        <ul>
          <li>No status has been written over the row, and automatic recovery is off by default.</li>
          <li>Scheduled runs stop until a person resolves it; newer files wait.</li>
          <li>Do not edit the Review tab in the sheet while that row shows STARTED.</li>
        </ul>
        <div className="banner-actions">
          <a href={href(`/runs/${run.id}`)}>Investigate run {run.id}</a>
          <span className="small">This run is not marked Failed: no evidence shows that it failed.</span>
        </div>
      </Banner>
    );
  }

  if (publishing.kind === 'started') {
    const run = publishing.run;
    return (
      <Banner tone="blue" title={`Run ${run.id} has started and has no result yet`}>
        <p>
          Run {run.id}&rsquo;s Run Log row shows STARTED, written at {formatTime(run.row.started_at)}
          {run.row.source_name ? <> for <span className="mono">{run.row.source_name}</span></> : null}, {run.ageMinutes} minute{run.ageMinutes === 1 ? '' : 's'} ago, with no final status yet.
          This console reads the sheet, not n8n.
        </p>
        <div className="banner-actions">
          <a href={href(`/runs/${run.id}`)}>View run {run.id}</a>
        </div>
      </Banner>
    );
  }

  if (latest && latest.kind === 'failed') {
    const why = explainRun(latest, runs);
    return (
      <Banner tone="red" title={`Run ${latest.id} failed: nothing was published`}>
        <p><strong>{latest.row.error_code || 'No code recorded'}.</strong> {why.meaning}</p>
        <p><strong>Operator:</strong> {why.operator}</p>
        <div className="banner-actions">
          <a href={href(`/runs/${latest.id}`)}>View run {latest.id}</a>
        </div>
      </Banner>
    );
  }

  return null;
}
