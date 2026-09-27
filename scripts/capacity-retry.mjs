import { setTimeout as delay } from 'node:timers/promises';

/** Retry only an explicit, retryable server failure; caller keeps one immutable request body/ID. */
export async function recoverCapacityAiRequest(operation, { onRetry = () => {}, wait = delay, budgetMs = 60000 } = {}) {
  const started = performance.now();
  for (let attempt = 1; ; attempt++) {
    const remaining = budgetMs - (performance.now() - started);
    if (remaining <= 0) throw new Error('AI recovery deadline exceeded');
    try {
      const value = await operation(Math.ceil(remaining));
      return { value, attempts: attempt, elapsedMs: performance.now() - started };
    } catch (error) {
      if (attempt >= 2 || ![429, 503, 504].includes(error.status) || error.payload?.retryable !== true) throw error;
      onRetry({ attempt, status: error.status, error: error.payload.error });
      await wait(Math.min(300, Math.max(0, budgetMs - (performance.now() - started))));
    }
  }
}
