import { setTimeout as delay } from 'node:timers/promises';

export function retryableLearningFailure(error) {
  if (error?.status !== undefined) return error.status === 503 && (error.payload?.code ?? error.payload?.error) === 'COURSE_BUSY';
  return error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name);
}

/** Immutable event batch; each real request receives the remaining IO deadline.
 * All attempts must pass through the caller's normal request metrics collector.
 */
export async function recoverCapacityLearningBatch(body, operation, {
  now = () => performance.now(), wait = delay, onAttempt = () => {}, budgetMs = 50000,
} = {}) {
  const original = JSON.stringify(body);
  const started = now();
  const evidence = { attempts: [], elapsedMs: 0, recovered: false, firstFailure: null };
  for (let index = 0; index < 3; index++) {
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) break;
    const attempt = { number: index + 1, startedAtMs: now() - started };
    evidence.attempts.push(attempt);
    try {
      const value = await operation(JSON.parse(original), Math.min(10000, Math.ceil(remaining)));
      if (now() - started > budgetMs) throw new Error('Learning event recovery deadline exceeded');
      attempt.status = 200; attempt.ok = true; attempt.elapsedMs = now() - started - attempt.startedAtMs;
      evidence.elapsedMs = now() - started; evidence.recovered = index > 0;
      onAttempt(structuredClone(attempt));
      return { value, evidence };
    } catch (error) {
      attempt.status = error?.status ?? null; attempt.code = error?.payload?.code ?? error?.payload?.error ?? null;
      attempt.ok = false; attempt.elapsedMs = now() - started - attempt.startedAtMs;
      attempt.error = String(error?.message ?? error).slice(0, 300);
      evidence.firstFailure ??= structuredClone(attempt);
      evidence.elapsedMs = now() - started;
      onAttempt(structuredClone(attempt));
      if (!retryableLearningFailure(error) || index === 2 || budgetMs - evidence.elapsedMs <= 10000) {
        throw Object.assign(new Error('Learning event batch was not acknowledged', { cause: error }), { evidence });
      }
      attempt.retryWaitMs = 10000;
      await wait(10000);
    }
  }
  evidence.elapsedMs = now() - started;
  throw Object.assign(new Error('Learning event recovery deadline exceeded'), { evidence });
}
