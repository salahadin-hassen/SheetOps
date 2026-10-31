import { useState } from 'react';
import { SelectField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { LedgerTable } from '../components/LedgerTable';
import { EmptyState, Stat } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill } from '../components/StatusPill';
import { Tabs } from '../components/Tabs';
import { ACTION_LABEL, EXCEPTION_TITLE, SEVERITY, suggestionFor } from '../domain/explain';
import { severityCounts } from '../domain/exceptions';
import { cellText } from '../domain/format';
import type { ConsoleModel } from '../domain/model';
import { useHref } from '../router';
import type { ExceptionRow } from '../types';

type Filter = 'ALL' | 'ERROR' | 'REVIEW' | 'INFO';

const asWritten = (value: ExceptionRow['raw_value']) => {
  const text = cellText(value);
  return text === '' ? <span className="subtle">(empty)</span> : <span className="mono">&ldquo;{text}&rdquo;</span>;
};

export function Exceptions({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const batches = model.exceptionBatches;
  const [batchId, setBatchId] = useState(batches[0]?.batchId ?? '');
  const [filter, setFilter] = useState<Filter>('ALL');
  const batch = batches.find((b) => b.batchId === batchId) ?? batches[0];

  if (!batch) {
    return (
      <>
        <PageHead title="Exceptions" lead="Rows SheetOps did not apply as written, and what it did instead." />
        <section className="card" aria-label="Exceptions">
          <EmptyState title="No exceptions recorded" icon="check">
            The Exceptions tab is empty. {model.lastCommitted ? 'The published lists had no problem rows.' : 'No run has published to this sheet yet.'}
          </EmptyState>
        </section>
      </>
    );
  }

  const counts = severityCounts(batch.rows);
  const rows = filter === 'ALL' ? batch.rows : batch.rows.filter((r) => r.severity === filter);
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

      <section className="card" aria-label="Exceptions by severity">
        <div className="stats">
          {(['ERROR', 'REVIEW', 'INFO'] as const).map((s) => (
            <Stat key={s} label={SEVERITY[s].label} value={counts[s]} note={SEVERITY[s].meaning} />
          ))}
        </div>
      </section>

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
              <div className="card-sub">Values appear exactly as they were in the file.</div>
            </div>
            {batch.run ? <a className="small strong" href={href(`/runs/${batch.run.id}`)}>Run {batch.run.id}</a> : null}
          </div>
          <LedgerTable<ExceptionRow>
            stack
            caption={title}
            rows={rows}
            rowKey={(r) => r.exception_id}
            columns={[
              { header: 'Row', rowHeader: true, cell: (r) => <span className="num">{cellText(r.source_row) || '0'}</span> },
              { header: 'SKU as written', cell: (r) => <span className="nowrap">{asWritten(r.sku_raw)}</span> },
              { header: 'Severity', cell: (r) => {
                const s = SEVERITY[r.severity] ?? { label: r.severity, tone: 'neutral' as const };
                return <Pill tone={s.tone} icon={null}>{s.label}</Pill>;
              } },
              { header: 'Problem', cell: (r) => (
                <>
                  <span className="strong">{EXCEPTION_TITLE[r.code] ?? r.message}</span>
                  <div className="cell-sub">{r.message} · <span className="mono">{r.code}</span></div>
                </>
              ) },
              { header: 'Field · value', cell: (r) => (r.field
                ? <span className="nowrap"><span className="mono subtle">{r.field}</span> {asWritten(r.raw_value)}</span>
                : <span className="subtle">—</span>) },
              { header: 'What SheetOps did', cell: (r) => <span className="nowrap">{ACTION_LABEL[r.action] ?? r.action}</span> },
            ]}
            detail={(r) => (
              <div className="note"><Icon name="arrowRight" size={14} /><div><strong>What to do:</strong> {suggestionFor(r)}</div></div>
            )}
            empty={<EmptyState title="No exceptions with this severity" level={3} icon="search">Choose another filter.</EmptyState>}
          />
        </section>
      </Tabs>
    </>
  );
}
