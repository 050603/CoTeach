/** Final evidence failures must never leave a successful acceptance result. */
export function markCapacityFailure(report, reason) {
  report.outcome = 'failed';
  report.stopReason ??= reason;
  report.finalizationFailures ??= [];
  if (!report.finalizationFailures.includes(reason)) report.finalizationFailures.push(reason);
}

/** Every cleanup is attempted; existing fatal checks and stop reasons are retained. */
export async function finalizeCapacityRun({ report, steps, persist, onError = () => {} }) {
  for (const [name, operation] of steps) {
    try { await operation(); }
    catch (error) {
      const reason = `${name}: ${String(error?.message ?? error)}`;
      markCapacityFailure(report, reason);
      onError(reason);
    }
  }
  try { await persist(); }
  catch (error) {
    const reason = `report persistence: ${String(error?.message ?? error)}`;
    markCapacityFailure(report, reason);
    onError(reason);
  }
}

export function completeCapacityPhase(phase, now = Date.now()) {
  if (!phase?.startedAt || phase.completedAt) return;
  phase.completedAt = new Date(now).toISOString();
  phase.actualSeconds = Math.max(0, (now - Date.parse(phase.startedAt)) / 1000);
}
