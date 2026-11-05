import { useState } from 'react';
import { Drawer } from '../components/Drawer';
import { SelectField } from '../components/Fields';
import { LedgerTable } from '../components/LedgerTable';
import { DefinitionList, EmptyState } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { ACTION_LABEL, EXCEPTION_TITLE, SEVERITY, suggestionFor } from '../domain/explain';
import { severityCounts } from '../domain/exceptions';
import { cellText, formatPrice } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { useHref } from '../router';
import type { ExceptionRow } from '../types';

type Filter = 'ALL' | 'ERROR' | 'REVIEW' | 'INFO';

/** Longest value a table cell shows. A cell can hold 40,000 characters; the row's drawer shows all of it. */
const CELL_LIMIT = 40;
const MESSAGE_LIMIT = 160;

/** A value exactly as written. With a limit, a longer one is cut and says how much is not shown. */
const asWritten = (value: ExceptionRow['raw_value'], limit?: number) => {
  const text = cellText(value);
  if (text === '') return <span className="subtle">(empty)</span>;
  if (limit !== undefined && text.length > limit) {
    return (
      <span className="mono-wrap">
        <span className="mono">&ldquo;{text.slice(0, limit)}&hellip;</span>{' '}
        <span className="subtle xsmall">{(text.length - limit).toLocaleString('en-US')} more characters</span>
      </span>
    );
  }
  return <span className="mono mono-wrap">&ldquo;{text}&rdquo;</span>;
};

const clipped = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

export function Exceptions({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const batches = model.exceptionBatches;
  const [batchId, setBatchId] = useState(batches[0]?.batchId ?? '');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const batch = batches.find((b) => b.batchId === batchId) ?? batches[0];
  const opened = batch?.rows.find((r) => r.exception_id === openId) ?? null;

  if (!batch) {
    return (
      <>
        <PageHead title="Exceptions" lead="Rows SheetOps did not apply as written, and what it did instead." />
        <section className="card" aria-label="Exceptions">
          <EmptyState title="No exceptions recorded">
            The Exceptions tab is empty. {model.lastCommitted ? 'The published lists had no problem rows.' : 'No run has published to this sheet yet.'}
          </EmptyState>
        </section>
      </>
    );
  }

  const counts = severityCounts(batch.rows);
  const rows = filter === 'ALL' ? batch.rows : batch.rows.filter((r) => r.severity === filter);
  const severityLine = (['ERROR', 'REVIEW', 'INFO'] as const).filter((sev) => counts[sev] > 0)
    .map((sev) => `${SEVERITY[sev].label}: ${SEVERITY[sev].meaning.toLowerCase()}`).join(' · ');
  const title = `${batch.sourceFile}${batch.run ? ` · run ${batch.run.id}` : ''} · ${batch.rows.length} exception${batch.rows.length === 1 ? '' : 's'}`;

  return (
    <>
      <PageHead title="Exceptions" lead="Rows SheetOps did not apply as written, what it did instead, and what to do. Rows are only ever added, never edited." />

      {batches.length > 1 ? (
        <div className="toolbar"><div className="toolbar-left">
          <SelectField label="List" value={batch.batchId} onChange={(v) => { setBatchId(v); setFilter('ALL'); }}
            options={batches.map((b) => ({ value: b.batchId, label: `${b.sourceFile} (${b.rows.length})` }))} />
        </div></div>
      ) : null}

      <Tabs label="Severity" value={filter} onChange={setFilter} options={[
        { key: 'ALL', label: `All · ${batch.rows.length}` },
        { key: 'ERROR', label: `Rejected · ${counts.ERROR}` },
        { key: 'REVIEW', label: `Held · ${counts.REVIEW}` },
        { key: 'INFO', label: `Collapsed · ${counts.INFO}` },
      ]}>
        <section className="card" aria-labelledby="exc-title">
          <div className="card-head">
            <div className="minw-0">
              <h2 id="exc-title">{title}</h2>
              <div className="card-sub">Values appear as they were in the file; a very long one is stored shortened and marked [TRUNCATED]. <span className="hide-phone">{severityLine}.</span></div>
            </div>
            {batch.run ? <a className="small strong" href={href(`/runs/${batch.run.id}`)}>Run {batch.run.id}</a> : null}
          </div>
          <LedgerTable<ExceptionRow>
            stack
            caption={title}
            rows={rows}
            rowKey={(r) => r.exception_id}
            columns={[
              { header: 'Row', rowHeader: true, phone: 'head', cell: (r) => (
                <button type="button" className="row-button row-number num nowrap" aria-haspopup="dialog" aria-label={`Details for row ${cellText(r.source_row) || '0'}`} onClick={() => setOpenId(r.exception_id)}>
                  {cellText(r.source_row) || '0'}
                </button>
              ) },
              { header: 'SKU as written', phone: 'head', cell: (r) => asWritten(r.sku_raw, CELL_LIMIT) },
              { header: 'Severity', phone: 'end', cell: (r) => {
                const s = SEVERITY[r.severity] ?? { label: r.severity, tone: 'neutral' as const };
                return <Pill tone={s.tone}>{s.label}</Pill>;
              } },
              { header: 'Problem', phone: 'full', cell: (r) => (
                <>
                  <span className="strong mono-wrap">{EXCEPTION_TITLE[r.code] ?? clipped(r.message, MESSAGE_LIMIT)}</span>
                  <div className="cell-sub mono-wrap">{clipped(r.message, MESSAGE_LIMIT)} · <span className="mono">{r.code}</span></div>
                </>
              ) },
              { header: 'Field · value', phone: 'meta', cell: (r) => (r.field
                ? <span><span className="mono subtle">{r.field}</span> {asWritten(r.raw_value, CELL_LIMIT)}</span>
                : <span className="subtle">—</span>) },
              { header: 'What SheetOps did', phone: 'meta', hideMedium: true, cell: (r) => <span className="nowrap">{ACTION_LABEL[r.action] ?? r.action}</span> },
            ]}
            detail={(r) => (
              <div className="todo"><div><strong>What to do:</strong> {suggestionFor(r)}</div></div>
            )}
            empty={<EmptyState title="No exceptions with this severity" level={3}>Choose another filter.</EmptyState>}
          />
        </section>
      </Tabs>

      <Drawer open={opened !== null} onClose={() => setOpenId(null)}
        eyebrow={opened ? <span className="mono">{opened.source_file}</span> : null}
        title={opened ? `Row ${cellText(opened.source_row) || '0'}` : ''}>
        {opened ? <ExceptionDetail row={opened} model={model} runId={batch.run?.id ?? null} /> : null}
      </Drawer>
    </>
  );
}

function ExceptionDetail({ row, model, runId }: { row: ExceptionRow; model: ConsoleModel; runId: string | null }) {
  const href = useHref();
  const severity = SEVERITY[row.severity] ?? { label: row.severity, tone: 'neutral' as const, meaning: '' };
  const product = model.snapshot.tabs.Catalog.find((c) => c.sku === cellText(row.sku_raw));
  return (
    <>
      <section className="drawer-section" aria-labelledby="ex-problem">
        <h3 id="ex-problem">Problem</h3>
        <p className="strong mono-wrap">{EXCEPTION_TITLE[row.code] ?? clipped(row.message, MESSAGE_LIMIT)}</p>
        <p className="small muted mt-2 mono-wrap">{row.message}</p>
      </section>
      <section className="drawer-section" aria-labelledby="ex-todo">
        <h3 id="ex-todo">What to do</h3>
        <p className="small">{suggestionFor(row)}</p>
      </section>
      <section className="drawer-section" aria-labelledby="ex-record">
        <h3 id="ex-record">Recorded</h3>
        <DefinitionList items={[
          ['Severity', <><Pill tone={severity.tone}>{severity.label}</Pill>{severity.meaning ? <span className="small muted"> {severity.meaning}</span> : null}</>],
          ['What SheetOps did', ACTION_LABEL[row.action] ?? row.action],
          ['SKU as written', asWritten(row.sku_raw)],
          ['Field', row.field ? <span className="mono">{row.field}</span> : <span className="subtle">None</span>],
          ['Value as written', row.field ? asWritten(row.raw_value) : <span className="subtle">None</span>],
          ...(product && row.action === 'KEPT_PREVIOUS'
            ? [['In the catalog now', `${formatPrice(product.unit_price)} ${product.currency} per ${product.unit}`] as [string, string]]
            : []),
          ['Code', <span className="mono">{row.code}</span>],
          ['Exception ID', <span className="mono">{row.exception_id}</span>],
        ]} />
      </section>
      {runId ? <a className="small strong" href={href(`/runs/${runId}`)}>Run {runId}</a> : null}
    </>
  );
}
