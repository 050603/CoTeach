import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Counter, Histogram, register } from 'prom-client';
import { getOrCreateRegisteredMetric } from './metrics';
import { logger } from './logger';

type UsageContext = { feature: string; courseId?: string; studentId?: string; requestId?: string };
const context = new AsyncLocalStorage<UsageContext>();
export function withClassroomAiUsage<T>(scope: UsageContext, operation: () => T): T {
  return context.run(scope, operation);
}

const calls = getOrCreateRegisteredMetric(register, 'classroom_ai_calls_total', () => new Counter({
  name: 'classroom_ai_calls_total', help: 'Model attempts, including failed and aborted attempts.',
  labelNames: ['feature', 'provider', 'model', 'outcome', 'usage_source'] as const,
}));
const tokens = getOrCreateRegisteredMetric(register, 'classroom_ai_tokens_total', () => new Counter({
  name: 'classroom_ai_tokens_total', help: 'Provider-reported tokens only; missing usage is not zero usage.',
  labelNames: ['feature', 'provider', 'model', 'kind'] as const,
}));
const cache = getOrCreateRegisteredMetric(register, 'classroom_ai_cache_total', () => new Counter({
  name: 'classroom_ai_cache_total', help: 'Application result reuse, separate from provider token caching.',
  labelNames: ['feature', 'outcome'] as const,
}));
const wait = getOrCreateRegisteredMetric(register, 'classroom_ai_admission_seconds', () => new Histogram({
  name: 'classroom_ai_admission_seconds', help: 'Time waiting for classroom AI capacity.',
  labelNames: ['priority', 'outcome'] as const, buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10],
}));

export function recordAiCacheEvent(feature: string, outcome: 'hit' | 'miss' | 'joined'): void {
  try {
    cache.inc({ feature, outcome });
    logger.info({ event: 'classroom-ai-cache', ...context.getStore(), feature, outcome }, 'Classroom AI result reuse');
  } catch { /* A metrics failure must not invalidate a reusable result. */ }
}
export function recordAiAdmission(priority: 'interactive' | 'background', outcome: 'admitted' | 'rejected', seconds: number): void {
  try { wait.observe({ priority, outcome }, Math.max(0, seconds)); } catch { /* Diagnostic only. */ }
}

export type ClassroomAiUsage = {
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number;
};
function count(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One record per model attempt. Never include prompt, response, credentials or personal work. */
export function startClassroomAiCall(source: string, provider: string, model: string, attempt = 1) {
  const scope = context.getStore();
  const feature = scope?.feature ?? source;
  const callId = randomUUID();
  const started = performance.now();
  let recorded = false;
  return (outcome: 'response' | 'failed' | 'aborted', usage?: ClassroomAiUsage) => {
    if (recorded) return;
    recorded = true;
    const measured = {
      inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens),
      cacheReadTokens: count(usage?.cacheReadTokens), cacheWriteTokens: count(usage?.cacheWriteTokens),
      reasoningTokens: count(usage?.reasoningTokens), totalTokens: count(usage?.totalTokens),
    };
    const usageSource = measured.inputTokens !== null || measured.outputTokens !== null || measured.totalTokens !== null
      ? 'provider' : 'unknown';
    // Observability must never fail a completed answer or cause another paid request.
    try {
      calls.inc({ feature, provider, model, outcome, usage_source: usageSource });
      for (const [kind, value] of Object.entries(measured)) {
        if (value !== null) tokens.inc({ feature, provider, model, kind }, value);
      }
      logger.info({ event: 'classroom-ai-usage', ...scope, feature, source, provider, model,
        callId, attempt, outcome, usageSource, ...measured,
        durationMs: Math.round(performance.now() - started) }, 'Classroom AI call completed');
    } catch { /* Metrics failure cannot change the classroom result. */ }
  };
}
