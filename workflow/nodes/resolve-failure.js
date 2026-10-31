// "Resolve failure": every failure after the STARTED row exists ends here,
// with this run's row just read (contract §12). FAILED is written only after a
// definitive failure, and only over this run's own STARTED row. After an
// unknown publish outcome nothing is written. Routes: 0 = write nothing,
// 1 = write FAILED.
/* global $, $input, $now, SheetOps */
function main() {
  const prep = $('Prepare run').first().json;
  const picked = $('Select batch').first().json;
  const built = $('Plan and build').first().json;
  // The failure comes from the publish, the final Review check, or planning.
  let source = built;
  if ($('Check publish').isExecuted) source = $('Check publish').first().json;
  else if ($('Check Review').isExecuted) source = $('Check Review').first().json;
  const run = Object.assign({}, picked.run, { finished_at: $now.toUTC().toISO() });

  const resolved = SheetOps.resolveRunFailure({
    failure: source.failure,
    rowRead: $input.first().json,
    runRowNumber: built.run_row.number,
    run,
    batch: picked.selection.batch,
    expectedStatus: built.status,
  });
  return [{
    json: {
      route: resolved.write ? 1 : 0,
      outcome: resolved.outcome,
      run_status: resolved.run_status,
      code: resolved.code,
      message: resolved.message,
      http: resolved.write
        ? SheetOps.buildRunRowUpdateRequest({ settings: prep.settings, runRowNumber: built.run_row.number, row: resolved.write })
        : null,
    },
  }];
}
