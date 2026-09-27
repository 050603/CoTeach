import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverCapacityConnections } from './capacity-restart-recovery.mjs';
const ready = { ok: true, status: 200, body: { status: 'ready', dependencies: { websocket: { ok: true } } } };
test('ignores live-style 200, records transient upgrade failures and waits for all 42 subscriptions', async () => {
  let clock = 0, polls = 0; const attempts = new Map(); let evidence;
  const actors = Array.from({ length: 42 }, (_, id) => ({ id: String(id) }));
  const result = await recoverCapacityConnections({ actors, now: () => clock, wait: async ms => { clock += ms; },
    restart: async budget => { assert.equal(budget, 60000); clock += 10000; },
    readiness: async () => ++polls === 1 ? { ok: true, status: 200, body: { status: 'alive' } } : ready,
    connect: async (actor, timeout) => { assert.ok(timeout <= 10000); const attempt = (attempts.get(actor.id) ?? 0) + 1; attempts.set(actor.id, attempt);
      if (actor.id === '0' && attempt === 1) throw Object.assign(Error('WebSocket upgrade HTTP 502'), { retryable: true }); },
    onProgress: value => { evidence = value; },
  });
  assert.equal(result.connections.length, 42); assert.equal(result.readinessAttempts.length, 2);
  assert.equal(result.connections[0].attempts.length, 2); assert.equal(result.connections[0].attempts[0].ok, false);
  assert.equal(evidence, result); assert.ok(result.latestConnectedAtMs >= result.readyAtMs && result.latestConnectedAtMs < 60000);
});
test('does not grant a new deadline to a subscription after restart used 59 seconds', async () => {
  let clock = 0; let evidence;
  await assert.rejects(recoverCapacityConnections({ actors: [{ id: '1' }], now: () => clock, wait: async ms => { clock += ms; },
    restart: async () => { clock += 59000; }, readiness: async () => ready,
    connect: async (_actor, timeout) => { assert.equal(timeout, 1000); clock += timeout; throw Object.assign(Error('timeout'), { retryable: true }); },
    onProgress: value => { evidence = value; },
  }), /60 second/);
  assert.equal(clock, 60000); assert.equal(evidence.connections[0].attempts.length, 1); assert.equal(evidence.latestConnectedAtMs, null);
});
test('subscription resolving beyond the deadline still fails and records the attempt', async () => {
  let clock = 0; let evidence;
  await assert.rejects(recoverCapacityConnections({ actors: [{ id: '1' }], now: () => clock,
    restart: async () => {}, readiness: async () => ready, connect: async () => { clock = 60001; },
    onProgress: value => { evidence = value; },
  }), /60 second/);
  assert.equal(evidence.connections[0].attempts[0].ok, false);
});
test('does not retry an authorization failure and still waits for the other connection result', async () => {
  let calls = 0; let finished = false; let evidence;
  await assert.rejects(recoverCapacityConnections({ actors: [{ id: '1' }, { id: '2' }],
    restart: async () => {}, readiness: async () => ready,
    connect: async actor => { calls++; if (actor.id === '1') throw Object.assign(Error('HTTP 401'), { retryable: false });
      await new Promise(resolve => setTimeout(resolve, 10)); finished = true; }, onProgress: value => { evidence = value; },
  }), /HTTP 401/);
  assert.equal(calls, 2); assert.equal(finished, true); assert.equal(evidence.connections[1].attempts[0].ok, true);
});
