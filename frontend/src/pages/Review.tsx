import { useContext, useEffect, useRef, useState } from 'react';
import { Banner } from '../components/Banner';
import { Icon } from '../components/Icon';
import { Disclosure, DefinitionList, EmptyState } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { SINGLE_COLUMN, useMedia } from '../components/useMedia';
import { formatDate, formatPct, formatPrice, formatTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { compare, DECISION_CHIP, headline, REASON_TEXT, type DecisionState, type ReviewItem } from '../domain/review';
import { committedRunOfBatch, type Run } from '../domain/runs';
import { NavigatedContext, useHref } from '../router';

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

  // Where list and detail are separate views the link that was followed is gone,
  // so focus goes to the record, and back to its link on return.
  const singleColumn = useMedia(SINGLE_COLUMN);
  const navigated = useContext(NavigatedContext);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastRouted = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastRouted.current;
    lastRouted.current = routed?.row.sku ?? null;
    if (!navigated || !singleColumn) return;
    if (routed) titleRef.current?.focus();
    else if (previous) listRef.current?.querySelector<HTMLElement>(`[data-sku="${CSS.escape(previous)}"]`)?.focus();
  }, [routed, navigated, singleColumn]);

  const options = [
    { key: 'PENDING' as const, label: `Awaiting decision · ${count('PENDING')}` },
    { key: 'APPROVED' as const, label: `Approved · ${count('APPROVED')}` },
    ...(count('INVALID_DECISION') > 0 ? [{ key: 'INVALID_DECISION' as const, label: `Not recognised · ${count('INVALID_DECISION')}` }] : []),
    { key: 'ALL' as const, label: `All · ${items.length}` },
  ];

  return (
    <div className={`contents review-screen${routed ? ' routed' : ''}`}>
      <PageHead title="Review" lead="Changes the supplier proposed that need a person before they reach the catalog." />

      <p className="page-note review-readonly">
        <strong>Read-only.</strong> Decisions are made in the Google Sheet: type <strong>APPROVE</strong> in the decision column of the
        Review tab. A formula never counts. This console shows what the sheet holds and never writes to it.
      </p>

      <ReviewStateBanner model={model} />

      {items.length === 0 ? (
        <section className="card" aria-label="Review">
          <EmptyState title="Nothing is held for review">
            {model.lastCommitted
              ? 'The Review tab is empty: no change is waiting for a person.'
              : 'No run has published yet, so the Review tab is still empty.'}
          </EmptyState>
        </section>
      ) : (
        <Tabs label="Filter" options={options} value={filter} onChange={setFilter}>
          {visible.length === 0 ? (
            <section className="card" aria-label="No items"><EmptyState title="No items in this list" level={2}>Choose another filter to see the other items.</EmptyState></section>
          ) : (
            <div className="review-layout">
              <ul ref={listRef} className="card review-list" aria-label="Held changes">
                {visible.map((item) => (
                  <li key={item.row.review_id}>
                    <a className="review-link" data-sku={item.row.sku} href={href(`/review/${encodeURIComponent(item.row.sku)}`)}
                      aria-current={item === selected ? 'true' : undefined}>
                      <span className="row1">
                        <span className="mono xsmall muted sku">{item.row.sku}</span>
                        <span className="what">{headline(item)}</span>
                      </span>
                      <span className="name">{item.row.current_name || item.row.proposed_name}</span>
                      <span className="state"><span className={`dot ${DECISION_CHIP[item.decision].tone}`} aria-hidden="true" />{DECISION_CHIP[item.decision].label}</span>
                    </a>
                    {item === selected ? (
                      <a className="review-jump" href={href(`/review/${encodeURIComponent(item.row.sku)}`)}
                        onClick={(e) => { e.preventDefault(); titleRef.current?.focus(); }}>
                        Jump to this change&rsquo;s details
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
              {selected ? <ReviewDetail item={selected} model={model} titleRef={titleRef} /> : null}
            </div>
          )}
        </Tabs>
      )}
    </div>
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
      <Banner tone={unresolved ? 'amber' : 'blue'} status={unresolved ? 'UNKNOWN' : 'STARTED'} title={unresolved
        ? `Run ${active.id}'s outcome is unknown: do not edit Review in the sheet`
        : `Run ${active.id} has started and has no result yet: do not edit Review in the sheet`}
        action={<a href={href(`/runs/${active.id}`)}>View run {active.id}</a>}
        detailsLabel="What happens if Review is edited"
        details={(
          <p>
            If Review is edited there before run {active.id} sends its publish, the run publishes nothing and
            ends FAILED (REVIEW_CHANGED); an edit in the last seconds before Google applies the publish can still be lost.
          </p>
        )}>
        <p>
          Run {active.id}&rsquo;s Run Log row shows STARTED, written at {formatTime(active.row.started_at)}, {active.ageMinutes} minutes
          before this read. A publish rewrites the Review tab, so a decision saved now could be overwritten (contract §8). {NOT_LOCKED}
        </p>
      </Banner>
    );
  }
  const latest = model.latest;
  if (latest && latest.kind === 'failed' && ['REVIEW_CHANGED', 'REVIEW_READ_FAILED', 'REVIEW_DECISION_NOT_LITERAL'].includes(latest.row.error_code)) {
    const committed = committedRunOfBatch(latest, model.runs);
    const edited = model.review.filter((i) => i.decidedSinceLastPublish);
    return (
      <Banner tone="red" status="FAILED" code={latest.row.error_code}
        title={`Run ${latest.id} published nothing: ${{ REVIEW_CHANGED: 'Review changed during the run', REVIEW_DECISION_NOT_LITERAL: 'a decision cell was not typed' }[latest.row.error_code] ?? 'the final Review read failed'}`}
        action={<a href={href(`/runs/${latest.id}`)}>View run {latest.id}</a>}
        details={(
          <>
            <p>The final Review check stopped run {latest.id} before its publish, so the run is FAILED and nothing was applied.</p>
            <p>
              <strong>Operator:</strong> process the list again so it plans from the current decisions.
              {committed ? ` This list was already committed by run ${committed.id}, so a scheduled run will not process it again: start a manual reprocess.` : ' The next scheduled run processes it again.'}
              {' '}This console cannot start a run.
            </p>
          </>
        )}>
        <p>
          Nothing was applied.
          {edited.length > 0 ? <> The decision typed in the sheet is kept: {edited.map((i) => `${i.row.sku} ${String(i.row.decision)}`).join(', ')}. It is not applied yet.</> : ' The Review tab is as the operator left it.'}
        </p>
      </Banner>
    );
  }
  return null;
}

function ReviewDetail({ item, model, titleRef }: { item: ReviewItem; model: ConsoleModel; titleRef: React.Ref<HTMLHeadingElement> }) {
  const href = useHref();
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
        <a className="back-link" href={href('/review')}><Icon name="arrowLeft" size={14} />All held changes</a>
        <div className="detail-head">
          <div>
            <span className="mono xsmall muted sku">{r.sku}</span>
            <h2 id="item-title" ref={titleRef} tabIndex={-1}>{r.current_name || r.proposed_name}</h2>
          </div>
          <Pill tone={chip.tone}>{chip.label}</Pill>
        </div>

        {item.decidedSinceLastPublish ? (
          <div className="callout tone-blue">
            <strong>Typed in the sheet after the last publish.</strong> The decision cell says{' '}
            <span className="mono">{String(r.decision) || '(empty)'}</span>, but the status column still says{' '}
            <span className="mono">{r.status}</span>{lastWriter ? `, as run ${lastWriter.id} wrote it` : ''}.
            Nothing has been applied: the catalog keeps {kept} until a later publish processes this decision.
          </div>
        ) : null}

        <table className="compare">
          <caption className="visually-hidden">Current catalog values compared with the supplier&rsquo;s proposal</caption>
          <thead>
            <tr>
              <th scope="col"><span className="visually-hidden">Field</span></th>
              <th scope="col">In the catalog now</th>
              <th scope="col" className="proposed-col">Proposed · not applied</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.field}>
                <th scope="row">{c.field}</th>
                <td>{c.current}</td>
                <td className={`proposed-col ${c.changed ? 'changed' : 'same'}`}>
                  {c.proposed}
                  {c.changed && c === priceRow ? <span className="diff">{c.difference}</span> : null}
                  {c.changed ? <span className="visually-hidden"> (changed)</span> : <span className="visually-hidden"> (unchanged)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="held-reason">
          <strong>Why it is held:</strong>{' '}
          {item.reasons.map((reason) => REASON_TEXT[reason] ?? reason).join(', ')}.
          {price ? ` The price changes by ${formatPct(r.change_pct)}; any change of 25% or more needs a person.` : ' A unit or name change always needs a person.'}
        </p>

        <Disclosure title="In the Review tab">
          <DefinitionList items={[
            ['Decision cell', String(r.decision) === '' ? <span className="subtle">Empty</span> : <span className="mono">{String(r.decision)}</span>],
            ['Note cell', String(r.note) === '' ? <span className="subtle">Empty</span> : String(r.note)],
            ['Status column', <span className="mono">{r.status}</span>],
            ['Proposed in', <><span className="mono">{proposedIn?.row.source_name || item.batchId}</span>{r.source_row !== '' ? `, row ${r.source_row}` : ''}</>],
            ['First and last seen', `${formatDate(r.first_seen)} · ${formatDate(r.last_seen)}`],
            ['Review ID', <span className="mono">{r.review_id}</span>],
          ]} />
        </Disclosure>

        <Disclosure title="If it is approved in the sheet">
          <ol className="steps">
            <li>The Review tab records APPROVE and the note. Nothing in the catalog changes yet.</li>
            <li>The next processed price list that still proposes {proposed} applies it, or a manual reprocess of the latest list does.</li>
            <li>The change history records it as applied after review, with the note.</li>
            <li>If a later list proposes something different, this item is superseded and comes back for a new decision.</li>
          </ol>
          <p className="small muted">Not approving keeps {kept}. There is no reject action in v1; the item stays held.</p>
          <p className="detail-foot">
            {NOT_LOCKED} If a decision or note changes after a run has read Review, SheetOps publishes nothing and records
            REVIEW_CHANGED. An edit saved in the last seconds before Google applies a publish can still be lost: the item then
            shows its earlier decision, nothing is applied, and the operator types it again.
          </p>
        </Disclosure>
      </div>
    </article>
  );
}
