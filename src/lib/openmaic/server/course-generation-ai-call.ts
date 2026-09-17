import type { LanguageModel, UserModelMessage } from 'ai';
import { callLLM, callStreamingLLMText } from '@openmaic/lib/ai/llm';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import {
  withGenerationRetry,
  type GenerationRetryEvent,
} from '@openmaic/lib/generation/generation-retry';
import { withCourseGenerationLlmSlot } from '@/lib/course-generation/llm-concurrency';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('CourseGenerationAI');

export type CourseGenerationAiCallContext = {
  attemptsStarted?: number;
  onQueued?: (input: { attempt: number; totalAttempt: number; queuedAt: number }) => Promise<void> | void;
  onAttemptStarting?: (input: {
    attempt: number;
    totalAttempt: number;
    queuedAt: number;
    slotAcquiredAt: number;
    queueMs: number;
  }) => Promise<void> | void;
  onStarted?: (input: { attempt: number; totalAttempt: number; queueMs: number; startedAt: number }) => void;
  onActivity?: (input: {
    attempt: number;
    at: number;
    kind: 'reasoning' | 'text';
    reasoningCharacters: number;
    textCharacters: number;
    firstOutputAt: number;
  }) => void;
  onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
  onSettled?: (input: { attempt: number; totalAttempt: number; durationMs: number }) => void;
};

type ContextualAICallFn = AICallFn & {
  withExecutionContext: (context: CourseGenerationAiCallContext) => AICallFn;
};

export function withCourseGenerationAiCallContext(
  aiCall: AICallFn,
  context: CourseGenerationAiCallContext,
): AICallFn {
  const contextual = aiCall as Partial<ContextualAICallFn>;
  return contextual.withExecutionContext?.(context) ?? aiCall;
}

type StreamDeadline = {
  signal: AbortSignal;
  markActivity: () => void;
  timeoutMessage: () => string | undefined;
  dispose: () => void;
};

function createStreamDeadline(input: {
  idleTimeoutMs: number;
  maxDurationMs: number;
  signal?: AbortSignal;
}): StreamDeadline {
  const controller = new AbortController();
  let timeoutKind: 'idle' | 'maximum-duration' | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const abortFor = (kind: NonNullable<typeof timeoutKind>) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortFor('idle'), input.idleTimeoutMs);
  };
  armIdleTimer();
  const maximumTimer = setTimeout(
    () => abortFor('maximum-duration'),
    Math.max(input.idleTimeoutMs, input.maxDurationMs),
  );
  return {
    signal: input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal,
    markActivity: armIdleTimer,
    timeoutMessage: () => timeoutKind === 'idle'
      ? 'Course model stream timed out after no reasoning or text activity'
      : timeoutKind === 'maximum-duration'
        ? 'Course model stream exceeded its maximum duration'
        : undefined,
    dispose: () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maximumTimer);
    },
  };
}

/** The only retry boundary for course LLM requests; model outputs are never retried. */
export function createCourseGenerationAiCall(options: {
  model: LanguageModel; vision: boolean; source: string; signal?: AbortSignal;
  maxOutputTokens?: number; timeoutMs?: number; thinking?: ThinkingConfig;
  temperature?: number;
  /** Transport retries only. Completed or invalid model output is never
   * regenerated. Large HTML widgets use one longer attempt instead. */
  maxRetries?: number;
  /** Stream large text responses so the provider can send headers before the
   * complete document has been generated. The returned contract stays text. */
  streamResponse?: boolean;
  /** Absolute safety ceiling for an active stream. The ordinary timeout is an
   * inactivity deadline and is refreshed by reasoning and visible text. */
  streamMaxDurationMs?: number;
}): AICallFn {
  const execute = async (
    system: string,
    prompt: string,
    images?: Array<{ id: string; src: string }>,
    context: CourseGenerationAiCallContext = {},
  ) => {
    const configuredMaxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
    const attemptsStarted = Math.max(0, Math.floor(context.attemptsStarted ?? 0));
    const maximumAttempts = configuredMaxRetries + 1;
    if (attemptsStarted >= maximumAttempts) {
      throw Object.assign(
        new Error(`[${options.source}] persisted transport attempt budget is exhausted`),
        { code: 'LLM_RETRY_BUDGET_EXHAUSTED', isRetryable: false },
      );
    }
    return withGenerationRetry(async (attempt) => {
    const totalAttempt = attemptsStarted + attempt;
    const queuedAt = Date.now();
    await context.onQueued?.({ attempt, totalAttempt, queuedAt });
    return withCourseGenerationLlmSlot(async () => {
      const slotAcquiredAt = Date.now();
      const queueMs = slotAcquiredAt - queuedAt;
      // Persist the attempt after the global slot is acquired but before any
      // provider I/O. A process exit while merely queued must not consume the
      // stage's durable three-attempt budget.
      await context.onAttemptStarting?.({
        attempt,
        totalAttempt,
        queuedAt,
        slotAcquiredAt,
        queueMs,
      });
      const startedAt = Date.now();
      context.onStarted?.({ attempt, totalAttempt, queueMs, startedAt });
      log.info(`[${options.source}] model slot acquired (attempt=${totalAttempt}/${maximumAttempts}, queueMs=${queueMs})`);
      // Start transport deadlines after this request owns a provider slot. A
      // saturated course queue must not consume the model's execution budget.
      const streamDeadline = options.streamResponse && options.timeoutMs
        ? createStreamDeadline({
            idleTimeoutMs: options.timeoutMs,
            maxDurationMs: options.streamMaxDurationMs ?? options.timeoutMs,
            signal: options.signal,
          })
        : undefined;
      const timeout = !options.streamResponse && options.timeoutMs
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
      const signal = streamDeadline?.signal
        ?? (timeout && options.signal ? AbortSignal.any([timeout, options.signal]) : timeout ?? options.signal);
      const content: UserModelMessage['content'] = options.vision && images?.length
        ? [{ type: 'text', text: prompt }, ...images.flatMap((image) => [
            { type: 'text' as const, text: `Image reference: ${image.id}` },
            { type: 'image' as const, image: image.src },
          ])]
        : prompt;
      try {
        if (options.streamResponse) {
          return await callStreamingLLMText({
            model: options.model, system, messages: [{ role: 'user', content }],
            abortSignal: signal, maxOutputTokens: options.maxOutputTokens, maxRetries: 0,
            temperature: options.temperature,
          }, options.source, options.thinking, {
            onActivity: (activity) => {
              streamDeadline?.markActivity();
              context.onActivity?.({ attempt, at: Date.now(), ...activity });
            },
            bypassCourseGenerationLimit: true,
          });
        }
        const result = await callLLM({
          model: options.model, system, messages: [{ role: 'user', content }],
          abortSignal: signal, maxOutputTokens: options.maxOutputTokens, maxRetries: 0,
          temperature: options.temperature,
        }, options.source, undefined, options.thinking, { bypassCourseGenerationLimit: true });
        return result.text;
      } catch (error) {
        const streamTimeoutMessage = streamDeadline?.timeoutMessage();
        if (!options.signal?.aborted && streamTimeoutMessage) {
          throw new DOMException(streamTimeoutMessage, 'TimeoutError');
        }
        if (!options.signal?.aborted && timeout?.aborted) throw new DOMException('Course model request timed out', 'TimeoutError');
        throw error;
      } finally {
        streamDeadline?.dispose();
        context.onSettled?.({ attempt, totalAttempt, durationMs: Date.now() - startedAt });
      }
    }, { signal: options.signal });
  }, {
    label: options.source,
    maxRetries: Math.max(0, configuredMaxRetries - attemptsStarted),
    signal: options.signal,
    onRetry: async (event) => {
      const totalFailedAttempts = attemptsStarted + event.attempt;
      log.warn(
        `[${options.source}] transient provider failure; retry ${totalFailedAttempts + 1}/${maximumAttempts} `
        + `in ${event.nextDelayMs}ms (${event.reason})`,
      );
      await context.onRetry?.({
        ...event,
        attempt: totalFailedAttempts,
        maxAttempts: maximumAttempts,
      });
    },
  });
  };
  const aiCall = ((system, prompt, images) => execute(system, prompt, images)) as ContextualAICallFn;
  aiCall.withExecutionContext = (context) => (
    (system, prompt, images) => execute(system, prompt, images, context)
  );
  return aiCall;
}
