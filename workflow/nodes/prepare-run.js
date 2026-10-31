// "Prepare run": checks the Settings node, records how the run was started and
// builds every Google request URL. Runs after src/sheetops-core.js in the same
// Code node, so `SheetOps` is in scope.
/* global $input, $execution, $now, SheetOps */
function main() {
  const options = $input.first().json;
  const settings = SheetOps.checkSettings(options);
  const manual = options.mode === 'manual';
  // Manual-run options only count when someone started the run by hand.
  const params = manual ? {
    target_batch_id: String(options.target_batch_id || '').trim(),
    reprocess_latest: options.reprocess_latest === true,
    confirm_mass_discontinue: options.confirm_mass_discontinue === true,
  } : {};
  const flags = Object.keys(params).filter((key) => (key === 'target_batch_id' ? params[key] !== '' : params[key]));
  const requests = SheetOps.buildGoogleRequests(settings);
  return [{
    json: {
      settings,
      config: { supplier: settings.supplier, currency: settings.currency },
      run: {
        run_id: String($execution.id),
        mode: manual ? ['manual'].concat(flags).join(' ') : 'scheduled',
        started_at: $now.toUTC().toISO(),
      },
      params,
      requests,
      http: { url: requests.list_inbox },
    },
  }];
}
