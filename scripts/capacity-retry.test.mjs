import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverCapacityAiRequest } from './capacity-retry.mjs';

const unavailable = () => Object.assign(new Error('temporary'), { status: 503, payload: { retryable: true, error: 'AI_COLLABORATION_FAILED' } });
test('retries an explicit recoverable failure once and retains its observation', async () => {
  let calls = 0; const failures = [];
  const result = await recoverCapacityAiRequest(async remaining => {
    assert.ok(remaining > 0 && remaining <= 60000);
    if (++calls === 1) throw unavailable();
    return { requestId: 'stable', status: 'completed' };
  }, { wait: async () => {}, onRetry: failure => failures.push(failure) });
  assert.equal(result.attempts, 2); assert.equal(result.value.requestId, 'stable');
  assert.deepEqual(failures, [{ attempt: 1, status: 503, error: 'AI_COLLABORATION_FAILED' }]);
});
test('does not loop on a repeated server failure', async () => {
  let calls = 0;
  await assert.rejects(recoverCapacityAiRequest(async () => { calls++; throw unavailable(); }, { wait: async () => {} }));
  assert.equal(calls, 2);
});
test('does not retry conflicts, unmarked failures or ambiguous client timeouts', async () => {
  for (const error of [Object.assign(unavailable(), { status: 409 }), Object.assign(unavailable(), { payload: {} }), new Error('timeout')]) {
    let calls = 0;
    await assert.rejects(recoverCapacityAiRequest(async () => { calls++; throw error; }, { wait: async () => {} }));
    assert.equal(calls, 1);
  }
});
test('honors an expired overall budget before making a request', async () => {
  let calls = 0;
  await assert.rejects(recoverCapacityAiRequest(async () => { calls++; }, { budgetMs: 0 }), /deadline/);
  assert.equal(calls, 0);
});
