import { Banner } from '../components/Banner';
import { LedgerTable } from '../components/LedgerTable';
import { EmptyState, Panel } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { RunBanner } from '../components/RunBanner';
import { Pill } from '../components/StatusPill';
import { formatDate, formatDateTime } from '../domain/format';
import { lastRecordedQueue, recordedFiles, type RecordedFile } from '../domain/incoming';
import type { ConsoleModel } from '../domain/model';
import { STATUS_LABEL } from '../domain/runs';
import { useHref } from '../router';

export function Incoming({ model }: { model: ConsoleModel }) {
  const href = useHref();
  const files = recordedFiles(model.snapshot, model.runs);
  const queue = lastRecordedQueue(model.runs);

  return (
    <>
      <PageHead title="Incoming files" lead="Files the sheet has a record of, and what happened to each." />

      <Banner tone="neutral" title="Recorded files, not the live Drive inbox">
        <p>
          A file appears here only after a run wrote about it in the Run Log or Exceptions. Files waiting in Drive are not recorded
          anywhere this console can read, so they are not listed. Showing them needs a Drive read on a secure server, which
          does not exist yet. See <a href={href('/connection')}>Connection</a>.
        </p>
      </Banner>

      {/* A run with no final status holds the queue, so it belongs on this screen. */}
      {model.publishing.kind === 'unresolved' || model.publishing.kind === 'started' ? <RunBanner model={model} /> : null}

      <div className="split">
        <div className="split-main">
          <Panel title="Recorded files" flush
            sub={files.length ? `${files.length} file version${files.length === 1 ? '' : 's'}, newest effective date first` : undefined}>
            <LedgerTable<RecordedFile>
              stack
              caption="File versions recorded in the Run Log and Exceptions"
              rows={files}
              rowKey={(f) => f.key}
              columns={[
                { header: 'File', rowHeader: true, phone: 'full', cell: (f) => (
                  <>
                    <span className="mono nowrap">{f.name}</span>
                    <div className="cell-sub">{f.effectiveDate ? `Effective ${formatDate(f.effectiveDate)}` : 'Effective date not recorded'}</div>
                  </>
                ) },
                { header: 'Outcome', phone: 'full', cell: (f) => (
                  <>
                    <Pill tone={f.tone}>{f.label}</Pill>
                    {f.laterAttempt ? (
                      <div className="cell-sub">
                        Later attempt: <a href={href(`/runs/${f.laterAttempt.id}`)}>run {f.laterAttempt.id}</a>, {STATUS_LABEL[f.laterAttempt.kind].label.toLowerCase()}{f.laterAttempt.row.error_code ? ` (${f.laterAttempt.row.error_code})` : ''}
                      </div>
                    ) : null}
                  </>
                ) },
                { header: 'Runs', phone: 'metaLabel', cell: (f) => (f.runs.length === 0 ? <span className="subtle">None</span> : (
                  <span className="nowrap">
                    {[...f.runs].reverse().map((r, i) => <span key={r.id}>{i > 0 ? ', ' : ''}<a href={href(`/runs/${r.id}`)}>{r.id}</a></span>)}
                  </span>
                )) },
                { header: 'Exceptions', align: 'right', phone: 'metaLabel', cell: (f) => (f.exceptions > 0
                  ? <a className="count-link num" href={href('/exceptions')} aria-label={`${f.exceptions} exceptions`}>{f.exceptions}</a>
                  : <span className="subtle">0</span>) },
              ]}
              empty={<EmptyState title="No files recorded yet" level={3}>
                No run has written to the Run Log or Exceptions, so the sheet has no record of any file. This does not mean the Drive inbox is empty.
              </EmptyState>}
            />
          </Panel>

          <section className="card" aria-labelledby="queue-title">
            <div className="card-head"><h2 id="queue-title">Queue at the last run</h2></div>
            <div className="card-body">
              {queue ? (
                <p className="small">
                  <span className="strong num">{queue.count} file{queue.count === 1 ? '' : 's'}</span> still in the queue, as{' '}
                  <a href={href(`/runs/${queue.run.id}`)}>run {queue.run.id}</a> recorded at {formatDateTime(queue.run.row.started_at)}.
                  This is what that run saw, not a live count of the inbox.
                </p>
              ) : <p className="small muted">Not recorded: no run has written a queue count. Live Drive information is unavailable.</p>}
            </div>
          </section>
        </div>

        <aside className="split-side" aria-label="How files are picked">
          <Panel title="Order" level={2}>
            <ol className="steps">
              <li>One file version per run, oldest effective date first.</li>
              <li>A version older than the latest committed list is rejected, so it cannot roll the catalog back.</li>
              <li>A halted version, or one with 3 failed attempts, stops the queue until a person decides.</li>
            </ol>
          </Panel>
          <Panel title="Rejected before download" level={2}>
            <ul className="steps">
              <li>Not a CSV, such as a Google Docs or Sheets file.</li>
              <li>Name not <span className="mono">supplier_YYYY-MM-DD.csv</span>, or not a real date.</li>
              <li>Another supplier&rsquo;s name.</li>
              <li>Larger than 2,000,000 bytes.</li>
            </ul>
            <p className="xsmall subtle">Each is reported once and does not block the queue.</p>
          </Panel>
        </aside>
      </div>
    </>
  );
}
