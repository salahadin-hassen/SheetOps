import { useState } from 'react';
import { LedgerTable } from '../components/LedgerTable';
import { CollapsiblePanel, DefinitionList, EmptyState, Panel } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { StageLegend, StageTrack } from '../components/StageTrack';
import { RunStatusPill } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { Note } from '../components/Banner';
import { explainRun, NOT_IN_SHEET_NOTE } from '../domain/explain';
import { formatDate, formatDateTime, isBlank } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { committedRunOfBatch, rowAccounting, runOutcomes, stagesFor, STATUS_LABEL, type Count, type Run, type RunKind } from '../domain/runs';
import { useHref } from '../router';
import type { Cell } from '../types';

/** A count column: blank in the sheet means not recorded, never zero. */
function RunCount({ value }: { value: Cell }) {
  return isBlank(value)
    ? <span className="subtle"><span aria-hidden="true">—</span><span className="visually-hidden">not recorded</span></span>
    : <span className="num">{String(value)}</span>;
}

export function RunsList({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const [filter, setFilter] = useState<RunKind | 'ALL'>('ALL');
  // Tabs for the states this Run Log holds, in the order they first appear.
  const kinds = [...new Set(model.runs.map((r) => r.kind))];
  const current = filter === 'ALL' || kinds.includes(filter) ? filter : 'ALL';
  const visible = current === 'ALL' ? model.runs : model.runs.filter((r) => r.kind === current);
  const table = (
    <section className="card" aria-labelledby="runlog-title">
      <div className="card-head">
        <div>
          <h2 id="runlog-title">Run Log</h2>
          <div className="card-sub">{model.runs.length} run{model.runs.length === 1 ? '' : 's'} recorded in the sheet, newest first</div>
        </div>
      </div>
      <LedgerTable<Run>
        stack
        caption="All runs recorded in the sheet"
        rows={visible}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Run', rowHeader: true, phone: 'head', cell: (r) => <a className="nowrap" href={href(`/runs/${r.id}`)}>Run {r.id}</a> },
          { header: 'Status', phone: 'end', cell: (r) => (
            <>
              <RunStatusPill run={r} />
              {r.row.error_code ? <div className="cell-sub mono mono-wrap">{r.row.error_code}</div> : null}
            </>
          ) },
          { header: 'Started', phone: 'full', cell: (r) => (
            <>
              <span className="nowrap">{formatDateTime(r.row.started_at)}</span>
              <div className="cell-sub">{r.row.mode}</div>
            </>
          ) },
          { header: 'File', phone: 'full', cell: (r) => r.row.source_name ? <span className="mono mono-wrap">{r.row.source_name}</span> : <span className="subtle">—</span> },
          { header: 'Applied', align: 'right', phone: 'metaLabel', cell: (r) => <RunCount value={r.row.changes_applied} /> },
          { header: 'Held', align: 'right', phone: 'metaLabel', cell: (r) => <RunCount value={r.row.held_review} /> },
          { header: 'Exceptions', align: 'right', phone: 'metaLabel', cell: (r) => <RunCount value={r.row.exceptions_new} /> },
        ]}
        empty={<EmptyState title="No runs recorded" level={3}>The Run Log is empty: no run has written to this sheet yet.</EmptyState>}
      />
      {model.runs.some((r) => isBlank(r.row.changes_applied)) ? (
        <div className="card-foot">A dash means the Run Log leaves that count blank: not recorded, not zero.</div>
      ) : null}
    </section>
  );
  return (
    <>
      <PageHead title="Runs" lead="Every row of the Run Log. One row per run." />
      {kinds.length > 1 ? (
        <Tabs<RunKind | 'ALL'> label="Status" value={current} onChange={setFilter} options={[
          { key: 'ALL', label: `All · ${model.runs.length}` },
          ...kinds.map((k) => ({ key: k, label: `${STATUS_LABEL[k].label} · ${model.runs.filter((r) => r.kind === k).length}` })),
        ]}>
          {table}
        </Tabs>
      ) : table}
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
          <EmptyState title="This run is not in the Run Log">
            The sheet has no row for run {runId} in this scenario. <a href={href('/runs')}>See all runs</a>.
          </EmptyState>
        </section>
      </>
    );
  }

  const why = explainRun(run, model.runs);
  const { row } = run;
  const stages = stagesFor(run);
  const committedSame = committedRunOfBatch(run, model.runs);
  const reviewChanged = run.kind === 'failed' && (row.error_code === 'REVIEW_CHANGED' || row.error_code === 'REVIEW_READ_FAILED');
  // Decisions typed since the last publish wrote Review: what the sheet shows now.
  const editedItems = reviewChanged ? model.review.filter((i) => i.decidedSinceLastPublish) : [];

  return (
    <>
      <PageHead title={`Run ${run.id}`} lead={why.title}
        eyebrow={<><a href={href('/runs')}>Runs</a> <span aria-hidden="true">/</span> {formatDateTime(row.started_at)} · {row.mode}</>}>
        <RunStatusPill run={run} />
      </PageHead>

      <div className="split">
        <div className="split-main">
          <Panel title={run.committed ? 'Processing stages' : 'Where it stopped'} sub="Only what the sheet shows" labelledBy="stages-title">
            <StageTrack stages={stages} label={`Run ${run.id} stages`} />
            <StageLegend stages={stages} />
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

          <Panel title="Publication outcome">
            {row.error_code || row.error_message ? (
              <div className="error-record">
                <span className="code">{row.error_code}</span>
                <p>{row.error_message}</p>
              </div>
            ) : run.kind === 'unresolved' ? (
              <p className="small muted">No error is recorded: the row still shows STARTED. The sheet has no evidence of a failure.</p>
            ) : null}
            {reviewChanged ? (
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
            ) : (
              <p className="small">{publicationLine(run)}</p>
            )}
          </Panel>

          <ProcessingStatistics run={run} />
        </div>

        <div className="split-side">
          <CollapsiblePanel title="Source file">
            <DefinitionList items={[
              ['File', row.source_name ? <span className="mono">{row.source_name}</span> : ''],
              ['Drive file ID', row.source_file_id ? <span className="mono">{row.source_file_id}</span> : ''],
              ['Batch version', row.batch_id ? <span className="mono">{row.batch_id}</span> : ''],
              ['Effective date', row.effective_date ? formatDate(row.effective_date) : ''],
              ['Modified in Drive', row.source_modified_at ? formatDateTime(row.source_modified_at) : ''],
            ]} />
          </CollapsiblePanel>
          <CollapsiblePanel title="Run record">
            <DefinitionList items={[
              ['Mode', row.mode],
              ['Started', formatDateTime(row.started_at)],
              ['Finished', row.finished_at ? formatDateTime(row.finished_at) : ''],
              ['Status in the sheet', <span className="mono">{row.status}</span>],
              ['Same list committed by', committedSame ? <a href={href(`/runs/${committedSame.id}`)}>Run {committedSame.id}</a> : ''],
            ]} />
          </CollapsiblePanel>
        </div>
      </div>
    </>
  );
}

/**
 * Recorded counts as tables; blank counts as one line that names them, rather
 * than a table of repeated "Not recorded". Blank still never reads as zero.
 */
function ProcessingStatistics({ run }: { run: Run }) {
  const { rowsRead, parts } = rowAccounting(run.row);
  const accounting: Count[] = [...parts, { key: 'rows_read', label: 'Rows read', value: rowsRead }];
  const outcomes = runOutcomes(run.row);
  const recordedRows = accounting.filter((c) => c.value !== null);
  const recordedOutcomes = outcomes.filter((c) => c.value !== null);
  const blank = [...accounting, ...outcomes].filter((c) => c.value === null);
  const why = run.kind === 'failed' ? 'A failed run leaves its counts blank' : 'This row has no counts yet';
  const table = (caption: string, rows: Count[]) => (
    <LedgerTable<Count>
      caption={caption}
      rows={rows}
      rowKey={(c) => c.key}
      rowClass={(c) => (c.key === 'rows_read' ? 'highlight' : undefined)}
      columns={[
        { header: 'Count', rowHeader: true, cell: (c) => c.label },
        { header: 'Value', align: 'right', cell: (c) => <span className="num strong">{c.value}</span> },
      ]}
    />
  );
  return (
    <Panel title="Processing statistics" flush sub={blank.length === 0 ? 'As written in the Run Log' : undefined}>
      {recordedRows.length > 0 ? (
        <div className="stats-tables">
          {table(`Run ${run.id} row accounting, as written in the Run Log`, recordedRows)}
          {recordedOutcomes.length > 0 ? table(`Run ${run.id} outcomes, as written in the Run Log`, recordedOutcomes) : null}
        </div>
      ) : recordedOutcomes.length > 0 ? table(`Run ${run.id} counts, as written in the Run Log`, recordedOutcomes) : null}
      {blank.length > 0 ? (
        <p className="recorded-blank">
          <strong>{blank.length} counts not recorded:</strong> {blank.map((c) => c.label).join(', ')}. {why}; blank means not recorded, not zero.
        </p>
      ) : null}
    </Panel>
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
