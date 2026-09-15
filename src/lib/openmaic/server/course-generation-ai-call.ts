import type { LanguageModel, UserModelMessage } from 'ai';
import { callLLM, callStreamingLLMText } from '@openmaic/lib/ai/llm';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';
import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import { withGenerationRetry } from '@openmaic/lib/generation/generation-retry';

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
}): AICallFn {
  return async (system, prompt, images) => withGenerationRetry(async () => {
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = timeout && options.signal ? AbortSignal.any([timeout, options.signal]) : timeout ?? options.signal;
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
        }, options.source, options.thinking);
      }
      const result = await callLLM({
        model: options.model, system, messages: [{ role: 'user', content }],
        abortSignal: signal, maxOutputTokens: options.maxOutputTokens, maxRetries: 0,
      }, options.source, undefined, options.thinking);
      return result.text;
    } catch (error) {
      if (!options.signal?.aborted && timeout?.aborted) throw new DOMException('Course model request timed out', 'TimeoutError');
      throw error;
    }
  }, { label: options.source, maxRetries: options.maxRetries ?? 2, signal: options.signal });
}
