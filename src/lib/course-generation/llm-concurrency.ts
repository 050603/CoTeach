import { AsyncLocalStorage } from "node:async_hooks";

type CourseGenerationLlmContext = {
  workload: "course-generation";
  onTokenUsage?: (
    totalTokens: number,
    source: "provider" | "estimated",
  ) => Promise<void> | void;
};

export function estimateCourseGenerationTokens(characterCount: number): number {
  if (!Number.isFinite(characterCount) || characterCount <= 0) return 0;
  // Course prompts mix Chinese prose, JSON and English identifiers. A token
  // per 2.5 characters is intentionally a simple UI estimate for providers
  // that do not return usage metadata.
  return Math.ceil(characterCount / 2.5);
}

export async function reportCourseGenerationTokenUsage(
  reportedTotal: number | null | undefined,
  fallbackCharacterCount = 0,
): Promise<void> {
  const callback = context.getStore()?.onTokenUsage;
  if (!callback) return;
  const providerTotal = typeof reportedTotal === "number" && Number.isFinite(reportedTotal)
    ? Math.max(0, Math.round(reportedTotal))
    : 0;
  const totalTokens = providerTotal || estimateCourseGenerationTokens(fallbackCharacterCount);
  if (totalTokens > 0) await callback(totalTokens, providerTotal > 0 ? "provider" : "estimated");
}

type QueuedTask<T> = {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  removeAbortListener?: () => void;
};

export type FifoConcurrencyLimiter = {
  run<T>(fn: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  snapshot(): { active: number; queued: number; limit: number };
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Course generation LLM request aborted while queued");
}

export function createFifoConcurrencyLimiter(rawLimit: number): FifoConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(rawLimit));
  let active = 0;
  const queue: Array<QueuedTask<unknown>> = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const task = queue.shift()!;
      task.removeAbortListener?.();
      if (task.signal?.aborted) {
        task.reject(abortReason(task.signal));
        continue;
      }
      active += 1;
      void task.fn()
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    run<T>(fn: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<T>((resolve, reject) => {
        const task: QueuedTask<T> = { fn, resolve, reject, signal };
        if (signal) {
          const onAbort = () => {
            const index = queue.indexOf(task as QueuedTask<unknown>);
            if (index < 0) return;
            queue.splice(index, 1);
            reject(abortReason(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          task.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
        queue.push(task as QueuedTask<unknown>);
        pump();
      });
    },
    snapshot: () => ({ active, queued: queue.length, limit }),
  };
}

export function resolveCourseGenerationLlmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(
    env.COURSE_GENERATION_LLM_CONCURRENCY ?? env.PARALLEL_SCENE_CONCURRENCY ?? "",
    10,
  );
  if (!Number.isFinite(configured) || configured <= 0) return 4;
  return Math.min(5, Math.max(1, configured));
}

declare global {
  var __openPblCourseGenerationLlmContext: AsyncLocalStorage<CourseGenerationLlmContext> | undefined;
  var __openPblCourseGenerationLlmLimiter: FifoConcurrencyLimiter | undefined;
}

const context = globalThis.__openPblCourseGenerationLlmContext
  ?? new AsyncLocalStorage<CourseGenerationLlmContext>();
globalThis.__openPblCourseGenerationLlmContext = context;

const limiter = globalThis.__openPblCourseGenerationLlmLimiter
  ?? createFifoConcurrencyLimiter(resolveCourseGenerationLlmConcurrency());
globalThis.__openPblCourseGenerationLlmLimiter = limiter;

export function isCourseGenerationLlmContext(): boolean {
  return context.getStore()?.workload === "course-generation";
}

export function runWithCourseGenerationLlmContext<T>(
  fn: () => T,
  options: Pick<CourseGenerationLlmContext, "onTokenUsage"> = {},
): T {
  return context.run({ workload: "course-generation", ...options }, fn);
}

export function withCourseGenerationLlmSlot<T>(
  fn: () => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return isCourseGenerationLlmContext()
    ? limiter.run(fn, options)
    : fn();
}
