import { Histogram } from 'prom-client';
import { getOrCreateRegisteredMetric, register } from './metrics';

export const mutationPhaseDuration = getOrCreateRegisteredMetric(register, 'openpbl_mutation_phase_seconds', () => new Histogram({
  name: 'openpbl_mutation_phase_seconds',
  help: 'Per-attempt wall time: startup includes engine/pool/BEGIN; completion includes COMMIT or rollback and engine delivery, not pure database time. Outcome is the whole attempt.',
  labelNames: ['kind', 'phase', 'outcome'] as const,
  buckets: [.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5, 10],
}));

export function observeMutationPhase(kind: 'student' | 'regular', phase: 'startup' | 'callback' | 'completion', outcome: 'success' | 'error', milliseconds: number): void {
  try { mutationPhaseDuration.observe({ kind, phase, outcome }, Math.max(0, milliseconds) / 1000); }
  catch { /* Observability must never change transaction results or errors. */ }
}
