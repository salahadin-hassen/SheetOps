import { LedgerTable } from '../components/LedgerTable';
import { DefinitionList, EmptyState, Panel } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { StageLegend, StageTrack } from '../components/StageTrack';
import { RunStatusPill } from '../components/StatusPill';
import { Banner, Note } from '../components/Banner';
import { explainRun, NOT_IN_SHEET_NOTE } from '../domain/explain';
import { formatDate, formatDateTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { committedRunOfBatch, rowAccounting, runOutcomes, stagesFor, STATUS_LABEL, type Run } from '../domain/runs';
import { useHref } from '../router';

export function RunsList({ model }: { model: ConsoleModel }) {
  const href = useHref();
  return (
    <>
      <PageHead title="Runs" lead="Every row of the Run Log, newest first. One row per run." />
      <Panel title="Run Log" flush sub={`${model.runs.length} run${model.runs.length === 1 ? '' : 's'} recorded in the sheet`}>
        <LedgerTable<Run>
          stack
          caption="All runs recorded in the sheet"
          rows={model.runs}
          rowKey={(r) => r.id}
          columns={[
            { header: 'Run', rowHeader: true, cell: (r) => <a href={href(`/runs/${r.id}`)}>Run {r.id}</a> },
            { header: 'Status', cell: (r) => <RunStatusPill run={r} /> },
            { header: 'Started', cell: (r) => <span className="nowrap">{formatDateTime(r.row.started_at)}</span> },
            { header: 'Mode', cell: (r) => <span className="nowrap">{r.row.mode}</span> },
            { header: 'File', cell: (r) => r.row.source_name ? <span className="mono nowrap">{r.row.source_name}</span> : <span className="subtle">—</span> },
            { header: 'Code', cell: (r) => r.row.error_code ? <span className="mono nowrap">{r.row.error_code}</span> : <span className="subtle">—</span> },
          ]}
          empty={<EmptyState title="No runs recorded" level={3} icon="play">The Run Log is empty: no run has written to this sheet yet.</EmptyState>}
        />
      </Panel>
      <Note>{NOT_IN_SHEET_NOTE}</Note>
    </>
  );
}

export function RunDetails({ model, runId }: { model: ConsoleModel; runId: string }) {
  const href = useHref();
  const run = model.runs.find((r) => r.id === runId);
  if (!run) {
    return (
      <>
        <PageHead title={`Run ${runId}`} eyebrow={<a href={href('/runs')}>Runs</a>} />
        <section className="card" aria-label="Run not found">
          <EmptyState title="This run is not in the Run Log" icon="search">
            The sheet has no row for run {runId} in this scenario. <a href={href('/runs')}>See all runs</a>.
          </EmptyState>
        </section>
      </>
    );
  }

  const why = explainRun(run, model.runs);
  const { row } = run;
  const { rowsRead, parts } = rowAccounting(row);
  const outcomes = runOutcomes(row);
  const committedSame = committedRunOfBatch(run, model.runs);
  const tone = STATUS_LABEL[run.kind].tone;
  const reviewChanged = run.kind === 'failed' && (row.error_code === 'REVIEW_CHANGED' || row.error_code === 'REVIEW_READ_FAILED');
  // Decisions typed since the last publish wrote Review: what the sheet shows now.
  const editedItems = reviewChanged ? model.review.filter((i) => i.decidedSinceLastPublish) : [];

  return (
    <>
      <PageHead title={`Run ${run.id}`} lead={why.title}
        eyebrow={<><a href={href('/runs')}>Runs</a> <span aria-hidden="true">/</span> {formatDateTime(row.started_at)} · {row.mode}</>}>
        <RunStatusPill run={run} />
      </PageHead>

      <Panel title="Where it stopped" sub="Only what the sheet shows" labelledBy="stages-title">
        <StageTrack stages={stagesFor(run)} label={`Run ${run.id} stages`} />
        <StageLegend />
        <div className="grid-2 explain-grid">
          <div>
            <h3 className="section-title">What happened</h3>
            <p className="small muted">{why.meaning}</p>
          </div>
          <div>
            <h3 className="section-title">What to do</h3>
            <p className="small muted"><strong className="visually-hidden">Operator: </strong>{why.operator}</p>
          </div>
        </div>
      </Panel>

      {run.kind === 'failed' || run.kind === 'unresolved' || run.kind === 'blocked' || run.kind === 'rejected' || run.kind === 'halted' ? (
        <Banner tone={tone} title={run.kind === 'unresolved' ? 'No final status recorded' : 'Recorded error'}>
          {row.error_code || row.error_message ? (
            <DefinitionList items={[
              ['Code', <span className="mono">{row.error_code}</span>],
              ['Message, as written', row.error_message],
            ]} />
          ) : (
            <p>No error is recorded: the row still shows STARTED. The sheet has no evidence of a failure.</p>
          )}
        </Banner>
      ) : null}

      {reviewChanged ? (
        <Panel title="Publication outcome">
          <DefinitionList items={[
            ['Publish request', 'Not sent. The final Review check stopped the run before the publish.'],
            ['Catalog, Review, history', committedSame
              ? `Unchanged by run ${run.id}: they are as run ${committedSame.id} published them.`
              : `Unchanged by run ${run.id}.`],
            ['Operator’s edit', editedItems.length > 0
              ? <>Kept in the sheet: {editedItems.map((i, n) => (
                <span key={i.row.review_id}>{n > 0 ? ', ' : ''}<a href={href(`/review/${encodeURIComponent(i.row.sku)}`)}>{i.row.sku}</a> decision <span className="mono">{String(i.row.decision) || '(empty)'}</span></span>
              ))}. Not applied: no committed run has processed it.</>
              : 'Kept in the sheet, untouched.'],
            ['Run Log row', 'FAILED, written after re-reading this run’s own row. Counts are not recorded for a failed run.'],
          ]} />
        </Panel>
      ) : (
        <Panel title="Publication outcome">
          <p className="small">{publicationLine(run)}</p>
        </Panel>
      )}

      <div className="grid-2">
        <Panel title="Source file">
          <DefinitionList items={[
            ['File', row.source_name ? <span className="mono">{row.source_name}</span> : ''],
            ['Drive file ID', row.source_file_id ? <span className="mono">{row.source_file_id}</span> : ''],
            ['Batch version', row.batch_id ? <span className="mono">{row.batch_id}</span> : ''],
            ['Effective date', row.effective_date ? formatDate(row.effective_date) : ''],
            ['Modified in Drive', row.source_modified_at ? formatDateTime(row.source_modified_at) : ''],
          ]} />
        </Panel>
        <Panel title="Run">
          <DefinitionList items={[
            ['Mode', row.mode],
            ['Started', formatDateTime(row.started_at)],
            ['Finished', row.finished_at ? formatDateTime(row.finished_at) : ''],
            ['Status in the sheet', <span className="mono">{row.status}</span>],
            ['Same list committed by', committedSame ? <a href={href(`/runs/${committedSame.id}`)}>Run {committedSame.id}</a> : ''],
          ]} />
        </Panel>
      </div>

      <Panel title="Processing statistics" flush
        sub={rowsRead === null
          ? `Not recorded. ${run.kind === 'failed' ? 'A failed run leaves its counts blank' : 'This row has no counts yet'}; blank means not recorded, not zero.`
          : 'As written in the Run Log'}>
        <LedgerTable
          caption={`Run ${run.id} counts, as written in the Run Log`}
          rows={[...parts, { key: 'rows_read' as const, label: 'Rows read', value: rowsRead }, ...outcomes]}
          rowKey={(p) => p.key}
          rowClass={(p) => (p.key === 'rows_read' ? 'highlight' : undefined)}
          columns={[
            { header: 'Count', rowHeader: true, cell: (p) => p.label },
            { header: 'Value', align: 'right', cell: (p) => (p.value === null ? <span className="subtle">Not recorded</span> : <span className="num strong">{p.value}</span>) },
          ]}
        />
      </Panel>
    </>
  );
}

function publicationLine(run: Run): string {
  switch (run.kind) {
    case 'published':
    case 'published_exceptions':
      return 'Applied. The publish request committed the catalog, Review, history, exceptions and this row together.';
    case 'started':
      return 'No result yet. The row shows STARTED; the sheet has no record of the publish.';
    case 'unresolved':
      return 'Unknown. The row still shows STARTED, so the sheet cannot show whether the publish was applied.';
    case 'failed':
      return run.row.error_code === 'PUBLISH_REJECTED'
        ? 'Refused by Google. Nothing from the request was applied.'
        : 'Not sent. The run failed before the publish; nothing was applied.';
    case 'rejected':
      return 'The rejection and its exceptions were recorded. The catalog was not changed.';
    case 'halted':
      return 'The halt and one exception were recorded. The catalog was not changed.';
    case 'blocked':
      return 'Only the run row was written. Nothing was processed.';
    case 'superseded':
      return 'Replaced by a later run of the same batch.';
    default:
      return 'Not known from the sheet.';
  }
}
