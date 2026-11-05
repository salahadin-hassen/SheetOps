import type { SheetSnapshot } from '../types';
import { isBlank } from './format';
import { STATUS_LABEL, type Run, type Tone } from './runs';

// Files the sheet has a record of. The sheet records a file only after a run
// wrote about it, so this is history, not the Drive inbox: a file waiting in
// Drive has no row anywhere the console can read, and is never listed here.

export interface RecordedFile {
  key: string;
  name: string;
  batchId: string;
  effectiveDate: string;
  /** Runs of this file version, newest first. */
  runs: Run[];
  committedRun: Run | null;
  exceptions: number;
  label: string;
  tone: Tone;
  /** A later attempt that did not change the committed result, if any. */
  laterAttempt: Run | null;
}

export function recordedFiles(snapshot: SheetSnapshot, runs: Run[]): RecordedFile[] {
  const files = new Map<string, RecordedFile>();
  const exceptionsOf = (batchId: string) => snapshot.tabs.Exceptions.filter((e) => e.batch_id === batchId).length;

  // `runs` is newest first, so the first run seen for a version is its latest.
  // A row with neither a batch nor a file name is about the run, not a file.
  for (const run of runs) {
    const key = run.row.batch_id || run.row.source_name;
    if (!key) continue;
    const existing = files.get(key);
    if (existing) { existing.runs.push(run); continue; }
    files.set(key, {
      key,
      name: run.row.source_name || run.row.batch_id,
      batchId: run.row.batch_id,
      effectiveDate: run.row.effective_date,
      runs: [run],
      committedRun: null,
      exceptions: exceptionsOf(run.row.batch_id),
      label: STATUS_LABEL[run.kind].label,
      tone: STATUS_LABEL[run.kind].tone,
      laterAttempt: null,
    });
  }

  for (const file of files.values()) {
    const committed = file.runs.find((r) => r.committed) ?? null;
    file.committedRun = committed;
    const latest = file.runs[0];
    // An unresolved or still-open attempt outranks an earlier commit: it may yet
    // rewrite the sheet. A definitive later failure changed nothing.
    if (committed && latest !== committed && (latest.kind === 'failed' || latest.kind === 'superseded')) {
      file.label = STATUS_LABEL[committed.kind].label;
      file.tone = STATUS_LABEL[committed.kind].tone;
      file.laterAttempt = latest;
    }
  }

  // Exceptions can name a file no Run Log row names.
  for (const e of snapshot.tabs.Exceptions) {
    const key = e.batch_id || e.source_file;
    if (!key || files.has(key)) continue;
    files.set(key, {
      key, name: e.source_file || e.batch_id, batchId: e.batch_id, effectiveDate: '', runs: [], committedRun: null,
      exceptions: snapshot.tabs.Exceptions.filter((x) => (x.batch_id || x.source_file) === key).length,
      label: 'In Exceptions only', tone: 'neutral', laterAttempt: null,
    });
  }

  return [...files.values()].sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0));
}

/** The queue count the newest run recorded when it ran. Never a live count. */
export function lastRecordedQueue(runs: Run[]): { count: number; run: Run } | null {
  const run = runs.find((r) => !isBlank(r.row.queue_remaining));
  return run ? { count: Number(run.row.queue_remaining), run } : null;
}
