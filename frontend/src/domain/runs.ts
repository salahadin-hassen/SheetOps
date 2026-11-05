import type { Cell, RunLogRow, SheetSnapshot } from '../types';
import { isBlank, minutesBetween } from './format';

// How the console reads Run Log rows. Every rule here restates the data
// contract (docs/data-contract.md); none of it decides anything the workflow
// has not already decided. The console sees only the spreadsheet: what n8n
// knows about a run is not visible here, and the screens say so.

/** Contract §2: a STARTED row this old is an unresolved publication. */
export const UNRESOLVED_AFTER_MINUTES = 15;

export type RunKind =
  | 'started'
  | 'unresolved'
  | 'published'
  | 'published_exceptions'
  | 'rejected'
  | 'halted'
  | 'failed'
  | 'superseded'
  | 'blocked'
  | 'unrecognised';

export type Tone = 'blue' | 'green' | 'red' | 'amber' | 'neutral';

export interface Run {
  id: string;
  row: RunLogRow;
  kind: RunKind;
  /** Contract §11: only SUCCESS and SUCCESS_WITH_EXCEPTIONS count as committed. */
  committed: boolean;
  /** Minutes from started_at to the snapshot's checkedAt. */
  ageMinutes: number;
}

export function runKind(row: RunLogRow, checkedAt: string): RunKind {
  switch (row.status) {
    case 'STARTED':
      return minutesBetween(row.started_at, checkedAt) >= UNRESOLVED_AFTER_MINUTES ? 'unresolved' : 'started';
    case 'SUCCESS': return 'published';
    case 'SUCCESS_WITH_EXCEPTIONS': return 'published_exceptions';
    case 'REJECTED_FILE': return 'rejected';
    case 'HALTED_REVIEW': return 'halted';
    case 'FAILED': return 'failed';
    case 'INTERRUPTED': return 'superseded';
    case 'BLOCKED': return 'blocked';
    default: return 'unrecognised';
  }
}

/** Run Log rows, newest first. The sheet keeps one row per run (§10). */
export function readRuns(snapshot: SheetSnapshot): Run[] {
  return snapshot.tabs['Run Log']
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Date.parse(b.row.started_at) - Date.parse(a.row.started_at) || b.index - a.index)
    .map(({ row }) => {
      const kind = runKind(row, snapshot.checkedAt);
      return {
        id: String(row.run_id),
        row,
        kind,
        committed: kind === 'published' || kind === 'published_exceptions',
        ageMinutes: minutesBetween(row.started_at, snapshot.checkedAt),
      };
    });
}

export const STATUS_LABEL: Record<RunKind, { label: string; tone: Tone }> = {
  started: { label: 'Started · no result yet', tone: 'blue' },
  unresolved: { label: 'Outcome unknown', tone: 'amber' },
  published: { label: 'Published', tone: 'green' },
  published_exceptions: { label: 'Published with exceptions', tone: 'green' },
  rejected: { label: 'File rejected', tone: 'neutral' },
  halted: { label: 'Halted · needs decision', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'amber' },
  unrecognised: { label: 'Unrecognised status', tone: 'neutral' },
};

// ---------------------------------------------------------------------------
// The five-stage track: only what the sheet can show.

export const STAGES = ['Queue check', 'Download', 'Validate', 'Plan', 'Publish'] as const;

export type StageState =
  | 'done' | 'pending' | 'not-in-sheet' | 'not-reached' | 'unknown'
  | 'failed' | 'stopped' | 'rejected' | 'recorded' | 'replaced';

export interface Stage {
  name: (typeof STAGES)[number];
  state: StageState;
  word: string;
}

const WORD: Record<StageState, string> = {
  done: 'Done',
  pending: 'No result yet',
  'not-in-sheet': 'Not in the sheet',
  'not-reached': 'Not reached',
  unknown: 'Unknown',
  failed: 'Failed',
  stopped: 'Halted',
  rejected: 'Rejected',
  recorded: 'Outcome recorded',
  replaced: 'Replaced',
};

/** Contract §2 step 3 and §1: checked before download. */
const PRE_DOWNLOAD = new Set(['NOT_A_CSV_FILE', 'BAD_FILENAME', 'WRONG_SUPPLIER', 'FILE_TOO_LARGE', 'OUT_OF_ORDER_FILE']);

/** For FAILED rows: the stage where each code stops a run (contract §12–14). */
const FAILED_AT: Record<string, number> = {
  INVALID_LISTING: 0,
  DOWNLOAD_FAILED: 1,
  READ_FAILED: 2,
  CATALOG_INVALID: 2,
  REVIEW_INVALID: 2,
  RUNLOG_INVALID: 2,
  OUTPUT_SCHEMA_MISMATCH: 2,
  PLAN_INVALID: 3,
  PUBLISH_TOO_LARGE: 3,
  REVIEW_CHANGED: 4,
  REVIEW_READ_FAILED: 4,
  REVIEW_DECISION_NOT_LITERAL: 4,
  PUBLISH_REJECTED: 4,
};

function track(states: Array<StageState | [StageState, string]>): Stage[] {
  return STAGES.map((name, i) => {
    const s = states[i];
    const [state, word] = Array.isArray(s) ? s : [s, WORD[s]];
    return { name, state, word };
  });
}

const httpStatus = (message: string): string | null => /\bHTTP (\d{3})\b/.exec(message)?.[1] ?? null;

export function stagesFor(run: Run): Stage[] {
  const code = run.row.error_code;
  switch (run.kind) {
    case 'published':
    case 'published_exceptions':
      return track(['done', 'done', 'done', 'done', 'done']);
    case 'started':
      return track(['done', 'pending', 'pending', 'pending', 'pending']);
    case 'unresolved':
      return track(['done', 'not-in-sheet', 'not-in-sheet', 'not-in-sheet', 'unknown']);
    case 'superseded':
      return track(['done', 'not-in-sheet', 'not-in-sheet', 'not-in-sheet', 'replaced']);
    case 'halted':
      return track(['done', 'done', 'stopped', 'not-reached', ['recorded', 'Halt recorded']]);
    case 'blocked':
      return track([['stopped', 'Blocked'], 'not-reached', 'not-reached', 'not-reached', 'not-reached']);
    case 'rejected':
      return PRE_DOWNLOAD.has(code)
        ? track(['rejected', 'not-reached', 'not-reached', 'not-reached', ['recorded', 'Rejection recorded']])
        : track(['done', 'done', 'rejected', 'not-reached', ['recorded', 'Rejection recorded']]);
    case 'failed': {
      const at = FAILED_AT[code] ?? 4;
      let word = 'Failed';
      if (code === 'REVIEW_CHANGED' || code === 'REVIEW_READ_FAILED' || code === 'REVIEW_DECISION_NOT_LITERAL') word = 'Not sent';
      if (code === 'PUBLISH_REJECTED') {
        const status = httpStatus(run.row.error_message);
        word = status ? `Refused (${status})` : 'Refused';
      }
      return track(STAGES.map((_, i): StageState | [StageState, string] =>
        i < at ? 'done' : i === at ? ['failed', word] : 'not-reached'));
    }
    default:
      return track(['not-in-sheet', 'not-in-sheet', 'not-in-sheet', 'not-in-sheet', 'unknown']);
  }
}

// ---------------------------------------------------------------------------
// Row accounting. A FAILED or STARTED row leaves the counts blank: blank means
// "not recorded", never zero.

export interface Count {
  key: keyof RunLogRow;
  label: string;
  value: number | null;
}

const COUNT_LABELS: Array<[keyof RunLogRow, string]> = [
  ['accepted', 'Accepted'],
  ['collapsed', 'Duplicate collapsed'],
  ['rejected', 'Rejected'],
  ['held_conflict', 'Held: conflicting rows'],
  ['held_review', 'Held for review'],
  ['blank', 'Blank'],
];

const OUTCOME_LABELS: Array<[keyof RunLogRow, string]> = [
  ['changes_applied', 'Changes applied'],
  ['reviews_opened', 'Reviews opened'],
  ['reviews_pending', 'Reviews pending'],
  ['exceptions_new', 'New exceptions'],
  ['exceptions', 'Exceptions in this batch'],
  ['queue_remaining', 'Files still in the queue'],
];

const toCount = (value: Cell): number | null => (isBlank(value) ? null : Number(value));

export function rowAccounting(row: RunLogRow): { rowsRead: number | null; parts: Count[] } {
  return {
    rowsRead: toCount(row.rows_read),
    parts: COUNT_LABELS.map(([key, label]) => ({ key, label, value: toCount(row[key]) })),
  };
}

export function runOutcomes(row: RunLogRow): Count[] {
  return OUTCOME_LABELS.map(([key, label]) => ({ key, label, value: toCount(row[key]) }));
}

// ---------------------------------------------------------------------------
// Console-wide state from the Run Log alone.

export type PublishingState =
  | { kind: 'none' }
  | { kind: 'idle'; lastCommitted: Run | null }
  | { kind: 'started'; run: Run }
  | { kind: 'unresolved'; run: Run };

export function publishingState(runs: Run[]): PublishingState {
  if (runs.length === 0) return { kind: 'none' };
  const unresolved = runs.find((r) => r.kind === 'unresolved');
  if (unresolved) return { kind: 'unresolved', run: unresolved };
  const started = runs.find((r) => r.kind === 'started');
  if (started) return { kind: 'started', run: started };
  return { kind: 'idle', lastCommitted: runs.find((r) => r.committed) ?? null };
}

/** The committed run of the same batch version, if any, other than `run`. */
export function committedRunOfBatch(run: Run, runs: Run[]): Run | null {
  if (!run.row.batch_id) return null;
  return runs.find((r) => r !== run && r.committed && r.row.batch_id === run.row.batch_id) ?? null;
}
