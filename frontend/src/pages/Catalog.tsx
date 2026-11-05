import { useState } from 'react';
import { Note } from '../components/Banner';
import { Drawer } from '../components/Drawer';
import { ResultCount, SearchField } from '../components/Fields';
import { LedgerTable } from '../components/LedgerTable';
import { DefinitionList, EmptyState } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill, StatusText } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { matchesFilter, matchesQuery, readCatalog, statusWord, type CatalogFilter, type CatalogItem } from '../domain/catalog';
import { DISPOSITION } from '../domain/changes';
import { formatDate, formatDateTime, formatPct, formatPrice, isBlank } from '../domain/format';
import { CHANGE_TYPE, type ConsoleModel } from '../domain/model';
import { decisionState, DECISION_CHIP } from '../domain/review';
import { useHref } from '../router';
import type { ReviewRow } from '../types';
import { BeforeAfter } from './Overview';

export function Catalog({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('ALL');
  const [openSku, setOpenSku] = useState<string | null>(null);
  const items = readCatalog(model.snapshot, model.lastCommitted);
  const reviews = new Map(model.snapshot.tabs.Review.map((r) => [r.review_id, r]));
  const count = (f: CatalogFilter) => items.filter((i) => matchesFilter(i, f)).length;
  const visible = items.filter((i) => matchesFilter(i, filter) && matchesQuery(i.row.sku, i.row.name, query));
  const currencies = [...new Set(items.map((i) => i.row.currency).filter(Boolean))];
  const priceHeader = currencies.length === 1 ? `Price (${currencies[0]})` : 'Price';
  const run = model.lastCommitted;
  const opened = items.find((i) => i.row.sku === openSku) ?? null;

  const proposalOf = (item: CatalogItem): ReviewRow | undefined => (item.row.pending_review ? reviews.get(item.row.pending_review) : undefined);
  const isPriceProposal = (r: ReviewRow | undefined) => !!r && r.reasons.includes('LARGE_PRICE_CHANGE');

  return (
    <>
      <PageHead title="Catalog" lead="What the shop’s catalog holds now: committed values only." />

      {items.length === 0 ? (
        <section className="card" aria-label="Catalog">
          <EmptyState title="The Catalog tab is empty">
            The sheet has no catalog rows yet. SheetOps fills it from the first price list it publishes.
          </EmptyState>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchField label="Find a product" value={query} onChange={setQuery} hint="SKU or product name" />
            </div>
            <ResultCount>{`Showing ${visible.length} of ${items.length} products`}</ResultCount>
          </div>

          <Tabs<CatalogFilter> label="Filter" value={filter} onChange={setFilter} options={[
            { key: 'ALL', label: `All · ${items.length}` },
            { key: 'ACTIVE', label: `Active · ${count('ACTIVE')}` },
            { key: 'DISCONTINUED', label: `Discontinued · ${count('DISCONTINUED')}` },
            { key: 'AWAITING_REVIEW', label: `Awaiting review · ${count('AWAITING_REVIEW')}` },
            { key: 'ISSUES', label: `Issues · ${count('ISSUES')}` },
          ]}>
            <section className="card" aria-labelledby="cat-title">
              <div className="card-head">
                <div>
                  <h2 id="cat-title">{visible.length} product{visible.length === 1 ? '' : 's'}</h2>
                  <div className="card-sub">
                    {run
                      ? <>As committed by <a href={href(`/runs/${run.id}`)}>run {run.id}</a> · {formatDate(run.row.effective_date)} list · sorted by SKU</>
                      : 'Starting catalog: no SheetOps run has published yet · sorted by SKU'}
                  </div>
                </div>
              </div>
              <LedgerTable<CatalogItem>
                stack
                caption={`Catalog, ${visible.length} of ${items.length} products`}
                rows={visible}
                rowKey={(i) => i.row.sku}
                columns={[
                  { header: 'SKU', rowHeader: true, phone: 'head', cell: (i) => (
                    <button type="button" className="row-button mono sku nowrap" aria-haspopup="dialog" onClick={() => setOpenSku(i.row.sku)}>{i.row.sku}</button>
                  ) },
                  { header: 'Product', phone: 'full', cell: (i) => {
                    const p = proposalOf(i);
                    return (
                      <>
                        <span className="product-name">{i.row.name}</span>
                        {i.notes.filter((n) => n.kind === 'applied').map((n) => <div key={n.text} className="cell-note note-applied">{n.text}</div>)}
                        {i.notes.filter((n) => n.kind === 'proposal' && !isPriceProposal(p)).map((n) => (
                          <div key={n.text} className="cell-note note-proposal"><span className={`proposed${p && decisionState(p.decision) === 'APPROVED' ? ' approved' : ''}`}>{n.text}</span></div>
                        ))}
                        {i.notes.filter((n) => n.kind === 'issue').map((n) => (
                          <div key={n.text} className="cell-note note-issue"><a className="issue-link" href={href('/exceptions')}><span className="dot amber" aria-hidden="true" />{n.text}</a></div>
                        ))}
                      </>
                    );
                  } },
                  { header: 'Unit', phone: 'meta', cell: (i) => i.row.unit },
                  { header: priceHeader, align: 'right', phone: 'end', cell: (i) => {
                    const p = proposalOf(i);
                    return (
                      <>
                        <span className="num strong price-committed">{formatPrice(i.row.unit_price)}{currencies.length > 1 ? ` ${i.row.currency}` : ''}</span>
                        {isPriceProposal(p) ? i.notes.filter((n) => n.kind === 'proposal').map((n) => (
                          <div key={n.text} className="cell-note note-proposal price-cell-note"><span className={`proposed${decisionState(p!.decision) === 'APPROVED' ? ' approved' : ''}`}>{n.text}</span></div>
                        )) : null}
                      </>
                    );
                  } },
                  { header: 'Previous', align: 'right', phone: 'hide', cell: (i) => (isBlank(i.row.previous_price) ? <span className="subtle"><span aria-hidden="true">—</span><span className="visually-hidden">none</span></span> : <span className="num muted">{formatPrice(i.row.previous_price)}</span>) },
                  { header: 'Status', phone: 'meta', cell: (i) => <StatusText tone={i.row.status === 'ACTIVE' ? 'green' : 'neutral'}>{statusWord(i.row.status)}</StatusText> },
                  { header: 'Last changed', phone: 'hide', hideMedium: true, cell: (i) => <span className="nowrap">{formatDate(i.row.last_changed)}</span> },
                  { header: 'Last seen', phone: 'hide', hideMedium: true, cell: (i) => <span className="nowrap">{formatDate(i.row.last_seen)}</span> },
                ]}
                empty={<EmptyState title="No products match" level={3}>Clear the search or choose another filter.</EmptyState>}
              />
              <div className="card-foot">
                Dates are price-list effective dates. “Previous” is the price before the last applied price change. Read {formatDateTime(model.snapshot.checkedAt)}.
              </div>
            </section>
          </Tabs>
          <Note>
            The price column always shows the committed price. A held or approved proposal appears only as a labelled
            “Proposed” marker; it reaches the price column only when a run that applies it is published.
          </Note>
        </>
      )}

      <Drawer open={opened !== null} onClose={() => setOpenSku(null)} eyebrow={opened ? <span className="mono">{opened.row.sku}</span> : null}
        title={opened?.row.name ?? ''}>
        {opened ? <ProductDetail item={opened} model={model} review={proposalOf(opened)} /> : null}
      </Drawer>
    </>
  );
}

function ProductDetail({ item, model, review }: { item: CatalogItem; model: ConsoleModel; review: ReviewRow | undefined }) {
  const href = useHref();
  const r = item.row;
  const history = model.snapshot.tabs.Changes.filter((c) => c.sku === r.sku);
  const state = review ? decisionState(review.decision) : null;
  return (
    <>
      <section className="drawer-section" aria-labelledby="pd-committed">
        <h3 id="pd-committed">Committed in the catalog</h3>
        <div className="price-block">
          <span className="price-now">{formatPrice(r.unit_price)}</span>
          <span className="muted">{r.currency} per {r.unit}</span>
          {!isBlank(r.previous_price) ? <span className="subtle num">previously {formatPrice(r.previous_price)}</span> : null}
        </div>
        <div className="mt-3">
          <DefinitionList items={[
            ['Status', <StatusText tone={r.status === 'ACTIVE' ? 'green' : 'neutral'}>{statusWord(r.status)}</StatusText>],
            ['First seen', formatDate(r.first_seen)],
            ['Last seen', formatDate(r.last_seen)],
            ['Last changed', formatDate(r.last_changed)],
          ]} />
        </div>
      </section>

      {r.pending_review ? (
        <section className="drawer-section" aria-labelledby="pd-review">
          <h3 id="pd-review">Held for review</h3>
          {review ? (
            <div className="held-box">
              <div>
                <div className="mb-2"><Pill tone={DECISION_CHIP[state!].tone}>{DECISION_CHIP[state!].label}</Pill></div>
                <DefinitionList items={[
                  ['Proposed', [
                    review.proposed_name !== review.current_name ? `name “${review.proposed_name}”` : null,
                    review.proposed_unit !== review.current_unit ? `unit “${review.proposed_unit}”` : null,
                    String(review.proposed_price) !== String(review.current_price) ? `${formatPrice(review.proposed_price)}${isBlank(review.change_pct) ? '' : ` (${formatPct(review.change_pct)})`}` : null,
                  ].filter(Boolean).join(', ') || '—'],
                  ['Not applied', 'The catalog keeps the committed values above until a published run applies the approval.'],
                ]} />
                <a className="small strong mt-2 inline-block" href={href(`/review/${encodeURIComponent(r.sku)}`)}>Open in Review</a>
              </div>
            </div>
          ) : <p className="small muted">Review ID {r.pending_review} is not in the Review tab.</p>}
        </section>
      ) : null}

      <section className="drawer-section" aria-labelledby="pd-history">
        <h3 id="pd-history">Change history</h3>
        {history.length === 0 ? <p className="small muted">No changes recorded for this SKU.</p> : (
          <ol className="timeline">
            {history.map((c) => {
              const d = DISPOSITION[c.disposition];
              return (
                <li key={c.event_id}>
                  <span className={`dot ${d?.tone ?? 'neutral'}`} aria-hidden="true" />
                  <div className="small">
                    <div><span className="strong">{CHANGE_TYPE[c.change_type] ?? c.change_type}</span> · {d?.label ?? c.disposition} · {formatDate(c.effective_date)}</div>
                    <BeforeAfter row={c} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <a className="small strong" href={href('/changes')}>Open change history</a>
      </section>

      {r.last_issue ? (
        <section className="drawer-section" aria-labelledby="pd-issues">
          <h3 id="pd-issues">Issues in the latest list</h3>
          <p className="small mono-wrap"><span className="mono">{r.last_issue}</span></p>
          <a className="small strong" href={href('/exceptions')}>Open exceptions</a>
        </section>
      ) : null}
    </>
  );
}
