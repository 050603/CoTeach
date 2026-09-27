import { AsyncLocalStorage } from 'node:async_hooks';
import { LlmRateLimitError } from './errors';

type Waiter = { start: () => void; reject: (error: unknown) => void; cleanup: () => void };
const priorityContext = new AsyncLocalStorage<'background'>();

export function createClassroomAiCapacity(limit: number, maxPending = 80, waitMs = 10_000) {
  let active = 0;
  const queue: Waiter[] = [];
  function acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const background = priorityContext.getStore() === 'background';
    const available = background ? Math.max(1, limit - 2) : limit;
    if (active < available && queue.length === 0) {
      active++;
      return Promise.resolve(releaseOnce());
    }
    // Background checks yield immediately; interactive work owns the waiting queue.
    if (background || queue.length >= maxPending) return Promise.reject(new LlmRateLimitError(waitMs, '课堂 AI 正忙，请稍后重试'));
    return new Promise((resolve, reject) => {
      const remove = (error: unknown) => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1); waiter.cleanup(); reject(error);
      };
      const abort = () => remove(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => remove(new LlmRateLimitError(waitMs, '课堂 AI 排队超时')), waitMs);
      timer.unref?.();
      const waiter: Waiter = {
        reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
        start: () => { waiter.cleanup(); active++; resolve(releaseOnce()); },
      };
      queue.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true; active--;
      queue.shift()?.start();
    };
  }
  return {
    snapshot: () => ({ active, pending: queue.length, limit }),
    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const release = await acquire(signal);
      try { signal?.throwIfAborted(); return await operation(); } finally { release(); }
    },
  };
}

declare global { var __openPblClassroomAiCapacity: ReturnType<typeof createClassroomAiCapacity> | undefined; }
const configured = Number(process.env.CLASSROOM_AI_CONCURRENCY || 40);
const capacity = globalThis.__openPblClassroomAiCapacity ??= createClassroomAiCapacity(
  Number.isInteger(configured) && configured > 0 ? Math.min(80, configured) : 40,
);
export const classroomAiCapacitySnapshot = capacity.snapshot;
export const withClassroomAiCapacity = capacity.run;
export function withBackgroundAiPriority<T>(operation: () => Promise<T>): Promise<T> {
  return priorityContext.run('background', operation);
}
