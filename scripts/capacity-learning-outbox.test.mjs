import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCapacityJournal, createCapacityLearningOutbox } from './capacity-learning-outbox.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const actor = { id: 'student' };
const event = id => ({ id, occurredAt: '2026-09-27T00:00:00Z' });

test('journal append is durable, ordered and exclusive; close flushes pending', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'capacity-journal-')); const file = path.join(dir, 'events.jsonl');
  try {
    const journal = await createCapacityJournal(file);
    await assert.rejects(createCapacityJournal(file), /EEXIST/);
    const writes = [journal.append({ kind: 'queued', id: 1 }), journal.append({ kind: 'ack', id: 1 })];
    await journal.close(); await Promise.all(writes);
    assert.deepEqual((await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse), [{ kind: 'queued', id: 1 }, { kind: 'ack', id: 1 }]);
    await assert.rejects(journal.append({}), /closed/);
  } finally { await rm(dir, { recursive: true }); }
});
test('never HTTP before durable enqueue or delete pending before durable ACK', async () => {
  const queued = deferred(); const ack = deferred(); const records = []; let sends = 0; let acknowledged = 0;
  const outbox = createCapacityLearningOutbox({ journal: { append: async row => { records.push(row); await (row.kind === 'queued' ? queued.promise : ack.promise); } },
    send: async () => { sends++; return { acceptedIds: ['a'] }; }, acknowledged: () => { acknowledged++; } });
  const enqueue = outbox.enqueue(actor, 'course', event('a'), 'ai-learning');
  assert.equal(sends, 0); queued.resolve(); await enqueue;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1); assert.equal(acknowledged, 0); assert.equal(outbox.snapshot().pending.length, 1);
  ack.resolve(); await outbox.drain(); assert.equal(acknowledged, 1); assert.equal(outbox.snapshot().pending.length, 0);
  assert.deepEqual(records.map(row => row.kind), ['queued', 'ack']);
});
test('background retry leaves enqueue responsive, batches at 20, single flight per student', async () => {
  let time = 0; const wait = deferred(); let first = true; let active = 0; let max = 0; const sizes = []; const acked = [];
  const outbox = createCapacityLearningOutbox({ journal: { append: async () => {} }, now: () => time,
    recoveryOptions: { wait: async ms => { time += ms; await wait.promise; } },
    send: async (_actor, body) => {
      active++; max = Math.max(max, active); sizes.push(body.events.length); active--;
      if (first) { first = false; throw Object.assign(new Error('busy'), { status: 503, payload: { code: 'COURSE_BUSY' } }); }
      return { acceptedIds: body.events.map(item => item.id) };
    }, acknowledged: (_actor, item) => { acked.push(item.id); } });
  await outbox.enqueue(actor, 'course', event('a'), 'ai-learning');
  await Promise.all(Array.from({ length: 25 }, (_, i) => outbox.enqueue(actor, 'course', event(`b${i}`), 'ai-learning')));
  assert.equal(outbox.snapshot().pending.length, 26); wait.resolve(); await outbox.drain();
  assert.equal(max, 1); assert.deepEqual(sizes, [1, 1, 20, 5]); assert.equal(new Set(acked).size, 26);
  assert.equal(outbox.snapshot().operations[0].elapsedMs, 10000);
});
test('unacknowledged success is terminal and retains original pending event', async () => {
  const outbox = createCapacityLearningOutbox({ journal: { append: async () => {} }, send: async () => ({ acceptedIds: [] }), acknowledged: () => assert.fail('not acknowledged') });
  await outbox.enqueue(actor, 'course', event('a'), 'ai-learning');
  await assert.rejects(outbox.drain(), /every original/);
  assert.equal(outbox.snapshot().pending[0].id, 'a'); assert.throws(() => outbox.check());
});
test('overflow preserves old queue and final drain waits all actual IO', async () => {
  const io = deferred(); let finished = false;
  const outbox = createCapacityLearningOutbox({ limit: 1, journal: { append: async () => {} }, send: async () => { await io.promise; finished = true; return { acceptedIds: ['a'] }; }, acknowledged: () => {} });
  await outbox.enqueue(actor, 'course', event('a'), 'ai-learning');
  await assert.rejects(outbox.enqueue(actor, 'course', event('b'), 'ai-learning'), /limit/);
  const drain = outbox.drain({ close: true }); assert.equal(finished, false); io.resolve(); await assert.rejects(drain, /limit/);
  assert.equal(finished, true);
});
test('journal error prevents sending and becomes a terminal failure', async () => {
  const outbox = createCapacityLearningOutbox({ journal: { append: async () => { throw new Error('disk full'); } }, send: async () => assert.fail('must not send'), acknowledged: () => {} });
  await assert.rejects(outbox.enqueue(actor, 'course', event('a'), 'ai-learning'), /disk full/);
  await assert.rejects(outbox.drain(), /disk full/);
});
test('ACK followup state reads complete before drain but are excluded from save latency', async () => {
  let time = 0; const read = deferred(); let reads = 0; let measured;
  const outbox = createCapacityLearningOutbox({ journal: { append: async () => {} }, now: () => time,
    send: async () => { time = 123; return { acceptedIds: ['a'] }; },
    acknowledged: async (_actor, _event, _ack, operation) => { measured = operation.elapsedMs; reads++; await read.promise; time = 10000; } });
  await outbox.enqueue(actor, 'course', event('a'), 'ai-learning');
  let drained = false; const drain = outbox.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(measured, 123); assert.equal(drained, false);
  read.resolve(); await drain; assert.equal(outbox.snapshot().operations[0].elapsedMs, 123);
});
