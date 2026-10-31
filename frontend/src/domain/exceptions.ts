import type { ExceptionRow } from '../types';
import type { Run } from './runs';

export interface ExceptionBatch {
  batchId: string;
  sourceFile: string;
  rows: ExceptionRow[];
  /** The run whose publish wrote these rows: committed, rejected or halted. */
  run: Run | null;
}

const WRITES_EXCEPTIONS = new Set(['published', 'published_exceptions', 'rejected', 'halted']);

/** Exceptions grouped by batch, newest batch first (the tab is append-only). */
export function exceptionBatches(rows: ExceptionRow[], runs: Run[]): ExceptionBatch[] {
  const order: string[] = [];
  const byBatch = new Map<string, ExceptionRow[]>();
  for (const row of rows) {
    if (!byBatch.has(row.batch_id)) { byBatch.set(row.batch_id, []); order.push(row.batch_id); }
    byBatch.get(row.batch_id)!.push(row);
  }
  return order.reverse().map((batchId) => {
    const list = byBatch.get(batchId)!;
    return {
      batchId,
      sourceFile: list[0].source_file,
      rows: list,
      run: runs.find((r) => r.row.batch_id === batchId && WRITES_EXCEPTIONS.has(r.kind)) ?? null,
    };
  });
}

export function severityCounts(rows: ExceptionRow[]): Record<string, number> {
  const counts: Record<string, number> = { ERROR: 0, REVIEW: 0, INFO: 0 };
  for (const r of rows) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
  return counts;
}
