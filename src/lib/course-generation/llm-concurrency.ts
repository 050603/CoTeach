import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type CourseGenerationCallUsage = {
  callId: string;
  source: string;
  modelId?: string;
  provider?: string;
  attempt: number;
  transportRetry: boolean;
  outcome: "response" | "failed" | "aborted";
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Cache and reasoning counts are subsets, never added to totalTokens. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  usageSource: "provider" | "estimated";
};

export type CourseGenerationTokenUsageDetails = Partial<CourseGenerationCallUsage> & {
  inputCharacters?: number;
  outputCharacters?: number;
  reasoningCharacters?: number;
};

type CallMetadata = Pick<CourseGenerationCallUsage,
  "callId" | "source" | "modelId" | "provider" | "attempt" | "transportRetry">;

type CourseGenerationLlmContext = {
  workload: "course-generation";
  onTokenUsage?: (
    totalTokens: number,
    source: "provider" | "estimated",
  ) => Promise<void> | void;
  onCallUsage?: (usage: CourseGenerationCallUsage) => Promise<void> | void;
  call?: Partial<CallMetadata>;
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
  details: CourseGenerationTokenUsageDetails = {},
): Promise<void> {
  const store = context.getStore();
  if (!store?.onTokenUsage && !store?.onCallUsage) return;
  const tokens = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value)) : undefined;
  const reported = tokens(reportedTotal);
  const inputTokens = tokens(details.inputTokens);
  const outputTokens = tokens(details.outputTokens);
  const derivedTotal = inputTokens !== undefined && outputTokens !== undefined
    ? inputTokens + outputTokens : undefined;
  const providerTotal = reported ?? derivedTotal;
  const totalTokens = providerTotal ?? estimateCourseGenerationTokens(fallbackCharacterCount);
  const usageSource = details.usageSource ?? (providerTotal !== undefined ? "provider" : "estimated");
  const metadata = { ...details, ...store?.call };
  const usage: CourseGenerationCallUsage = {
    callId: metadata.callId ?? randomUUID(),
    source: metadata.source ?? "unknown",
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(metadata.modelId ? { modelId: metadata.modelId } : {}),
    attempt: metadata.attempt ?? 1,
    transportRetry: metadata.transportRetry ?? false,
    outcome: details.outcome ?? "response",
    totalTokens,
    usageSource,
    inputTokens: inputTokens ?? (providerTotal === undefined && details.inputCharacters !== undefined
      ? estimateCourseGenerationTokens(details.inputCharacters) : undefined),
    outputTokens: outputTokens ?? (providerTotal === undefined && details.outputCharacters !== undefined
      ? estimateCourseGenerationTokens(details.outputCharacters + (details.reasoningCharacters ?? 0)) : undefined),
    cacheReadTokens: tokens(details.cacheReadTokens),
    cacheWriteTokens: tokens(details.cacheWriteTokens),
    reasoningTokens: tokens(details.reasoningTokens) ?? (providerTotal === undefined && details.reasoningCharacters !== undefined
      ? estimateCourseGenerationTokens(details.reasoningCharacters) : undefined),
  };
  let callbackFailure: unknown;
  let callbackFailed = false;
  try {
    // Record a zero-token refusal as a call too, so retry costs remain visible.
    await store?.onCallUsage?.(usage);
  } catch (error) {
    callbackFailure = error;
    callbackFailed = true;
  }
  try {
    if (totalTokens > 0) await store?.onTokenUsage?.(totalTokens, usageSource);
  } catch (error) {
    callbackFailure ??= error;
    callbackFailed = true;
  }
  if (callbackFailed) {
    throw Object.assign(new Error("Could not persist course model usage", { cause: callbackFailure }), {
      code: "COURSE_TOKEN_USAGE_PERSISTENCE_FAILED", isRetryable: false,
    });
  }
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
  options: Pick<CourseGenerationLlmContext, "onTokenUsage" | "onCallUsage"> = {},
): T {
  return context.run({ workload: "course-generation", ...options }, fn);
}

/** Attribute usage to one provider request without replacing the job callbacks. */
export function runWithCourseGenerationLlmCallContext<T>(
  fn: () => T,
  metadata: Partial<CallMetadata>,
): T {
  const store = context.getStore();
  return store ? context.run({ ...store, call: { ...store.call, ...metadata } }, fn) : fn();
}

export function withCourseGenerationLlmSlot<T>(
  fn: () => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return isCourseGenerationLlmContext()
    ? limiter.run(fn, options)
    : fn();
}
