import { open } from 'node:fs/promises';
import { recoverCapacityLearningBatch } from './capacity-learning-recovery.mjs';

/** One append/fsync for arrivals within a short window. Resolve only after fsync. */
export async function createCapacityJournal(file, { windowMs = 5 } = {}) {
  const handle = await open(file, 'ax', 0o600);
  let pending = []; let timer; let tail = Promise.resolve(); let fatal; let closed = false;
  const flush = () => {
    timer = undefined;
    const entries = pending; pending = [];
    if (!entries.length) return tail;
    tail = tail.then(async () => {
      if (fatal) throw fatal;
      await handle.writeFile(entries.map(entry => JSON.stringify(entry.value)).join('\n') + '\n');
      await handle.sync();
    }).then(() => { entries.forEach(entry => entry.resolve()); }, error => {
      fatal = error; entries.forEach(entry => entry.reject(error));
    });
    return tail;
  };
  return {
    append(value) {
      if (fatal || closed) return Promise.reject(fatal ?? new Error('Journal is closed'));
      return new Promise((resolve, reject) => {
        pending.push({ value: structuredClone(value), resolve, reject });
        timer ??= setTimeout(flush, windowMs);
      });
    },
    async close() {
      closed = true; clearTimeout(timer); await flush(); await tail;
      try { if (fatal) throw fatal; } finally { await handle.close(); }
    },
  };
}

/** Independent per-student drain: one immutable batch in flight, bounded queue. */
export function createCapacityLearningOutbox({ journal, send, acknowledged, now = () => performance.now(),
  recoveryOptions = {}, limit = 256 }) {
  const scopes = new Map(); let terminal; let closing = false;
  const operations = []; const batches = [];
  const fail = error => { terminal ??= error; };
  function start(scope) {
    if (scope.flight || terminal || !scope.queue.length) return;
    scope.flight = (async () => {
      while (scope.queue.length && !terminal) {
        const batch = scope.queue.slice(0, 20);
        // Entries are made visible to the drain only after durable enqueue.
        const body = { courseId: scope.courseId, studentId: scope.studentId, events: batch.map(entry => entry.event) };
        const batchEvidence = { studentId: scope.studentId, ids: batch.map(entry => entry.event.id), phase: batch[0].phase };
        batches.push(batchEvidence);
        let result;
        try {
          result = await recoverCapacityLearningBatch(body, (immutable, timeout) => send(scope.actor, immutable, timeout, batch[0].phase), {
            ...recoveryOptions, now,
            onAttempt: attempt => { (batchEvidence.attempts ??= []).push(attempt); },
          });
          const ids = result.value?.acceptedIds;
          if (!Array.isArray(ids) || batch.some(entry => !ids.includes(entry.event.id))) throw new Error('Learning event response did not acknowledge every original event ID');
          Object.assign(batchEvidence, result.evidence);
          const ackAt = now();
          // Durable ACK before removal: interruption can replay, never lose a pending ID.
          await journal.append({ kind: 'ack', at: new Date().toISOString(), studentId: scope.studentId, ids: batchEvidence.ids, evidence: result.evidence });
          const followups = [];
          for (const entry of batch) {
            const operation = { studentId: scope.studentId, id: entry.event.id, phase: entry.phase,
              elapsedMs: ackAt - entry.enqueuedAt, attempts: result.evidence.attempts.length,
              firstFailure: result.evidence.firstFailure, recovered: result.evidence.recovered, status: 'acknowledged' };
            followups.push(Promise.resolve().then(() => acknowledged(scope.actor, entry.event, result.value, operation)));
            operations.push(operation);
          }
          scope.queue.splice(0, batch.length);
          const settled = await Promise.allSettled(followups);
          const failure = settled.find(item => item.status === 'rejected');
          if (failure) throw failure.reason;
        } catch (error) {
          Object.assign(batchEvidence, error.evidence ?? {}, { status: 'unrecovered', error: String(error.message) });
          throw error;
        }
      }
    })().catch(fail).finally(() => { scope.flight = null; if (scope.queue.length && !terminal) start(scope); });
  }
  return {
    async enqueue(actor, courseId, event, phase) {
      if (terminal) throw terminal;
      if (closing) throw new Error('Learning event outbox is closing');
      let scope = scopes.get(actor.id);
      if (!scope) { scope = { actor, studentId: actor.id, courseId, queue: [], reservations: 0, flight: null }; scopes.set(actor.id, scope); }
      if (scope.queue.length + scope.reservations >= limit) {
        const error = new Error(`Learning event pending queue limit ${limit} reached`); fail(error); throw error;
      }
      scope.reservations++;
      const entry = { event: structuredClone(event), phase, enqueuedAt: now() };
      try {
        await journal.append({ kind: 'queued', at: new Date().toISOString(), studentId: actor.id, courseId, phase, event: entry.event });
        scope.queue.push(entry);
      } catch (error) { fail(error); throw error; }
      finally { scope.reservations--; }
      start(scope);
    },
    check() { if (terminal) throw terminal; },
    snapshot() {
      return { mode: 'durable-background-batches', queueLimitPerStudent: limit, batchSize: 20,
        pending: [...scopes.values()].flatMap(scope => scope.queue.map(entry => ({ studentId: scope.studentId, id: entry.event.id, phase: entry.phase, elapsedMs: now() - entry.enqueuedAt, status: terminal ? 'unrecovered' : 'pending' }))),
        queued: operations.length + [...scopes.values()].reduce((sum, scope) => sum + scope.queue.length, 0),
        acknowledged: operations.length, operations: structuredClone(operations), batches: structuredClone(batches),
        ...(terminal ? { error: String(terminal.message) } : {}) };
    },
    async drain({ close = false } = {}) {
      if (close) closing = true;
      for (const scope of scopes.values()) start(scope);
      await Promise.all([...scopes.values()].map(scope => scope.flight));
      if (terminal) throw terminal;
      if ([...scopes.values()].some(scope => scope.queue.length || scope.reservations)) throw new Error('Learning event outbox did not completely drain');
    },
  };
}
