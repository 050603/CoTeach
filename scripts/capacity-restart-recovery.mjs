import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** One end-to-end deadline: restart + real readiness + every WS subscription.
 * Retry only explicitly transient transport failures, retaining all attempts.
 * Dependencies must cancel their actual IO within the passed remaining budget.
 */
export async function recoverCapacityConnections({ actors, restart, readiness, connect,
  now = () => performance.now(), wait = delay, budgetMs = 60000, onProgress = () => {} }) {
  const started = now();
  const remaining = () => Math.max(0, Math.floor(budgetMs - (now() - started)));
  const result = { budgetMs, readinessAttempts: [], connections: actors.map(actor => ({ userId: actor.id, attempts: [], connectedAtMs: null })), readyAtMs: null, latestConnectedAtMs: null };
  onProgress(result);
  await restart(remaining());
  let ready = false;
  while (remaining() > 0) {
    const attempt = { startedAtMs: now() - started };
    result.readinessAttempts.push(attempt);
    try { const response = await readiness(Math.min(3000, remaining())); attempt.status = response.status;
      ready = response.ok === true && response.body?.status === 'ready' && response.body?.dependencies?.websocket?.ok === true;
      attempt.ready = ready;
    } catch (error) { attempt.error = String(error?.message ?? error).slice(0, 200); }
    attempt.finishedAtMs = now() - started;
    if (ready) break;
    if (remaining()) await wait(Math.min(500, remaining()));
  }
  assert.ok(ready && remaining() > 0, 'Application dependencies and WebSocket listener did not become ready within 60 seconds');
  result.readyAtMs = now() - started;
  const settled = await Promise.allSettled(actors.map(async (actor, index) => {
    const record = result.connections[index];
    while (remaining() > 0) {
      const attempt = { startedAtMs: now() - started };
      record.attempts.push(attempt);
      try {
        await connect(actor, Math.min(10000, remaining()));
        attempt.finishedAtMs = now() - started;
        attempt.ok = true;
        assert.ok(remaining() > 0, 'WebSocket subscription exceeded the original 60 second recovery deadline');
        record.connectedAtMs = now() - started;
        return;
      } catch (error) {
        attempt.finishedAtMs = now() - started; attempt.ok = false;
        attempt.error = String(error?.message ?? error).slice(0, 200);
        if (error?.retryable !== true) throw error;
      }
      // Keep retry density below the server's per-identity connection limit.
      const backoff = Math.min(5000, 500 * 2 ** Math.min(record.attempts.length - 1, 4));
      if (remaining()) await wait(Math.min(backoff, remaining()));
    }
    throw new Error('WebSocket did not subscribe within the original 60 second recovery deadline');
  }));
  const times = result.connections.flatMap(row => row.connectedAtMs === null ? [] : [row.connectedAtMs]);
  result.latestConnectedAtMs = times.length ? Math.max(...times) : null;
  onProgress(result);
  const failures = settled.filter(item => item.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(item => item.reason), String(failures[0].reason));
  assert.ok(result.latestConnectedAtMs < budgetMs, 'All reconnects must fit the original recovery budget');
  return result;
}
