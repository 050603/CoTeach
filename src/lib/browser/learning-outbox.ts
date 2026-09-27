import { browserRandomUUID } from './random-uuid';

const PREFIX = 'openpbl.learning-outbox.v1:';
export interface OutboxEntry<T> { id: string; createdAt: number; value: T }
const drains = new Map<string, Promise<void>>();

function prefix(scope: string): string { return `${PREFIX}${encodeURIComponent(scope)}:`; }

/** Each item has its own key, so another tab cannot overwrite the queue. */
export function enqueueLearningWrite<T>(scope: string, value: T, id = browserRandomUUID()): OutboxEntry<T> {
  const latest = readLearningWrites<T>(scope).at(-1)?.createdAt ?? 0;
  const entry = { id, createdAt: Math.max(Date.now(), latest + 1), value };
  localStorage.setItem(`${prefix(scope)}${id}`, JSON.stringify(entry));
  return entry;
}

export function readLearningWrites<T>(scope: string): OutboxEntry<T>[] {
  const entries: OutboxEntry<T>[] = [];
  const start = prefix(scope);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(start)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const entry = JSON.parse(raw) as OutboxEntry<T>;
    if (!entry.id || !Number.isFinite(entry.createdAt) || !('value' in entry)) {
      throw new Error('本地学习记录无法读取，请保留此浏览器并联系教师。');
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Remove only acknowledged items. Failed/unmounted/reloaded requests remain durable. */
export function drainLearningWrites<T>(scope: string, send: (value: T, id: string) => Promise<void>): Promise<void> {
  return drainLearningWriteBatches<T>(scope, async (values, ids) => send(values[0], ids[0]), 1);
}

export function drainLearningWriteBatches<T>(scope: string, send: (values: T[], ids: string[]) => Promise<void>, batchSize = 20): Promise<void> {
  const existing = drains.get(scope);
  if (existing) return existing;
  const drain = (async () => {
    // Re-read after every acknowledgement to include writes made during send.
    for (;;) {
      const entries = readLearningWrites<T>(scope).slice(0, batchSize);
      if (!entries.length) return;
      await send(entries.map((entry) => entry.value), entries.map((entry) => entry.id));
      for (const entry of entries) localStorage.removeItem(`${prefix(scope)}${entry.id}`);
    }
  })();
  drains.set(scope, drain);
  void drain.finally(() => { if (drains.get(scope) === drain) drains.delete(scope); }).catch(() => undefined);
  return drain;
}
