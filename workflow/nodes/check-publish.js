// "Check publish": reads the publish response (contract §12). Routes:
// 0 = Google applied it, 1 = Google refused it (definitive: check this run's
// row, then write FAILED), 2 = outcome unknown (wait, then reconcile against
// the commit marker; nothing is written).
/* global $, $input, SheetOps */
function main() {
  const built = $('Plan and build').first().json;
  const result = SheetOps.interpretPublishResponse($input.first().json);

  if (result.outcome === 'APPLIED') {
    return [{ json: { route: 0, outcome: 'PUBLISHED', http_status: result.httpStatus } }];
  }
  const failure = SheetOps.publishFailure(result);
  return [{
    json: {
      route: failure.kind === 'DEFINITIVE' ? 1 : 2,
      outcome: failure.code,
      http_status: result.httpStatus === undefined ? null : result.httpStatus,
      run_row: built.run_row,
      failure,
    },
  }];
}
