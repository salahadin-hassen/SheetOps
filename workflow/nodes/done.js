// "Done": one summary item for the n8n execution record. Every path ends here.
// `run_status` is what this run's Run Log row should now show ('' = no row).
// `code` and `message` keep the diagnosis, including PUBLISH_OUTCOME_UNKNOWN
// and RUN_ROW_UNVERIFIED, which are never written to the spreadsheet.
// This node does not include the core.
/* global $ */
function main() {
  const ran = (name) => $(name).isExecuted;
  const out = (name) => $(name).first().json;
  const picked = out('Select batch');
  const selection = picked.selection;
  const result = {
    run_id: picked.run.run_id,
    mode: picked.run.mode,
    action: selection.action,
    batch_id: selection.batch ? selection.batch.batch_id : '',
    source_name: selection.batch ? selection.batch.name : '',
    run_status: '',
    code: selection.code,
    message: selection.message,
    summary: null,
  };

  if (ran('Plan and build')) {
    const built = out('Plan and build');
    result.summary = built.summary || null;
    if (ran('Resolve failure')) {
      const resolved = out('Resolve failure');
      Object.assign(result, { run_status: resolved.run_status, code: resolved.code, message: resolved.message });
    } else if (ran('Check publish')) {
      result.run_status = built.status;
    }
  } else if (ran('Append BLOCKED row')) {
    result.run_status = 'BLOCKED';
  }
  return [{ json: result }];
}
