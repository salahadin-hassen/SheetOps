import type { ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { LedgerTable } from '../components/LedgerTable';
import { EmptyState, Panel, Stat } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { RunBanner } from '../components/RunBanner';
import { RunStatusPill } from '../components/StatusPill';
import { NOT_IN_SHEET_NOTE } from '../domain/explain';
import { severityCounts } from '../domain/exceptions';
import { formatDate, formatDateTime } from '../domain/format';
import { APPLIED, CHANGE_TYPE, changePct, changeValue, type ConsoleModel } from '../domain/model';
import { headline } from '../domain/review';
import { rowAccounting, STATUS_LABEL, type Run, type Tone } from '../domain/runs';
import { useHref } from '../router';
import type { ChangeRow } from '../types';

export function Overview({ model }: { model: ConsoleModel }) {
  const { runs, latest, lastCommitted, snapshot } = model;
  const applied = lastCommitted
    ? snapshot.tabs.Changes.filter((c) => c.batch_id === lastCommitted.row.batch_id && APPLIED.has(c.disposition))
    : [];

  return (
    <>
      <PageHead title="Overview" lead="The latest run, what needs a decision, and the state of the catalog." />
      <RunBanner model={model} />

      {latest ? <LatestRun run={latest} model={model} /> : (
        <section className="card" aria-label="Latest run">
          <EmptyState title="No committed run yet" icon="sheet">
            The catalog shows the values the sheet started with. No run has written to the Run Log yet.
          </EmptyState>
        </section>
      )}
      {latest && lastCommitted && lastCommitted !== latest ? <LatestRun run={lastCommitted} model={model} committed /> : null}
      {latest && !lastCommitted ? (
        <section className="card" aria-label="Last committed run">
          <EmptyState title="No committed run yet" icon="sheet">
            The catalog has not been changed by SheetOps. It shows the values the sheet started with.
          </EmptyState>
        </section>
      ) : null}

      <NeedsAttention model={model} />

      <div className="grid-2">
        <CatalogHealth model={model} />
        <RecentRuns runs={runs} />
      </div>

      {lastCommitted ? (
        <Panel title={`Applied in run ${lastCommitted.id}`} flush
          sub={`Committed changes only, effective ${formatDate(lastCommitted.row.effective_date)}. Held changes are in Review.`}
          aside={<OverviewLink path="/changes">Change history</OverviewLink>}>
          <LedgerTable<ChangeRow>
            caption={`Changes applied by run ${lastCommitted.id}, effective ${formatDate(lastCommitted.row.effective_date)}`}
            rows={applied}
            rowKey={(c) => c.event_id}
            columns={[
              { header: 'SKU', rowHeader: true, cell: (c) => <span className="mono nowrap">{c.sku}</span> },
              { header: 'Change', cell: (c) => CHANGE_TYPE[c.change_type] ?? c.change_type },
              { header: 'Before → after', cell: (c) => <BeforeAfter row={c} /> },
              { header: 'Change %', align: 'right', cell: (c) => <span className="num">{changePct(c)}</span> },
            ]}
            empty={<EmptyState title="No changes applied" level={3}>This run applied no changes to the catalog.</EmptyState>}
          />
        </Panel>
      ) : null}
    </>
  );
}

export function BeforeAfter({ row }: { row: ChangeRow }) {
  return (
    <span className="change-arrow num">
      <span className="old">{changeValue(row, 'old_value')}</span>
      <span className="arrow" aria-label="to">→</span>
      <span>{changeValue(row, 'new_value')}</span>
    </span>
  );
}

function OverviewLink({ path, children }: { path: string; children: ReactNode }) {
  const href = useHref();
  return <a className="small strong" href={href(path)}>{children}</a>;
}

function LatestRun({ run, model, committed = false }: { run: Run; model: ConsoleModel; committed?: boolean }) {
  const href = useHref();
  const { rowsRead, parts } = rowAccounting(run.row);
  const value = (key: string) => parts.find((p) => p.key === key)?.value ?? null;
  const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
  const sum = parts.reduce((n, p) => n + (p.value ?? 0), 0);
  const title = committed ? 'Last committed run' : 'Latest run';
  const accounted = rowsRead !== null && sum === rowsRead;
  return (
    <section className="card run-summary" aria-label={title}>
      <div className="run-summary-head">
        <div>
          <div className="eyebrow">{title}</div>
          <h2 className="run-summary-title">Run {run.id} · {STATUS_LABEL[run.kind].label}</h2>
          <div className="run-summary-meta">
            {run.row.source_name ? <span className="mono">{run.row.source_name}</span> : null}
            {run.row.effective_date ? <span>Effective {formatDate(run.row.effective_date)}</span> : null}
            <span>{run.row.finished_at ? `Finished ${formatDateTime(run.row.finished_at)}` : `Started ${formatDateTime(run.row.started_at)}`}</span>
            <span>{run.row.mode}</span>
          </div>
        </div>
        <div className="page-actions">
          <RunStatusPill run={run} />
          <a className="button" href={href(`/runs/${run.id}`)}>View run <Icon name="arrowRight" size={14} /></a>
        </div>
      </div>
      <div className="stats">
        <Stat label="Rows read" value={rowsRead} note={accounted ? `Every row accounted for: ${rowsRead} read` : undefined} />
        <Stat label="Changes applied" value={num(run.row.changes_applied)} />
        <Stat label="Held for review" value={value('held_review')} />
        <Stat label="Rejected rows" value={value('rejected')} />
        <Stat label="Exceptions" value={num(run.row.exceptions_new)} note={num(run.row.exceptions_new) !== null ? 'new in this run' : undefined} />
      </div>
      {rowsRead === null ? (
        <div className="card-foot">
          {run.kind === 'failed' ? 'A failed run leaves its counts blank in the Run Log: not recorded, not zero.' : 'This row has no counts yet: it shows STARTED.'}
          {model.lastCommitted && model.lastCommitted !== run ? ` The catalog is as run ${model.lastCommitted.id} published it.` : ''}
        </div>
      ) : null}
    </section>
  );
}

interface AttentionItem { key: string; count: number | string; tone: Tone; title: string; sub: ReactNode; path: string; go: string }

function NeedsAttention({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const { review, exceptionBatches, publishing, latest } = model;
  const items: AttentionItem[] = [];
  if (publishing.kind === 'unresolved' || publishing.kind === 'started') {
    const r = publishing.run;
    items.push({ key: 'run', count: '!', tone: publishing.kind === 'unresolved' ? 'violet' : 'blue',
      title: publishing.kind === 'unresolved' ? `Run ${r.id}: outcome unknown` : `Run ${r.id}: started, no result yet`,
      sub: publishing.kind === 'unresolved' ? 'Publishing is paused until a person resolves it.' : 'Do not edit Review in the sheet until it finishes.',
      path: `/runs/${r.id}`, go: 'Investigate' });
  } else if (latest?.kind === 'failed') {
    items.push({ key: 'failed', count: '!', tone: 'red', title: `Run ${latest.id} failed: nothing was published`,
      sub: <span className="mono">{latest.row.error_code}</span>, path: `/runs/${latest.id}`, go: 'View run' });
  }
  const awaiting = review.filter((r) => r.decision === 'PENDING');
  const approved = review.filter((r) => r.decision === 'APPROVED');
  const invalid = review.filter((r) => r.decision === 'INVALID_DECISION');
  if (awaiting.length) items.push({ key: 'awaiting', count: awaiting.length, tone: 'amber',
    title: `${awaiting.length} change${awaiting.length === 1 ? '' : 's'} awaiting a decision`,
    sub: awaiting.map((r) => `${r.row.sku} ${headline(r).toLowerCase()}`).join(' · '), path: '/review', go: 'Review' });
  if (approved.length) items.push({ key: 'approved', count: approved.length, tone: 'blue',
    title: `${approved.length} approval${approved.length === 1 ? '' : 's'} typed in the sheet, not applied yet`,
    sub: `${approved.map((r) => r.row.sku).join(', ')}: the catalog changes only when a later publish applies it.`, path: '/review', go: 'Review' });
  if (invalid.length) items.push({ key: 'invalid', count: invalid.length, tone: 'red',
    title: `${invalid.length} decision${invalid.length === 1 ? '' : 's'} not recognised`,
    sub: `Only APPROVE is a decision. ${invalid.map((r) => r.row.sku).join(', ')} stay held.`, path: '/review', go: 'Review' });
  const ex = exceptionBatches[0];
  if (ex) {
    const c = severityCounts(ex.rows);
    items.push({ key: 'exceptions', count: ex.rows.length, tone: 'neutral',
      title: `${ex.rows.length} exception${ex.rows.length === 1 ? '' : 's'}${ex.run ? ` from run ${ex.run.id}` : ''}`,
      sub: `${c.ERROR} rejected · ${c.REVIEW} held · ${c.INFO} collapsed · ${ex.sourceFile}`, path: '/exceptions', go: 'Exceptions' });
  }

  return (
    <Panel title="Needs attention" flush sub={items.length ? `${items.length} item${items.length === 1 ? '' : 's'}, most urgent first` : undefined}>
      {items.length === 0 ? (
        <EmptyState title="Nothing needs attention" level={3} icon="check">No decisions are waiting and no run has failed.</EmptyState>
      ) : (
        <ul className="attention">
          {items.map((i) => (
            <li key={i.key}>
              <a className="attention-item" href={href(i.path)}>
                <span className={`attention-count tone-${i.tone}`} aria-hidden="true">{i.count}</span>
                <span className="attention-text">
                  <span className="attention-title">{i.title}</span>
                  <span className="attention-sub">{i.sub}</span>
                </span>
                <span className="attention-go"><span className="go-label">{i.go}</span><Icon name="chevronRight" size={14} /></span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CatalogHealth({ model }: { model: ConsoleModel }) {
  const catalog = model.snapshot.tabs.Catalog;
  return (
    <Panel title="Catalog" flush sub="Committed values only" aside={<OverviewLink path="/catalog">Open catalog</OverviewLink>}>
      <div className="stats">
        <Stat label="Products" value={catalog.length} />
        <Stat label="Active" value={catalog.filter((c) => c.status === 'ACTIVE').length} />
        <Stat label="Discontinued" value={catalog.filter((c) => c.status === 'DISCONTINUED').length} />
      </div>
      <div className="stats">
        <Stat label="With a held change" value={catalog.filter((c) => c.pending_review).length} />
        <Stat label="Issues in latest list" value={catalog.filter((c) => c.last_issue).length} />
      </div>
    </Panel>
  );
}

function RecentRuns({ runs }: { runs: Run[] }) {
  const href = useHref();
  return (
    <Panel title="Recent runs" flush sub="Run Log, newest first" aside={runs.length ? <OverviewLink path="/runs">All runs</OverviewLink> : null}>
      <LedgerTable<Run>
        caption="Run Log, newest first"
        rows={runs.slice(0, 5)}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Run', rowHeader: true, cell: (r) => <a href={href(`/runs/${r.id}`)}>Run {r.id}</a> },
          { header: 'Started', cell: (r) => <span className="nowrap">{formatDateTime(r.row.started_at)}</span> },
          { header: 'Status', cell: (r) => <RunStatusPill run={r} /> },
        ]}
        empty={<EmptyState title="No runs recorded" level={3} icon="play">{NOT_IN_SHEET_NOTE}</EmptyState>}
      />
    </Panel>
  );
}
