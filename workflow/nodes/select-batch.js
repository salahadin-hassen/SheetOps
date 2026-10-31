// "Select batch": picks the next source version (contract §2) and prepares the
// Run Log row this run appends, if any. Routes: 0 = start processing,
// 1 = append a BLOCKED row, 2 = nothing to do.
/* global $, $input, SheetOps */
function main() {
  const prep = $('Prepare run').first().json;
  const listing = SheetOps.parseDriveListing($('List inbox').first().json);
  const runLog = SheetOps.parseValueRange($input.first().json, 'the Run Log tab');
  const selection = SheetOps.selectNextBatch({
    config: prep.config,
    files: listing.files,
    listing_complete: listing.complete,
    runLog,
    now: prep.run.started_at,
    params: prep.params,
  });
  const run = Object.assign({}, prep.run, { queue_remaining: selection.queue_remaining });
  const append = (row) => ({
    url: prep.requests.append_run_row,
    body: { values: [SheetOps.rowToValues(SheetOps.RUNLOG_COLUMNS, row)] },
  });

  let route = 2;
  let http = null;
  if (selection.action === 'PROCESS' || selection.action === 'REJECT_FILE') {
    route = 0;
    http = append(SheetOps.buildStartedRow(run, selection.batch));
  } else if (selection.action === 'BLOCKED') {
    route = 1;
    http = append(SheetOps.buildBlockedRow(Object.assign({}, run, { finished_at: run.started_at }), selection));
  }
  return [{
    json: {
      route,
      selection,
      run,
      download_url: selection.action === 'PROCESS' ? SheetOps.googleDownloadUrl(selection.batch.file_id) : '',
      http,
    },
  }];
}
