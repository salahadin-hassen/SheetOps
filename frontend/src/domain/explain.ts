import type { ExceptionRow } from '../types';
import { formatDateTime } from './format';
import { committedRunOfBatch, type Run } from './runs';

// Plain-language explanations of Run Log rows and exception codes. The words
// restate the data contract (§2, §8, §11–14); the facts come from the row.

export interface RunExplanation {
  title: string;
  /** What the sheet shows, and what it means. */
  meaning: string;
  /** What a person should do next. Never a button: this console cannot act. */
  operator: string;
}

const NO_N8N = 'This console reads the spreadsheet, not n8n: the n8n execution record has the step-by-step detail.';

export function explainRun(run: Run, runs: Run[]): RunExplanation {
  const { row } = run;
  const code = row.error_code;
  switch (run.kind) {
    case 'published':
    case 'published_exceptions':
      return {
        title: run.kind === 'published' ? 'Published' : 'Published with exceptions',
        meaning: 'Catalog, Review, change history, exceptions and this row were written in one request, so they appear together or not at all.',
        operator: run.kind === 'published'
          ? 'Nothing to do.'
          : 'Decide the held changes in the Review tab and look at the exceptions.',
      };
    case 'started':
      return {
        title: 'Started · no result yet',
        meaning: `The row has shown STARTED for ${run.ageMinutes} minute${run.ageMinutes === 1 ? '' : 's'}, inside the 15-minute processing window. The sheet records only the start until the publish. ${NO_N8N}`,
        operator: 'Nothing to do yet. Do not edit the Review tab in the sheet until this row shows a final status. If it still shows STARTED 15 minutes after it started, it becomes an unresolved publication.',
      };
    case 'unresolved':
      return {
        title: 'Outcome unknown',
        meaning: `The Run Log still shows STARTED after ${run.ageMinutes} minutes. No final status is recorded, so the sheet cannot show whether the publish was applied. It is not marked Failed: nothing shows that it failed.`,
        operator: 'Check the n8n execution record for this run, then follow "An unresolved publication" in docs/setup.md. With automatic recovery off (the default), scheduled runs stop as Blocked (PUBLICATION_UNRESOLVED) until a person runs a manual reprocess with this batch\'s target_batch_id.',
      };
    case 'failed':
      return explainFailure(run, runs, code);
    case 'rejected':
      return {
        title: 'File rejected',
        meaning: `The file was not processed (${code || 'no code recorded'}). The rejection and its exceptions were recorded once; a rejected file never blocks the queue.`,
        operator: code === 'OUT_OF_ORDER_FILE'
          ? 'Nothing, unless the file was meant to be newer. Then upload it under its real effective date.'
          : 'Fix the file and upload it again as demo-supplier_YYYY-MM-DD.csv with its effective date.',
      };
    case 'halted':
      return {
        title: 'Halted · too many products missing',
        meaning: 'More than 30% of active products were absent from the list. Nothing was discontinued or applied; the halt and one exception were recorded. Later files wait behind it.',
        operator: 'Check the file. If those products really are gone, a manual run with target_batch_id and confirm_mass_discontinue processes it.',
      };
    case 'blocked':
      return {
        title: 'Blocked',
        meaning: `Only the run row was written; nothing was processed (${code || 'no code recorded'}).`,
        operator: code === 'QUEUE_TOO_LARGE'
          ? 'Move processed files out of the inbox until at most 50 remain, then run again.'
          : code === 'PUBLICATION_UNRESOLVED'
            ? 'Resolve the unresolved publication first. Scheduled runs keep stopping here until then.'
            : 'See the code reference in docs/data-contract.md §14.',
      };
    case 'superseded':
      return {
        title: 'Superseded',
        meaning: 'A later run processed the same batch and marked this row INTERRUPTED inside its own publish. That records a replacement, not a failure.',
        operator: 'Nothing. The later run\'s row is the authoritative result.',
      };
    default:
      return {
        title: 'Unrecognised status',
        meaning: `The row's status "${row.status}" is not one the contract defines. The console does not guess what it means.`,
        operator: 'Check the Run Log tab in the sheet and the n8n execution record.',
      };
  }
}

function explainFailure(run: Run, runs: Run[], code: string): RunExplanation {
  const committed = committedRunOfBatch(run, runs);
  const again = committed
    ? `This list was already committed by run ${committed.id}, so scheduled runs will not process it again. To publish from the current decisions, start a manual reprocess again.`
    : 'The next scheduled run takes the same file again and plans from the current values; after 3 failed attempts the queue stops (RETRY_LIMIT).';
  if (code === 'REVIEW_CHANGED') {
    return {
      title: 'Failed · Review changed during the run',
      meaning: 'Definitive: the final Review check found a decision or note that differs from the read the plan was built from, so the publish was never sent. The edit is kept in the sheet, untouched. Nothing was applied: the catalog is as the last committed run left it.',
      operator: `Process the list again so it plans from the current decisions. ${again}`,
    };
  }
  if (code === 'REVIEW_READ_FAILED') {
    return {
      title: 'Failed · final Review read failed',
      meaning: 'Definitive: the final read of the Review tab failed after three tries, so the publish was never sent. Nothing was applied.',
      operator: `Check that the Review tab can be read, then process the list again. ${again}`,
    };
  }
  if (code === 'PUBLISH_REJECTED') {
    return {
      title: 'Failed · refused by Google',
      meaning: 'Definitive: Google refused the publish, so nothing was applied. FAILED was written only after re-reading this run\'s own row.',
      operator: `Fix the cause in the message (for HTTP 403, the service account's access to the spreadsheet). ${again}`,
    };
  }
  return {
    title: 'Failed',
    meaning: `Definitive failure before anything was published (${code || 'no code recorded'}). FAILED was written only after re-reading this run's own row.`,
    operator: again,
  };
}

/** Contract §11: "IDLE, WAIT and refused manual runs write nothing". */
export const NOT_IN_SHEET_NOTE = 'Runs that found nothing to do, waited, or were refused write nothing to the spreadsheet, so they do not appear here.';

export const formatRunTime = (run: Run): string => formatDateTime(run.row.started_at);

// ---------------------------------------------------------------------------
// Exceptions: severity words as in the design, and what to do per code.

export const SEVERITY: Record<string, { label: string; tone: 'red' | 'amber' | 'neutral'; meaning: string }> = {
  ERROR: { label: 'Rejected', tone: 'red', meaning: 'Failed a field rule' },
  REVIEW: { label: 'Held', tone: 'amber', meaning: 'Held or halted for a person' },
  INFO: { label: 'Collapsed', tone: 'neutral', meaning: 'Exact duplicate, ignored' },
};

export const ACTION_LABEL: Record<string, string> = {
  KEPT_PREVIOUS: 'Kept previous values',
  NOT_ADDED: 'Not added',
  IGNORED: 'Ignored',
  FILE_NOT_PROCESSED: 'File not processed',
};

const SUGGESTION: Record<string, string> = {
  AMBIGUOUS_PRICE: 'SheetOps never guesses a decimal separator. Ask the supplier to send the price with a decimal point; the next list is checked again.',
  INVALID_PRICE: 'Ask the supplier for a positive price with at most 2 decimals.',
  MISSING_PRICE: 'Ask the supplier to fill in the price.',
  CURRENCY_MISMATCH: 'Prices must be in ETB. Ask the supplier for an ETB price.',
  MISSING_SKU: 'The row cannot be matched to a product. Ask the supplier to add the SKU.',
  INVALID_SKU: 'Ask the supplier to correct the SKU to the agreed format.',
  MISSING_NAME: 'Ask the supplier to fill in the product name.',
  NAME_TOO_LONG: 'Ask the supplier for a shorter product name.',
  MISSING_UNIT: 'Ask the supplier to fill in the unit.',
  UNKNOWN_UNIT: 'Use one of the agreed units, or agree the new unit before it is accepted.',
  FIELD_COUNT_MISMATCH: 'The row has the wrong number of columns; check for an unquoted comma.',
  DUPLICATE_COLLAPSED: 'Nothing to do: an identical row was used once.',
  CONFLICTING_DUPLICATE: 'Ask the supplier which row is right. The previous catalog values stay until a list agrees.',
  SIBLING_ROW_INVALID: 'Fix the other row for this SKU; both are held until then.',
  MASS_DISCONTINUE: 'Check the file. If the products really are gone, a manual run with confirm_mass_discontinue processes it.',
  OUT_OF_ORDER_FILE: 'Nothing, unless the file was meant to be newer: then upload it under its real effective date.',
  BAD_FILENAME: 'Save it as CSV, named demo-supplier_YYYY-MM-DD.csv with its effective date.',
  WRONG_SUPPLIER: 'Check that the file is from this supplier and named for it.',
  NOT_A_CSV_FILE: 'Download it as CSV and upload the CSV instead.',
  FILE_TOO_LARGE: 'Split or trim the file below the size limit.',
  CSV_PARSE_ERROR: 'The file is not valid CSV. Export it again from the source.',
  FILE_EMPTY: 'The file has no data rows. Upload the complete list.',
  TOO_MANY_ROWS: 'The list is above the row limit. Split it or ask for a smaller list.',
  MISSING_COLUMN: 'A required column is missing. Check the header row.',
  AMBIGUOUS_COLUMN: 'Two columns map to the same field. Check the header row.',
};

export function suggestionFor(row: ExceptionRow): string {
  return SUGGESTION[row.code] ?? 'See the code reference in docs/data-contract.md §14.';
}

/** A plain-language title per exception code (the code and message are shown too). */
export const EXCEPTION_TITLE: Record<string, string> = {
  AMBIGUOUS_PRICE: 'Price could use a decimal comma',
  INVALID_PRICE: 'Price is not a positive amount',
  MISSING_PRICE: 'Price is missing',
  CURRENCY_MISMATCH: 'Currency is not ETB',
  MISSING_SKU: 'No SKU',
  INVALID_SKU: 'SKU has characters that are not allowed',
  MISSING_NAME: 'Product name is missing',
  NAME_TOO_LONG: 'Product name is too long',
  MISSING_UNIT: 'Unit is missing',
  UNKNOWN_UNIT: 'Unit is not one of the agreed units',
  FIELD_COUNT_MISMATCH: 'Row has the wrong number of columns',
  DUPLICATE_COLLAPSED: 'Identical to an earlier row',
  CONFLICTING_DUPLICATE: 'Another row for this SKU disagrees',
  SIBLING_ROW_INVALID: 'Another row for this SKU was rejected',
  MASS_DISCONTINUE: 'Too many products missing from the list',
  OUT_OF_ORDER_FILE: 'File is older than the committed list',
  BAD_FILENAME: 'File name does not follow the pattern',
  WRONG_SUPPLIER: 'File is for a different supplier',
  NOT_A_CSV_FILE: 'File is not a CSV',
  FILE_TOO_LARGE: 'File is too large',
  CSV_PARSE_ERROR: 'File is not valid CSV',
  FILE_EMPTY: 'File has no data rows',
  TOO_MANY_ROWS: 'File has too many rows',
  MISSING_COLUMN: 'A required column is missing',
  AMBIGUOUS_COLUMN: 'Two columns map to the same field',
};
