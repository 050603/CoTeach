import test from 'node:test';
import assert from 'node:assert/strict';
import { markCapacityFailure, finalizeCapacityRun, completeCapacityPhase } from './capacity-finalization.mjs';

test('final monitoring invalidates passed and partial results before persistence', async () => {
  for (const outcome of ['passed', 'partial', 'running']) {
    const report = { outcome }; let saved;
    await finalizeCapacityRun({ report, steps: [['monitor', async () => { markCapacityFailure(report, 'backup stale'); throw new Error('backup stale'); }]], persist: async () => { saved = structuredClone(report); } });
    assert.equal(saved.outcome, 'failed'); assert.equal(saved.stopReason, 'backup stale');
  }
});
test('report write failure never prevents database or network cleanup and preserves original fatal', async () => {
  const report = { outcome: 'failed', stopReason: 'original', checks: [{ name: 'fatal', detail: 'original exception' }] };
  const calls = [];
  await finalizeCapacityRun({ report, steps: [
    ['report', async () => { calls.push('report'); throw new Error('disk full'); }],
    ['database', async () => { calls.push('database'); throw new Error('disconnect failed'); }],
    ['network', async () => { calls.push('network'); }],
  ], persist: async () => { calls.push('persist'); throw new Error('disk full'); } });
  assert.deepEqual(calls, ['report', 'database', 'network', 'persist']);
  assert.equal(report.stopReason, 'original'); assert.equal(report.checks[0].detail, 'original exception');
  assert.equal(report.finalizationFailures.length, 3);
});
test('successful cleanup keeps successful result and persists once at end', async () => {
  const report = { outcome: 'passed' }; const calls = [];
  await finalizeCapacityRun({ report, steps: [['cleanup', async () => calls.push('cleanup')]], persist: async () => calls.push('persist') });
  assert.equal(report.outcome, 'passed'); assert.deepEqual(calls, ['cleanup', 'persist']);
});
test('phase duration records actual unequal durations without adding per-phase gates', () => {
  const phase = { startedAt: '2026-09-27T00:00:00.000Z' };
  completeCapacityPhase(phase, Date.parse(phase.startedAt) + 3599123);
  assert.equal(phase.actualSeconds, 3599.123);
  completeCapacityPhase(phase, Date.parse(phase.startedAt) + 7200000);
  assert.equal(phase.actualSeconds, 3599.123);
  const unstarted = { ticks: 0 }; completeCapacityPhase(unstarted); assert.deepEqual(unstarted, { ticks: 0 });
});
