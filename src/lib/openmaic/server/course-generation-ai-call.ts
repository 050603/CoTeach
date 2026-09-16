import type { LanguageModel, UserModelMessage } from 'ai';
import { callLLM, callStreamingLLMText } from '@openmaic/lib/ai/llm';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import { withGenerationRetry } from '@openmaic/lib/generation/generation-retry';

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
  return async (system, prompt, images) => withGenerationRetry(async () => {
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
          abortSignal: signal, maxOutputTokens: options.maxOutputTokens,
        }, options.source, options.thinking, {
          onActivity: streamDeadline?.markActivity,
        });
      }
      const result = await callLLM({
        model: options.model, system, messages: [{ role: 'user', content }],
        abortSignal: signal, maxOutputTokens: options.maxOutputTokens, maxRetries: 0,
      }, options.source, undefined, options.thinking);
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
    }
  }, { label: options.source, maxRetries: options.maxRetries ?? 2, signal: options.signal });
}
