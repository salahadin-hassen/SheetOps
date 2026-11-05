import type { ReactNode } from 'react';
import { LedgerTable } from '../components/LedgerTable';
import { CollapsiblePanel, EmptyState, Figures, Panel, Stat } from '../components/Panel';
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

      <div className="split">
        <div className="split-main">
          <NeedsAttention model={model} />
          {latest ? <LatestRun run={latest} model={model} /> : (
            <section className="card" aria-label="Latest run">
              <EmptyState title="No committed run yet">
                The catalog shows the values the sheet started with. No run has written to the Run Log yet.
              </EmptyState>
            </section>
          )}
          {latest && lastCommitted && lastCommitted !== latest ? <LatestRun run={lastCommitted} model={model} committed /> : null}
          {latest && !lastCommitted ? (
            <section className="card" aria-label="Last committed run">
              <EmptyState title="No committed run yet">
                The catalog has not been changed by SheetOps. It shows the values the sheet started with.
              </EmptyState>
            </section>
          ) : null}
        </div>
        <div className="split-side">
          <CatalogHealth model={model} />
          <RecentRuns runs={runs} />
        </div>
      </div>

      {lastCommitted ? (
        <CollapsiblePanel title={`Applied in run ${lastCommitted.id}`} flush
          sub={`Committed changes only, effective ${formatDate(lastCommitted.row.effective_date)}. Held changes are in Review.`}>
          <LedgerTable<ChangeRow>
            stack
            caption={`Changes applied by run ${lastCommitted.id}, effective ${formatDate(lastCommitted.row.effective_date)}`}
            rows={applied}
            rowKey={(c) => c.event_id}
            columns={[
              { header: 'SKU', rowHeader: true, phone: 'head', cell: (c) => <span className="mono sku nowrap">{c.sku}</span> },
              { header: 'Change', phone: 'end', cell: (c) => CHANGE_TYPE[c.change_type] ?? c.change_type },
              { header: 'Before → after', phone: 'full', cell: (c) => <BeforeAfter row={c} /> },
              { header: 'Change %', align: 'right', phone: 'metaLabel', cell: (c) => <ChangePct row={c} /> },
            ]}
            empty={<EmptyState title="No changes applied" level={3}>This run applied no changes to the catalog.</EmptyState>}
          />
          <div className="card-foot"><OverviewLink path="/changes">Open change history</OverviewLink></div>
        </CollapsiblePanel>
      ) : null}
    </>
  );
}

/** A change percentage; a blank one is dropped from the phone layout. */
export function ChangePct({ row }: { row: ChangeRow }) {
  const pct = changePct(row);
  return <span className={pct === '—' ? 'blank-value subtle' : 'num'}>{pct}</span>;
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
        <a className="small strong nowrap" href={href(`/runs/${run.id}`)}>View run</a>
      </div>
      {rowsRead === null ? (
        <p className="counts-blank">
          {run.kind === 'failed' ? 'A failed run leaves its counts blank in the Run Log: not recorded, not zero.' : 'This row has no counts yet: it shows STARTED.'}
          {model.lastCommitted && model.lastCommitted !== run ? ` The catalog is as run ${model.lastCommitted.id} published it.` : ''}
        </p>
      ) : (
        <>
          <div className="stats">
            <Stat label="Rows read" value={rowsRead} />
            <Stat label="Changes applied" value={num(run.row.changes_applied)} />
            <Stat label="Held for review" value={value('held_review')} />
            <Stat label="Rejected rows" value={value('rejected')} />
            <Stat label="New exceptions" value={num(run.row.exceptions_new)} />
          </div>
          {accounted ? <div className="card-foot">Every row accounted for: {rowsRead} read</div> : null}
        </>
      )}
    </section>
  );
}

interface AttentionItem { key: string; tone: Tone; title: string; sub: ReactNode; path: string; go: string }

function NeedsAttention({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const { review, exceptionBatches, publishing, latest } = model;
  const items: AttentionItem[] = [];
  const awaiting = review.filter((r) => r.decision === 'PENDING');
  const approved = review.filter((r) => r.decision === 'APPROVED');
  const invalid = review.filter((r) => r.decision === 'INVALID_DECISION');
  if (invalid.length) items.push({ key: 'invalid', tone: 'red',
    title: `${invalid.length} decision${invalid.length === 1 ? '' : 's'} not recognised`,
    sub: `Only APPROVE is a decision. ${invalid.map((r) => r.row.sku).join(', ')} stay held.`, path: '/review', go: 'Review' });
  if (awaiting.length) items.push({ key: 'awaiting', tone: 'amber',
    title: `${awaiting.length} change${awaiting.length === 1 ? '' : 's'} awaiting a decision`,
    sub: awaiting.map((r) => `${r.row.sku} ${headline(r).toLowerCase()}`).join(' · '), path: '/review', go: 'Review' });
  if (approved.length) items.push({ key: 'approved', tone: 'blue',
    title: `${approved.length} approval${approved.length === 1 ? '' : 's'} typed in the sheet, not applied yet`,
    sub: `${approved.map((r) => r.row.sku).join(', ')}: the catalog changes only when a later publish applies it.`, path: '/review', go: 'Review' });
  const ex = exceptionBatches[0];
  if (ex) {
    const c = severityCounts(ex.rows);
    items.push({ key: 'exceptions', tone: 'neutral',
      title: `${ex.rows.length} exception${ex.rows.length === 1 ? '' : 's'}${ex.run ? ` from run ${ex.run.id}` : ''}`,
      sub: `${c.ERROR} rejected · ${c.REVIEW} held · ${c.INFO} collapsed · ${ex.sourceFile}`, path: '/exceptions', go: 'Exceptions' });
  }
  // A run in trouble already has the banner directly above this panel.
  const runInTrouble = publishing.kind === 'unresolved' || publishing.kind === 'started' || latest?.kind === 'failed';

  return (
    <Panel title="Needs attention" flush>
      {items.length === 0 ? (
        <EmptyState title={runInTrouble ? 'Nothing else needs attention' : 'Nothing needs attention'} level={3}>
          {runInTrouble ? 'No decisions or exceptions are waiting.' : 'No decisions are waiting and no run has failed.'}
        </EmptyState>
      ) : (
        <ul className="attention">
          {items.map((i) => (
            <li key={i.key}>
              <a className="attention-item" href={href(i.path)}>
                <span className={`dot attention-mark ${i.tone}`} aria-hidden="true" />
                <span className="attention-text">
                  <span className="attention-title">{i.title}</span>
                  <span className="attention-sub">{i.sub}</span>
                </span>
                <span className="attention-go">{i.go}</span>
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
      <Figures items={[
        ['Products', catalog.length],
        ['Active', catalog.filter((c) => c.status === 'ACTIVE').length],
        ['Discontinued', catalog.filter((c) => c.status === 'DISCONTINUED').length],
        ['With a held change', catalog.filter((c) => c.pending_review).length],
        ['Issues in latest list', catalog.filter((c) => c.last_issue).length],
      ]} />
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
          { header: 'Run', rowHeader: true, cell: (r) => (
            <>
              <a className="nowrap" href={href(`/runs/${r.id}`)}>Run {r.id}</a>
              <div className="cell-sub nowrap">{formatDateTime(r.row.started_at).replace(/ EAT$/, '')}</div>
            </>
          ) },
          { header: 'Status', cell: (r) => <RunStatusPill run={r} /> },
        ]}
        empty={<EmptyState title="No runs recorded" level={3}>{NOT_IN_SHEET_NOTE}</EmptyState>}
      />
    </Panel>
  );
}
