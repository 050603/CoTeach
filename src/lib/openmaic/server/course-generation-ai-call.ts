import type { LanguageModel, UserModelMessage } from 'ai';
import { Output } from 'ai';
import { randomUUID } from 'node:crypto';
import { callLLM, callStreamingLLMText } from '@openmaic/lib/ai/llm';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import {
  withGenerationRetry,
  type GenerationRetryEvent,
} from '@openmaic/lib/generation/generation-retry';
import {
  runWithCourseGenerationLlmCallContext,
  withCourseGenerationLlmSlot,
} from '@/lib/course-generation/llm-concurrency';
import {
  isFirstPassProviderRejection,
  MAX_FIRST_PASS_TRANSPORT_RETRIES,
} from '@/lib/course-generation/first-pass-policy';
import { createLogger } from '@openmaic/lib/logger';

import {
  calculateCourseExecutionDurationMs,
  COURSE_EXECUTION_BUDGET_VERSION,
  type CourseExecutionBudgetOptions,
} from '@openmaic/lib/generation/course-output-budget';

const log = createLogger('CourseGenerationAI');
// Ask the provider for JSON while keeping each raw text delta available to
// activity tracking and draft storage. Output.json() buffers partial JSON;
// the existing course parsers validate the complete authored text instead.
const jsonTextOutput = { ...Output.text(), responseFormat: Output.json().responseFormat };

export type CourseGenerationAuthoringResponse = {
  source: string; system: string; prompt: string; text: string;
  /** An interrupted/truncated response is never eligible for saved-draft acceptance. */
  complete?: boolean;
};

export type CourseGenerationAiCallContext = {
  attemptsStarted?: number;
  /** Request identity owns complete and partial raw drafts before parsing. */
  onResponse?: (input: CourseGenerationAuthoringResponse) => Promise<void> | void;
  onQueued?: (input: { attempt: number; totalAttempt: number; queuedAt: number }) => Promise<void> | void;
  onAttemptStarting?: (input: {
    attempt: number;
    totalAttempt: number;
    queuedAt: number;
    slotAcquiredAt: number;
    queueMs: number;
  }) => Promise<void> | void;
  onStarted?: (input: {
    attempt: number;
    totalAttempt: number;
    queueMs: number;
    startedAt: number;
    requestPolicy?: {
      maxOutputTokens?: number; thinking?: ThinkingConfig;
      executionBudgetVersion?: string; idleTimeoutMs?: number; maxDurationMs?: number;
      responseFormat?: 'json';
    };
  }) => void;
  onActivity?: (input: {
    attempt: number;
    at: number;
    kind: 'reasoning' | 'text';
    reasoningCharacters: number;
    textCharacters: number;
    firstOutputAt: number;
  }) => void;
  onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
  onSettled?: (input: {
    attempt: number; totalAttempt: number; durationMs: number;
    outcome: 'response' | 'failed' | 'aborted';
  }) => Promise<void> | void;
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
  timeoutError: () => Error | undefined;
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
    input.maxDurationMs,
  );
  return {
    signal: input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal,
    markActivity: armIdleTimer,
    timeoutError: () => timeoutKind === 'idle'
      ? Object.assign(new Error('Course model stream timed out after no reasoning or text activity'), {
          name: 'TimeoutError', code: 'LLM_STREAM_IDLE_TIMEOUT', isRetryable: false,
        })
      : timeoutKind === 'maximum-duration'
        ? Object.assign(new Error('Course model stream exceeded its maximum duration'), {
            code: 'LLM_EXECUTION_BUDGET_EXCEEDED',
            isRetryable: false,
          })
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
  /** Per-artifact budget, resolved once before transport retries. */
  outputBudget?: (system: string, prompt: string) => number;
  temperature?: number;
  /** Transport retries only. Completed or invalid model output is never
   * regenerated. Large HTML widgets use one longer attempt instead. */
  maxRetries?: number;
  /** Stream large text responses so the provider can send headers before the
   * complete document has been generated. The returned contract stays text. */
  streamResponse?: boolean;
  /** Request native JSON output for object contracts before authoring starts.
   * HTML and other free text callers leave this unset. No output correction or
   * second request is commissioned when a provider rejects this format. */
  responseFormat?: 'json';
  /** Absolute safety ceiling for an active stream. The ordinary timeout is an
   * inactivity deadline and is refreshed by reasoning and visible text. */
  streamMaxDurationMs?: number;
  /** Opt in to a work-based deadline. An explicit streamMaxDurationMs still wins. */
  executionBudget?: CourseExecutionBudgetOptions;
  /** Observe completed text before parsing; diagnostic failures never replay a request. */
  onResponse?: (input: CourseGenerationAuthoringResponse) => Promise<void> | void;
  /** Production checkpoints must save the raw draft before any parsing/acceptance. */
  requireResponsePersistence?: boolean;
}): AICallFn {
  const execute = async (
    system: string,
    prompt: string,
    images?: Array<{ id: string; src: string }>,
    context: CourseGenerationAiCallContext = {},
  ) => {
    const maxOutputTokens = options.outputBudget?.(system, prompt) ?? options.maxOutputTokens;
    const maxDurationMs = options.streamMaxDurationMs ?? (options.executionBudget
      ? calculateCourseExecutionDurationMs(maxOutputTokens, options.timeoutMs ?? 0, options.executionBudget)
      : options.timeoutMs);
    const configuredMaxRetries = Math.max(0, Math.min(MAX_FIRST_PASS_TRANSPORT_RETRIES,
      Math.floor(options.maxRetries ?? MAX_FIRST_PASS_TRANSPORT_RETRIES)));
    const attemptsStarted = Math.max(0, Math.floor(context.attemptsStarted ?? 0));
    const maximumAttempts = configuredMaxRetries + 1;
    // Another invocation is another authoring, even if a transport allowance
    // remains. Only the retry loop of this original request can use that slot.
    if (attemptsStarted > 0) {
      throw Object.assign(
        new Error(`[${options.source}] this authoring request has already started; reuse its saved draft`),
        { code: 'LLM_RETRY_BUDGET_EXHAUSTED', isRetryable: false },
      );
    }
    let providerCallStarted = false;
    let outputStarted = false;
    let cancelledRawResponse: string | undefined;
    const persistResponse = async (text: string, complete: boolean) => {
      try {
        const response = { source: options.source, system, prompt, text, complete };
        await context.onResponse?.(response);
        await options.onResponse?.(response);
      } catch (error) {
        if (options.requireResponsePersistence) {
          const failure = Object.assign(new Error(`[${options.source}] could not persist the model draft`, { cause: error }), {
            code: 'LLM_RESPONSE_PERSISTENCE_FAILED', isRetryable: false,
          });
          Object.defineProperty(failure, 'rawResponse', { value: text });
          throw failure;
        }
        log.warn('Could not record course model response');
      }
    };
    let response: string;
    try {
    response = await withGenerationRetry(async (attempt) => {
    providerCallStarted = false;
    outputStarted = false;
    const totalAttempt = attemptsStarted + attempt;
    const queuedAt = Date.now();
    await context.onQueued?.({ attempt, totalAttempt, queuedAt });
    return withCourseGenerationLlmSlot(() => runWithCourseGenerationLlmCallContext(async () => {
      const slotAcquiredAt = Date.now();
      const queueMs = slotAcquiredAt - queuedAt;
      // Persist the attempt after the global slot is acquired but before any
      // provider I/O. A process exit while merely queued must not consume the
      // stage's durable request budget.
      await context.onAttemptStarting?.({
        attempt,
        totalAttempt,
        queuedAt,
        slotAcquiredAt,
        queueMs,
      });
      // Keep the marker after completion and on every failure. It prevents
      // parser/storage failures or task recovery from starting another draft.
      context.attemptsStarted = totalAttempt;
      const startedAt = Date.now();
      const requestPolicy = {
        maxOutputTokens, thinking: options.thinking,
        ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
        ...(options.executionBudget ? {
          executionBudgetVersion: COURSE_EXECUTION_BUDGET_VERSION,
          idleTimeoutMs: options.timeoutMs, maxDurationMs,
        } : {}),
      };
      context.onStarted?.({ attempt, totalAttempt, queueMs, startedAt, requestPolicy });
      log.info(`[${options.source}] model slot acquired (attempt=${totalAttempt}/${maximumAttempts}, queueMs=${queueMs}, requestPolicy=${JSON.stringify(requestPolicy)})`);
      // Start transport deadlines after this request owns a provider slot. A
      // saturated course queue must not consume the model's execution budget.
      const streamDeadline = options.streamResponse && options.timeoutMs
        ? createStreamDeadline({
            idleTimeoutMs: options.timeoutMs,
            maxDurationMs: maxDurationMs ?? options.timeoutMs,
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
            { type: 'file' as const, data: image.src,
              mediaType: /^data:(image\/[^;,]+)/i.exec(image.src)?.[1] ?? 'image/*' },
          ])]
        : prompt;
      let outcome: 'response' | 'failed' | 'aborted' = 'failed';
      try {
        providerCallStarted = true;
        if (options.streamResponse) {
          const response = await callStreamingLLMText({
            model: options.model, system, messages: [{ role: 'user', content }],
            abortSignal: signal, maxOutputTokens, maxRetries: 0,
            temperature: options.temperature,
            ...(options.responseFormat === 'json' ? { output: jsonTextOutput } : {}),
          }, options.source, options.thinking, {
            onActivity: (activity) => {
              outputStarted ||= activity.reasoningCharacters > 0 || activity.textCharacters > 0;
              streamDeadline?.markActivity();
              context.onActivity?.({ attempt, at: Date.now(), ...activity });
            },
            bypassCourseGenerationLimit: true,
          });
          outcome = 'response';
          return response;
        }
        const result = await callLLM({
          model: options.model, system, messages: [{ role: 'user', content }],
          abortSignal: signal, maxOutputTokens, maxRetries: 0,
          temperature: options.temperature,
          ...(options.responseFormat === 'json' ? { output: jsonTextOutput } : {}),
        }, options.source, undefined, options.thinking, { bypassCourseGenerationLimit: true });
        outcome = 'response';
        return result.text;
      } catch (error) {
        // User cancellation wins even when it races a local deadline or the
        // provider wraps the abort in a transport error.
        if (options.signal?.aborted) {
          outcome = 'aborted';
          if (error && typeof error === 'object' && 'rawResponse' in error
            && typeof error.rawResponse === 'string') cancelledRawResponse = error.rawResponse;
          throw options.signal.reason;
        }
        const streamTimeoutError = streamDeadline?.timeoutError();
        // An active request exhausting our execution budget is not a broken
        // connection. Replaying it would consume the same budget again.
        const timeoutError = streamTimeoutError ?? (timeout?.aborted
          ? Object.assign(new Error('Course model request timed out'), {
              name: 'TimeoutError', code: 'LLM_REQUEST_TIMEOUT', isRetryable: false,
            }) : undefined);
        if (timeoutError) {
          if (error && typeof error === 'object' && 'rawResponse' in error) {
            Object.defineProperty(timeoutError, 'rawResponse', { value: error.rawResponse });
          }
          throw timeoutError;
        }
        throw error;
      } finally {
        streamDeadline?.dispose();
        try {
          await context.onSettled?.({ attempt, totalAttempt, durationMs: Date.now() - startedAt, outcome });
        } catch (error) {
          // A lost job lease or database write must not turn a usable model
          // response into a transport failure. The started marker remains
          // recoverable if the stage result was not committed.
          log.warn(`[${options.source}] could not persist model-attempt settlement`, error);
        }
      }
    }, { source: options.source, callId: randomUUID(), attempt: totalAttempt,
      transportRetry: attempt > 1 }), { signal: options.signal });
  }, {
    label: options.source,
    maxRetries: Math.max(0, configuredMaxRetries - attemptsStarted),
    signal: options.signal,
    shouldRetryError: (error) => providerCallStarted && isFirstPassProviderRejection(error, outputStarted),
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
    } catch (error) {
      const retainedResponse = error && typeof error === 'object' && 'rawResponse' in error
        ? (error as { rawResponse?: unknown }).rawResponse : undefined;
      const rawResponse = typeof retainedResponse === 'string' ? retainedResponse : cancelledRawResponse;
      // Stream interruption and usage persistence failures retain the partial
      // response. Save it without reclassifying it as an accepted stage result.
      if (typeof rawResponse === 'string') await persistResponse(rawResponse, false);
      throw error;
    }
    // Raw-response storage is outside the retry/deadline/slot boundary.
    await persistResponse(response, true);
    return response;
  };
  const aiCall = ((system, prompt, images) => execute(system, prompt, images)) as ContextualAICallFn;
  aiCall.withExecutionContext = (context) => (
    (system, prompt, images) => execute(system, prompt, images, context)
  );
  return aiCall;
}
