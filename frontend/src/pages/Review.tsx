import { useEffect, useRef, useState } from 'react';
import { Banner, Note } from '../components/Banner';
import { Icon } from '../components/Icon';
import { DefinitionList, EmptyState } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { formatDate, formatPct, formatPrice, formatTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { compare, DECISION_CHIP, headline, REASON_TEXT, type DecisionState, type ReviewItem } from '../domain/review';
import { committedRunOfBatch, type Run } from '../domain/runs';
import { useHref } from '../router';

type Filter = 'PENDING' | 'APPROVED' | 'INVALID_DECISION' | 'ALL';

const NOT_LOCKED = 'This console has no decision controls, so it cannot pause or lock anything; the Google Sheet itself is not locked.';

export function Review({ model, sku }: { model: ConsoleModel; sku: string | null }) {
  const href = useHref();
  const items = model.review;
  const count = (d: DecisionState) => items.filter((i) => i.decision === d).length;
  const routed = sku ? items.find((i) => i.row.sku === sku) ?? null : null;
  const [filter, setFilter] = useState<Filter>(() => (routed && routed.decision !== 'PENDING' ? 'ALL' : 'PENDING'));
  // Following a link to an item outside the current filter widens the filter
  // once; after that the operator's own filter choice stands. The initial
  // state above already covers the item linked on arrival, so the effect acts
  // only when the linked item changes. (Acting on mount too would race a
  // filter change made before the mount effect flushed, and undo it.)
  const routedId = routed?.row.review_id;
  const previousRoutedId = useRef(routedId);
  useEffect(() => {
    if (routedId === previousRoutedId.current) return;
    previousRoutedId.current = routedId;
    if (!routed) return;
    setFilter((f) => (f !== 'ALL' && routed.decision !== f ? 'ALL' : f));
  }, [routedId, routed]);
  const visible = filter === 'ALL' ? items : items.filter((i) => i.decision === filter);
  const selected = routed && visible.includes(routed) ? routed : visible[0] ?? null;

  const options = [
    { key: 'PENDING' as const, label: `Awaiting decision · ${count('PENDING')}` },
    { key: 'APPROVED' as const, label: `Approved · ${count('APPROVED')}` },
    ...(count('INVALID_DECISION') > 0 ? [{ key: 'INVALID_DECISION' as const, label: `Not recognised · ${count('INVALID_DECISION')}` }] : []),
    { key: 'ALL' as const, label: `All · ${items.length}` },
  ];

  return (
    <>
      <PageHead title="Review" lead="Changes the supplier proposed that need a person before they reach the catalog." />

      <Note icon="lock">
        <strong>Read-only.</strong> Decisions are made in the Google Sheet: type <strong>APPROVE</strong> in the
        decision column of the Review tab. This console shows what the sheet holds and never writes to it.
      </Note>

      <ReviewStateBanner model={model} />

      {items.length === 0 ? (
        <section className="card" aria-label="Review">
          <EmptyState title="Nothing is held for review" icon="check">
            {model.lastCommitted
              ? 'The Review tab is empty: no change is waiting for a person.'
              : 'No run has published yet, so the Review tab is still empty.'}
          </EmptyState>
        </section>
      ) : (
        <Tabs label="Filter" options={options} value={filter} onChange={setFilter}>
          {visible.length === 0 ? (
            <section className="card" aria-label="No items"><EmptyState title="No items in this list" level={2} icon="search">Choose another filter to see the other items.</EmptyState></section>
          ) : (
            <div className="review-layout">
              <ul className="card review-list" aria-label="Held changes">
                {visible.map((item) => (
                  <li key={item.row.review_id}>
                    <a className="review-link" href={href(`/review/${encodeURIComponent(item.row.sku)}`)}
                      aria-current={item === selected ? 'true' : undefined}>
                      <span className="row1">
                        <span className="mono xsmall muted">{item.row.sku}</span>
                        <span className="what">{headline(item)}</span>
                      </span>
                      <span className="name">{item.row.current_name || item.row.proposed_name}</span>
                      <span className="state"><span className={`dot ${DECISION_CHIP[item.decision].tone}`} aria-hidden="true" />{DECISION_CHIP[item.decision].label}</span>
                    </a>
                  </li>
                ))}
              </ul>
              {selected ? <ReviewDetail item={selected} model={model} /> : null}
            </div>
          )}
        </Tabs>
      )}
    </>
  );
}

function activeRun(model: ConsoleModel): Run | null {
  const p = model.publishing;
  return p.kind === 'started' || p.kind === 'unresolved' ? p.run : null;
}

function ReviewStateBanner({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const active = activeRun(model);
  if (active) {
    const unresolved = active.kind === 'unresolved';
    return (
      <Banner tone={unresolved ? 'violet' : 'blue'} title={unresolved
        ? `Run ${active.id}'s outcome is unknown: do not edit Review in the sheet`
        : `Run ${active.id} has started and has no result yet: do not edit Review in the sheet`}>
        <p>
          Run {active.id}&rsquo;s Run Log row shows STARTED, written at {formatTime(active.row.started_at)}, {active.ageMinutes} minutes
          before this read. A publish rewrites the Review tab, so a decision saved now could be overwritten (contract §8).
        </p>
        <p>
          {NOT_LOCKED} If Review is edited there before run {active.id} sends its publish, the run publishes nothing and
          ends FAILED (REVIEW_CHANGED); an edit in the last seconds before Google applies the publish can still be lost.
        </p>
        <div className="banner-actions"><a href={href(`/runs/${active.id}`)}>View run {active.id}</a></div>
      </Banner>
    );
  }
  const latest = model.latest;
  if (latest && latest.kind === 'failed' && (latest.row.error_code === 'REVIEW_CHANGED' || latest.row.error_code === 'REVIEW_READ_FAILED')) {
    const committed = committedRunOfBatch(latest, model.runs);
    const edited = model.review.filter((i) => i.decidedSinceLastPublish);
    return (
      <Banner tone="red" title={`Run ${latest.id} published nothing: ${latest.row.error_code === 'REVIEW_CHANGED' ? 'Review changed during the run' : 'the final Review read failed'}`}>
        <p>
          The final Review check stopped run {latest.id} before its publish, so the run is FAILED with{' '}
          <span className="mono">{latest.row.error_code}</span> and nothing was applied.
          {edited.length > 0 ? <> The decision typed in the sheet is kept: {edited.map((i) => `${i.row.sku} ${String(i.row.decision)}`).join(', ')}. It is not applied yet.</> : ' The Review tab is as the operator left it.'}
        </p>
        <p>
          <strong>Operator:</strong> process the list again so it plans from the current decisions.
          {committed ? ` This list was already committed by run ${committed.id}, so a scheduled run will not process it again: start a manual reprocess.` : ' The next scheduled run processes it again.'}
          {' '}This console cannot start a run.
        </p>
        <div className="banner-actions"><a href={href(`/runs/${latest.id}`)}>View run {latest.id}</a></div>
      </Banner>
    );
  }
  return null;
}

function ReviewDetail({ item, model }: { item: ReviewItem; model: ConsoleModel }) {
  const r = item.row;
  const chip = DECISION_CHIP[item.decision];
  const proposedIn = model.runs.find((run) => run.row.batch_id === item.batchId);
  const lastWriter = model.lastCommitted;
  const rows = compare(item);
  const price = item.reasons.includes('LARGE_PRICE_CHANGE');
  const kept = price ? formatPrice(r.current_price)
    : item.reasons.includes('UNIT_CHANGED') ? `unit ${r.current_unit}` : `the name “${r.current_name}”`;
  const proposed = price ? formatPrice(r.proposed_price)
    : item.reasons.includes('UNIT_CHANGED') ? `unit ${r.proposed_unit}` : `the name “${r.proposed_name}”`;
  const priceRow = rows[2];

  return (
    <article className="card review-detail" aria-labelledby="item-title">
      <div className="card-body">
        <div className="detail-head">
          <div>
            <span className="mono xsmall muted">{r.sku}</span>
            <h2 id="item-title">{r.current_name || r.proposed_name}</h2>
          </div>
          <span className="badge-row">
            <Pill tone={chip.tone} icon={item.decision === 'PENDING' ? 'pause' : item.decision === 'APPROVED' ? 'check' : 'cross'}>{chip.label}</Pill>
            <Pill tone="neutral" icon="lock">Read-only</Pill>
          </span>
        </div>

        {item.decidedSinceLastPublish ? (
          <div className="callout tone-blue">
            <strong>Typed in the sheet after the last publish.</strong> The decision cell says{' '}
            <span className="mono">{String(r.decision) || '(empty)'}</span>, but the status column still says{' '}
            <span className="mono">{r.status}</span>{lastWriter ? `, as run ${lastWriter.id} wrote it` : ''}.
            Nothing has been applied: the catalog keeps {kept} until a later publish processes this decision.
          </div>
        ) : null}

        <div className="callout tone-amber">
          <strong>Why it is held:</strong>{' '}
          {item.reasons.map((reason) => REASON_TEXT[reason] ?? reason).join(', ')}.
          {price ? ` The price changes by ${formatPct(r.change_pct)}; any change of 25% or more needs a person.` : ' A unit or name change always needs a person.'}
        </div>

        <div className="compare" role="group" aria-label="Current catalog compared with the supplier's proposal">
          <div className="compare-col">
            <div className="compare-label">In the catalog now</div>
            <dl>
              {rows.map((c) => <div key={c.field} className="contents"><dt>{c.field}</dt><dd>{c.current}</dd></div>)}
            </dl>
          </div>
          <div className="compare-col">
            <div className="compare-label"><Icon name="pause" size={12} />Proposed by the supplier · not applied</div>
            <dl>
              {rows.map((c) => (
                <div key={c.field} className="contents">
                  <dt>{c.field}</dt>
                  <dd className={c.changed ? 'changed' : undefined}>
                    {c.proposed}
                    {c.changed && c === priceRow ? <span className="subtle"> ({c.difference})</span> : null}
                    {c.changed ? <span className="visually-hidden"> (changed)</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div>
          <h3 className="section-title mb-2">In the Review tab</h3>
          <DefinitionList items={[
            ['Decision cell', String(r.decision) === '' ? <span className="subtle">Empty</span> : <span className="mono">{String(r.decision)}</span>],
            ['Note cell', String(r.note) === '' ? <span className="subtle">Empty</span> : String(r.note)],
            ['Status column', <span className="mono">{r.status}</span>],
            ['Proposed in', <><span className="mono">{proposedIn?.row.source_name || item.batchId}</span>{r.source_row !== '' ? `, row ${r.source_row}` : ''}</>],
            ['First and last seen', `${formatDate(r.first_seen)} · ${formatDate(r.last_seen)}`],
            ['Review ID', <span className="mono">{r.review_id}</span>],
          ]} />
        </div>

        <section aria-labelledby="consequence-title">
          <h3 id="consequence-title" className="section-title mb-2">If it is approved in the sheet</h3>
          <ol className="steps">
            <li>The Review tab records APPROVE and the note. Nothing in the catalog changes yet.</li>
            <li>The next processed price list that still proposes {proposed} applies it, or a manual reprocess of the latest list does.</li>
            <li>The change history records it as applied after review, with the note.</li>
            <li>If a later list proposes something different, this item is superseded and comes back for a new decision.</li>
          </ol>
          <p className="small muted mt-2">Not approving keeps {kept}. There is no reject action in v1; the item stays held.</p>
        </section>

        <p className="detail-foot">
          {NOT_LOCKED} If a decision or note changes after a run has read Review, SheetOps publishes nothing and records
          REVIEW_CHANGED. An edit saved in the last seconds before Google applies a publish can still be lost: the item then
          shows its earlier decision, nothing is applied, and the operator types it again.
        </p>
      </div>
    </article>
  );
}
