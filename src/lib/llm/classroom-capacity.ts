import { AsyncLocalStorage } from 'node:async_hooks';
import { LlmRateLimitError } from './errors';
import { recordAiAdmission } from '@/lib/observability/classroom-ai';

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
    acquire,
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
export async function withClassroomAiCapacity<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireClassroomAiCapacity(signal);
  try { signal?.throwIfAborted(); return await operation(); } finally { release(); }
}
export async function acquireClassroomAiCapacity(signal?: AbortSignal): Promise<() => void> {
  const started = performance.now();
  const priority = priorityContext.getStore() === 'background' ? 'background' : 'interactive';
  try {
    const release = await capacity.acquire(signal);
    recordAiAdmission(priority, 'admitted', (performance.now() - started) / 1000);
    return release;
  } catch (error) {
    recordAiAdmission(priority, 'rejected', (performance.now() - started) / 1000);
    throw error;
  }
}

/** Holds capacity for the whole stream, including consumer cancellation. */
export async function* withClassroomAiStream<T>(
  operation: (signal: AbortSignal) => AsyncIterable<T>, signal?: AbortSignal,
): AsyncGenerator<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const release = await acquireClassroomAiCapacity(combined);
  let iterator: AsyncIterator<T> | undefined;
  try {
    combined.throwIfAborted();
    iterator = operation(combined)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // SDK streams may await upstream completion in iterator.return(). Abort
    // first, otherwise cancelling a tee branch can deadlock with that cleanup.
    controller.abort();
    try { await iterator?.return?.(); } finally { release(); }
  }
}
export function withBackgroundAiPriority<T>(operation: () => Promise<T>): Promise<T> {
  return priorityContext.run('background', operation);
}
