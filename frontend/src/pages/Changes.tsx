import { useState } from 'react';
import { Note } from '../components/Banner';
import { ResultCount, SearchField, SelectField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { LedgerTable } from '../components/LedgerTable';
import { EmptyState } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill, RunStatusPill, StatusText } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { matchesQuery } from '../domain/catalog';
import { changeBatches, DISPOSITION, DISPOSITION_ORDER, dispositionCounts, heldStatus, type ChangeBatch } from '../domain/changes';
import { cellText, formatDate, formatDateTime } from '../domain/format';
import { CHANGE_TYPE, changePct, type ConsoleModel } from '../domain/model';
import { useHref } from '../router';
import type { ChangeRow } from '../types';
import { BeforeAfter, ChangePct } from './Overview';

type DispositionFilter = 'ALL' | (typeof DISPOSITION_ORDER)[number];

/** Applied rows are quiet; anything not in the catalog gets a badge. */
export function Disposition({ value }: { value: string }) {
  const d = DISPOSITION[value] ?? { label: value, tone: 'neutral' as const };
  return value === 'APPLIED' || value === 'APPLIED_AFTER_REVIEW'
    ? <StatusText tone={d.tone}>{d.label}</StatusText>
    : <Pill tone={d.tone}>{d.label}</Pill>;
}

export function Changes({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const batches = changeBatches(model.snapshot, model.runs);
  const [list, setList] = useState<string>(batches[0]?.batchId ?? 'ALL');
  const [query, setQuery] = useState('');
  const [disposition, setDisposition] = useState<DispositionFilter>('ALL');
  const names = new Map(model.snapshot.tabs.Catalog.map((c) => [c.sku, c.name]));
  const productOf = (row: ChangeRow) => names.get(row.sku) ?? '';

  // A list chosen under another scenario may not exist here: fall back to the newest.
  const current = list === 'ALL' || batches.some((b) => b.batchId === list) ? list : batches[0]?.batchId ?? 'ALL';
  const inList = current === 'ALL' ? batches : batches.filter((b) => b.batchId === current);
  const listRows = inList.flatMap((b) => b.rows);
  const counts = dispositionCounts(listRows);
  const keep = (row: ChangeRow) => (disposition === 'ALL' || row.disposition === disposition) && matchesQuery(row.sku, productOf(row), query);
  const shown = inList.map((b) => ({ ...b, rows: b.rows.filter(keep) }));
  const shownCount = shown.reduce((n, b) => n + b.rows.length, 0);

  return (
    <>
      <PageHead title="Change history" lead="Every change SheetOps recorded, grouped by price list. Rows are only ever added, never edited." />

      {batches.length === 0 ? (
        <section className="card" aria-label="Change history">
          <EmptyState title="No changes recorded yet">
            The Changes tab is empty. Rows appear only when a run that changes the catalog, or holds a change for review, is published.
            {model.lastCommitted ? null : ' No SheetOps run has published to this sheet yet.'}
          </EmptyState>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <div className="toolbar-left">
              <SelectField label="Price list" value={current} onChange={setList} options={[
                ...batches.map((b) => ({ value: b.batchId, label: `${formatDate(b.effectiveDate)}${b.run ? ` · run ${b.run.id}` : ''}` })),
                { value: 'ALL', label: 'All lists' },
              ]} />
              <SearchField label="SKU or product" value={query} onChange={setQuery} hint="Filter changes" />
            </div>
          </div>

          <Tabs<DispositionFilter> label="Disposition" value={disposition} onChange={setDisposition} options={[
            { key: 'ALL', label: `All · ${listRows.length}` },
            ...DISPOSITION_ORDER.filter((d) => counts[d]).map((d) => ({ key: d, label: `${DISPOSITION[d].label} · ${counts[d]}` })),
          ]}>
            <div className="toolbar">
              <ResultCount>{`Showing ${shownCount} of ${listRows.length} changes`}</ResultCount>
              <details className="disclosure bare legend-disclosure">
                <summary><Icon name="chevronRight" size={13} />What the dispositions mean</summary>
                <dl className="deflist" aria-label="Dispositions">
                  {DISPOSITION_ORDER.map((d) => (
                    <div key={d} className="contents"><dt>{DISPOSITION[d].label}</dt><dd>{DISPOSITION[d].meaning}</dd></div>
                  ))}
                </dl>
              </details>
            </div>
            {shownCount === 0 ? (
              <section className="card" aria-label="No matching changes">
                <EmptyState title="No changes match" level={2}>Clear the search or choose another disposition or list.</EmptyState>
              </section>
            ) : shown.filter((b) => b.rows.length > 0).map((b) => (
              <BatchSection key={b.batchId} batch={b} total={batches.find((x) => x.batchId === b.batchId)!.rows} productOf={productOf} model={model} />
            ))}
          </Tabs>

          <Note>
            An approval alone never appears here: a row exists only if the publish that wrote it was committed, because history,
            catalog and run status are written in one request. Source rows that were rejected are not changes; they are listed
            in <a href={href('/exceptions')}>Exceptions</a>.
          </Note>
        </>
      )}
    </>
  );
}

function BatchSection({ batch, total, productOf, model }: {
  batch: ChangeBatch;
  total: ChangeRow[];
  productOf: (row: ChangeRow) => string;
  model: ConsoleModel;
}) {
  const href = useHref();
  const title = `${formatDate(batch.effectiveDate)} list${batch.run ? ` · run ${batch.run.id}` : ''}`;
  const c = dispositionCounts(total);
  const summary = DISPOSITION_ORDER.filter((d) => c[d]).map((d) => `${c[d]} ${DISPOSITION[d].label.toLowerCase()}`).join(', ');
  const headingId = `hist-${batch.batchId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <section className="card" aria-labelledby={headingId}>
      <div className="card-head">
        <div className="minw-0">
          <h2 id={headingId}>{title}</h2>
          <div className="card-sub mono-wrap">
            {batch.run ? <><span className="mono">{batch.run.row.source_name}</span> · published {formatDateTime(batch.run.row.finished_at)} · </> : null}
            batch <span className="mono">{batch.batchId}</span>
          </div>
        </div>
        <div className="page-actions">
          {batch.run ? <RunStatusPill run={batch.run} /> : null}
          {batch.run ? <a className="small strong nowrap" href={href(`/runs/${batch.run.id}`)}>Run details</a> : null}
        </div>
      </div>
      <LedgerTable<ChangeRow>
        stack
        caption={title}
        rows={batch.rows}
        rowKey={(r) => r.event_id}
        expandLabel={(r) => `${r.sku} ${CHANGE_TYPE[r.change_type] ?? r.change_type}`}
        columns={[
          { header: 'SKU', rowHeader: true, phone: 'head', cell: (r) => <span className="mono sku nowrap">{r.sku}</span> },
          { header: 'Product', phone: 'full', cell: (r) => productOf(r) || <span className="subtle">—</span> },
          { header: 'Change', phone: 'meta', cell: (r) => CHANGE_TYPE[r.change_type] ?? r.change_type },
          { header: 'Disposition', phone: 'end', cell: (r) => <Disposition value={r.disposition} /> },
          { header: 'Before → after', phone: 'full', cell: (r) => <BeforeAfter row={r} /> },
          { header: 'Change %', align: 'right', phone: 'meta', hideMedium: true, cell: (r) => <ChangePct row={r} /> },
        ]}
        expand={(r) => (
          <dl className="inline-dl">
            <dt>Event ID</dt><dd className="mono">{r.event_id}</dd>
            {r.review_id ? <><dt>Review ID</dt><dd className="mono">{r.review_id}</dd></> : null}
            <dt>Effective date</dt><dd>{formatDate(r.effective_date)}</dd>
            <dt>Change %</dt><dd className="num">{changePct(r)}</dd>
            <dt>Note</dt><dd>{cellText(r.note) || <span className="subtle">None</span>}</dd>
            {r.disposition === 'HELD_FOR_REVIEW' ? (
              <><dt>Where it is now</dt><dd>{heldStatus(r, model.snapshot)} <a href={href(`/review/${encodeURIComponent(r.sku)}`)}>Open in Review</a></dd></>
            ) : null}
          </dl>
        )}
      />
      <div className="card-foot">
        {total.length} row{total.length === 1 ? '' : 's'}: {summary}. In the order written to the Changes tab (by SKU, then change type). Prices in ETB.
      </div>
    </section>
  );
}
