// "Check Review": the final Review check, just before the publish (contract
// §8). Every operator decision and note must still be what the plan was built
// from in "Read working tabs". A change, or a failed read, is definitive:
// nothing has been published. Every decision cell must also hold a typed value,
// never a formula's result. Routes: 0 = unchanged, publish the request
// "Plan and build" built; 1 = check this run's row, then write FAILED.
/* global $, $input, SheetOps */
function main() {
  const built = $('Plan and build').first().json;
  try {
    const planned = SheetOps.parseWorkingTabs($('Read working tabs').first().json).review;
    const finalRead = $('Re-read Review').first().json;
    SheetOps.checkReviewUnchanged({ planned, finalRead });
    SheetOps.checkReviewDecisionsLiteral({ finalRead, decisionCells: $input.first().json });
    return [{ json: Object.assign({}, built, { route: 0 }) }];
  } catch (err) {
    if (!(err instanceof SheetOps.SheetOpsError)) throw err;
    return [{
      json: {
        route: 1,
        run_row: built.run_row,
        failure: { kind: 'DEFINITIVE', code: err.code, message: err.detail },
      },
    }];
  }
}
