import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverCapacityLearningBatch } from './capacity-learning-recovery.mjs';
const busy = () => Object.assign(new Error('busy'), { status: 503, payload: { error: 'COURSE_BUSY' } });
test('retries original immutable batch with 10s wait and retains first failure', async () => {
  let time = 0; let calls = 0;
  const body = { events: [{ id: 'original', occurredAt: 'original-time' }] };
  const result = await recoverCapacityLearningBatch(body, async (sent, timeout) => {
    assert.equal(timeout, 10000); assert.equal(sent.events[0].id, 'original'); calls++;
    if (calls === 1) { sent.events[0].id = 'mutated'; time += 10000; throw busy(); }
    time += 20; return { acceptedIds: ['original'] };
  }, { now: () => time, wait: async ms => { assert.equal(ms, 10000); time += ms; } });
  assert.equal(calls, 2); assert.equal(body.events[0].id, 'original');
  assert.equal(result.evidence.elapsedMs, 20020); assert.equal(result.evidence.firstFailure.status, 503);
  assert.equal(result.evidence.recovered, true);
});
test('three failures stop within original 50s deadline with complete evidence', async () => {
  let time = 0; let calls = 0;
  await assert.rejects(recoverCapacityLearningBatch({}, async () => { calls++; time += 10000; throw busy(); }, { now: () => time, wait: async ms => { time += ms; } }), error => {
    assert.equal(error.evidence.attempts.length, 3); assert.equal(error.evidence.elapsedMs, 50000); return true;
  });
  assert.equal(calls, 3);
});
test('authorization/conflict/business errors never retry', async () => {
  for (const status of [400, 401, 403, 409, 500, 503]) {
    let calls = 0;
    await assert.rejects(recoverCapacityLearningBatch({}, async () => { calls++; throw Object.assign(new Error('business'), { status, payload: { code: 'OTHER' } }); }, { wait: async () => assert.fail('must not wait') }));
    assert.equal(calls, 1);
  }
});
test('transport timeout retries, but late response beyond deadline is not acknowledged', async () => {
  let time = 0; let calls = 0;
  await assert.rejects(recoverCapacityLearningBatch({}, async () => {
    calls++; if (calls === 1) throw new DOMException('timeout', 'TimeoutError');
    time = 50001; return {};
  }, { now: () => time, wait: async ms => { time += ms; } }), /not acknowledged/);
});
