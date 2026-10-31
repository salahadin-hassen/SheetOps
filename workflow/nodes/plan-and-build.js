// "Plan and build": runs the core on the downloaded file and the tabs read just
// before this node, then builds the single publish request (contract §12).
// First it checks that the Run Log rows the publish overwrites still hold what
// this run expects. A known failure is definitive, because nothing has been
// sent. Routes: 0 = read Review again, then publish if it is unchanged (§8);
// 1 = check this run's row, then write FAILED; 2 = publish now (rejected and
// halted plans never write Review, so they cannot overwrite a decision).
/* global $, $input, $now, SheetOps */
function main() {
  const prep = $('Prepare run').first().json;
  const picked = $('Select batch').first().json;
  const selection = picked.selection;
  const batch = selection.batch;
  const runRowNumber = SheetOps.parseAppendedRowNumber($('Append STARTED row').first().json);
  const runRow = SheetOps.buildRunRowRequests({ settings: prep.settings, runRowNumber });
  const run = Object.assign({}, picked.run, { finished_at: $now.toUTC().toISO() });

  try {
    const sheetMeta = SheetOps.parseSheetMeta($('Read sheet metadata').first().json);
    const sheet = SheetOps.parseWorkingTabs($input.first().json);
    const staleRuns = SheetOps.verifyRunLogRows({ runLog: sheet.runLog, runRowNumber, run, batch, staleRuns: selection.stale_runs });
    let plan;
    if (selection.action === 'PROCESS') {
      const download = SheetOps.requireRead($('Download CSV').first().json, 'DOWNLOAD_FAILED', `Downloading ${batch.name}`);
      if (typeof download.csv !== 'string') {
        throw new SheetOps.SheetOpsError('DOWNLOAD_FAILED', `Downloading ${batch.name} returned no text`);
      }
      plan = SheetOps.processBatch({
        config: prep.config,
        batch,
        csvText: download.csv,
        run,
        sheet,
        options: { confirm_mass_discontinue: selection.confirm_mass_discontinue },
        stale_runs: staleRuns,
      });
    } else {
      plan = SheetOps.planFileRejection({
        config: prep.config,
        batch,
        run,
        sheet,
        code: selection.code,
        message: selection.message,
        stale_runs: staleRuns,
      });
    }
    const body = SheetOps.buildPublishRequest({ config: prep.config, plan, sheetMeta, runRowNumber });
    return [{
      json: {
        route: plan.writes.review ? 0 : 2,
        run_row: runRow,
        status: plan.status,
        summary: plan.summary,
        http: { url: prep.requests.batch_update, body },
      },
    }];
  } catch (err) {
    // Anything else is a bug: let the run fail, so the STARTED row is
    // recovered as INTERRUPTED by a later run.
    if (!(err instanceof SheetOps.SheetOpsError)) throw err;
    return [{
      json: {
        route: 1,
        run_row: runRow,
        failure: { kind: 'DEFINITIVE', code: err.code, message: err.detail },
      },
    }];
  }
}
