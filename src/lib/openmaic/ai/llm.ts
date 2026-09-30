import { withClassroomAiCapacity } from "@/lib/llm/classroom-capacity";
/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, JSONValue, LanguageModel, LanguageModelUsage, StreamTextResult } from 'ai';
import { createLogger } from '@openmaic/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import { getModelMetadataKey } from './model-metadata';
import { getCanonicalModelId } from './model-aliases';
import type { ThinkingCapability, ThinkingConfig } from '@openmaic/lib/types/provider';
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@openmaic/lib/ai/thinking-config';
import {
  isAbortError,
  throwIfAborted,
} from '@openmaic/lib/generation/generation-retry';
import {
  isCourseGenerationLlmContext,
  reportCourseGenerationTokenUsage,
  withCourseGenerationLlmSlot,
} from '@/lib/course-generation/llm-concurrency';
import { isFirstPassProviderRejection } from '@/lib/course-generation/first-pass-policy';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@openmaic/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

function usageDetails(
  params: GenerateTextParams | StreamTextParams,
  source: string,
  usage?: Partial<LanguageModelUsage>,
) {
  const model = params.model as unknown as { provider?: string };
  return {
    source,
    modelId: getModelId(params),
    provider: typeof params.model === 'string' ? 'registry' : model?.provider,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
    inputCharacters: JSON.stringify(_extractRequestInfo(params)).length,
  };
}

/** Preserve the draft for diagnostics while preventing a caller from replaying it. */
function retainModelOutput(error: unknown, text: string, reasoningCharacters = 0): Error {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const wrapped = new Error(typeof record?.message === 'string' ? record.message : String(error), { cause: error });
  wrapped.name = typeof record?.name === 'string' ? record.name : 'Error';
  for (const key of ['code', 'status', 'statusCode', 'status_code', 'isRetryable'] as const) {
    if (record?.[key] !== undefined) Object.assign(wrapped, { [key]: record[key] });
  }
  Object.assign(wrapped, {
    textCharacters: text.length,
    reasoningCharacters,
    outputStarted: text.length > 0 || reasoningCharacters > 0,
    ...(text.length > 0 || reasoningCharacters > 0 ? { isRetryable: false } : {}),
  });
  // Avoid dumping a complete textbook/draft into an ordinary error log.
  Object.defineProperty(wrapped, 'rawResponse', { value: text });
  return wrapped;
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Native providers (OpenAI/Anthropic/Google) are mapped to providerOptions.
// OpenAI-compatible providers are injected by the providers.ts fetch wrapper.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  thinking?: ThinkingCapability;
}

/** Provider/model → thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(getModelMetadataKey(provider.id, model.id), {
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Model ID → thinking capability for IDs that are unique across providers. */
const UNIQUE_MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const counts = new Map<string, number>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    }
  }

  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      if (counts.get(model.id) === 1) {
        map.set(model.id, {
          thinking: model.capabilities?.thinking,
        });
      }
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { mode: 'disabled', enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

function getAnthropicEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = pickThinkingEffort(thinking, config);
  if (!effort || effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

function normalizeProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic.messages' && modelId?.startsWith('MiniMax-')) return 'minimax';
  if (provider === 'amazon-bedrock') return 'bedrock';
  if (provider in PROVIDERS) return provider;
  const prefix = provider.split('.')[0];
  return prefix in PROVIDERS ? prefix : undefined;
}

function getModelProviderId(params: GenerateTextParams | StreamTextParams): string | undefined {
  const m = params.model;
  if (!m || typeof m !== 'object' || !('provider' in m)) return undefined;
  const provider = (m as { provider?: string }).provider;
  const modelId = 'modelId' in m ? (m as { modelId?: string }).modelId : undefined;
  return normalizeProviderId(provider, modelId);
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  providerId: string | undefined,
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const lookupModelId = providerId ? getCanonicalModelId(providerId, modelId) : modelId;
  const info = providerId
    ? MODEL_THINKING_MAP.get(getModelMetadataKey(providerId, lookupModelId))
    : UNIQUE_MODEL_THINKING_MAP.get(lookupModelId);
  if (!info?.thinking) return undefined; // model has no thinking capability
  const thinking = info.thinking;
  if (thinking.control === 'none') return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.requestAdapter) {
    case 'openai': {
      const effort = pickThinkingEffort(thinking, config);
      return effort ? { openai: { reasoningEffort: effort } } : undefined;
    }

    case 'anthropic': {
      const buildAnthropicOptions = (
        options: Record<string, JSONValue | undefined>,
      ): ProviderOptions => ({
        anthropic: options,
      });

      if (mode === 'disabled' && thinking.toggleable !== false) {
        return buildAnthropicOptions({ thinking: { type: 'disabled' } });
      }

      if (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') {
        const budget = pickThinkingBudget(thinking, config);
        return budget === undefined
          ? undefined
          : buildAnthropicOptions({ thinking: { type: 'enabled', budgetTokens: budget } });
      }

      const effort = getAnthropicEffort(thinking, config);
      if (!effort) return undefined;

      if (thinking.anthropicThinking?.type === 'adaptive') {
        return buildAnthropicOptions({
          thinking: { type: 'adaptive' },
          effort,
        });
      }

      const manualEffort = effort === 'xhigh' ? 'max' : effort;
      const budget = thinking.anthropicThinking?.budgetByEffort?.[manualEffort];
      if (!budget) return undefined;
      return buildAnthropicOptions({
        thinking: { type: 'enabled', budgetTokens: budget },
        effort: manualEffort,
      });
    }

    case 'google': {
      if (thinking.control === 'level') {
        const level = pickThinkingLevel(thinking, config);
        return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : undefined;
      }

      const budget = pickThinkingBudget(thinking, config);
      if (budget === undefined) return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }

    default:
      // OpenAI-compatible providers are injected in providers.ts fetch wrapper.
      return undefined;
  }
}

/**
 * Resolve providerOptions for direct AI SDK calls that bypass callLLM/streamLLM.
 */
export function resolveThinkingProviderOptions(
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): ProviderOptions | undefined {
  if (!thinkingConfig) return undefined;
  if (typeof model !== 'object' || !('modelId' in model)) return undefined;
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const provider = 'provider' in model ? (model as { provider?: string }).provider : undefined;
  return buildThinkingProviderOptions(
    normalizeProviderId(provider, modelId),
    modelId,
    thinkingConfig,
  );
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);
  const providerId = getModelProviderId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(providerId, modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  return params;
}

/**
 * Options for LLM call retry on validation failure.
 * This is separate from the AI SDK's built-in maxRetries (which handles network/5xx errors).
 */
export interface LLMRetryOptions {
  /** Max retry attempts when validate() fails or the response is empty (default: 0 = no retry) */
  retries?: number;
  /** Custom validation function. Return true to accept the result, false to retry.
   *  Default: checks that response text is non-empty. */
  validate?: (text: string) => boolean;
}

const DEFAULT_VALIDATE = (text: string) => text.trim().length > 0;

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  execution: { bypassCourseGenerationLimit?: boolean } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any, any>> {
  const run = () => callLLMWithoutCourseLimit(params, source, retryOptions, thinking);
  return withClassroomAiCapacity(() => execution.bypassCourseGenerationLimit
    ? run()
    : withCourseGenerationLlmSlot(run, { signal: params.abortSignal }), params.abortSignal);
}

async function callLLMWithoutCourseLimit<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any, any>> {
  const courseGeneration = isCourseGenerationLlmContext();
  const maxAttempts = courseGeneration ? 1 : (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any, any> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let receivedResult: GenerateTextResult<any, any, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    let usageRecorded = false;
    try {
      throwIfAborted(params.abortSignal);
      // Resolve effective thinking config: per-call > global env > undefined
      const effectiveThinking = thinking ?? getGlobalThinkingConfig();
      const injectedParams = injectProviderOptions(courseGeneration ? { ...params, maxRetries: 0 } : params, effectiveThinking);

      // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
      // can read the config and inject vendor-specific body params for
      // OpenAI-compatible providers.
      const result = await thinkingContext.run(effectiveThinking, () =>
        generateText(injectedParams),
      );
      receivedResult = result;
      const usage = result.totalUsage ?? result.usage;
      usageRecorded = true;
      const details = usageDetails(params, source, usage);
      const reasoningCharacters = result.reasoningText?.length ?? 0;
      const incomplete = ['length', 'content-filter', 'error'].includes(result.finishReason);
      await reportCourseGenerationTokenUsage(
        usage?.totalTokens,
        details.inputCharacters + result.text.length + reasoningCharacters,
        { ...details, outputCharacters: result.text.length, reasoningCharacters,
          outcome: params.abortSignal?.aborted ? 'aborted' : incomplete ? 'failed' : 'response' },
      );
      throwIfAborted(params.abortSignal);
      if (courseGeneration && incomplete) {
        throw Object.assign(new Error(`Model response ended before completion (finishReason=${result.finishReason})`), {
          code: 'LLM_STREAM_INCOMPLETE', isRetryable: false,
        });
      }

      // Validate result (only when retries are configured)
      if (validate && !validate(result.text)) {
        log.warn(
          `[${source}] Validation failed (attempt ${attempt}/${maxAttempts}), ${attempt < maxAttempts ? 'retrying...' : 'giving up'}`,
        );
        lastResult = result;
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;
      if (courseGeneration && !usageRecorded) {
        usageRecorded = true;
        const details = usageDetails(params, source);
        const rejected = isFirstPassProviderRejection(error);
        await reportCourseGenerationTokenUsage(rejected ? 0 : undefined,
          rejected ? 0 : details.inputCharacters, {
            ...details, outcome: params.abortSignal?.aborted ? 'aborted' : 'failed',
            ...(rejected ? { inputTokens: 0, outputTokens: 0, usageSource: 'estimated' as const } : {}),
          });
      }

      if (receivedResult) {
        // Storage, validation and cancellation happen after the response; they
        // cannot turn it into an eligible provider refusal.
        lastError = retainModelOutput(error, receivedResult.text);
        if (courseGeneration) throw lastError;
      }

      // A disconnected request must never spend another retry attempt. Some
      // providers wrap AbortError, so check both the error and the signal.
      if (isAbortError(error) || params.abortSignal?.aborted) {
        throw error;
      }

      if (attempt < maxAttempts) {
        log.warn(`[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`, error);
        continue;
      }
    }
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult) return lastResult;
  throw lastError;
}

/**
 * Unified wrapper around `streamText`.
 *
 * Returns the same StreamTextResult.
 *
 * @param params - Same parameters as AI SDK's `streamText`
 * @param source - A short label for log grouping
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export function streamLLM<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StreamTextResult<any, any, any> {
  throwIfAborted(params.abortSignal);
  // Resolve effective thinking config and wrap in thinkingContext
  const effectiveThinking = thinking ?? getGlobalThinkingConfig();
  const injectedParams = injectProviderOptions(isCourseGenerationLlmContext()
    ? { ...params, maxRetries: 0 } : params, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}

/**
 * Consume a streamed model response as plain text while retaining the global
 * course-generation concurrency slot until the response body is complete.
 *
 * Large interactive widgets are emitted as complete HTML/CSS/JS documents.
 * Streaming lets compatible providers return response headers as soon as
 * generation starts instead of waiting for the whole document, avoiding the
 * transport's shorter response-header timeout without changing the model or
 * the generated text contract.
 */
export async function callStreamingLLMText<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  lifecycle: {
    onActivity?: (activity: {
      kind: 'reasoning' | 'text';
      reasoningCharacters: number;
      textCharacters: number;
      firstOutputAt: number;
    }) => void;
    bypassCourseGenerationLimit?: boolean;
  } = {},
): Promise<string> {
  const run = async () => {
    const modelMetadata = typeof params.model === 'string'
      ? { provider: 'registry', modelId: params.model }
      : params.model as unknown as { provider?: string; modelId?: string };
    let text = '';
    let textCharacters = 0;
    let reasoningCharacters = 0;
    let activityEvents = 0;
    let finishReason: string | undefined;
    let reportedUsage: Partial<LanguageModelUsage> | undefined;
    let usageRecorded = false;
    let firstOutputAt: number | undefined;
    const startedAt = Date.now();
    const recordOutput = (kind: 'reasoning' | 'text') => {
      const now = Date.now();
      firstOutputAt ??= now;
      activityEvents += 1;
      lifecycle.onActivity?.({
        kind,
        reasoningCharacters,
        textCharacters,
        firstOutputAt,
      });
    };
    try {
      const result = streamLLM(params, source, thinking);
      // Consume the complete event stream instead of awaiting `result.text` so
      // reasoning deltas count as useful transport activity too. Deep-reasoning
      // models can spend several minutes emitting reasoning before the first
      // visible HTML token; treating that interval as a dead request caused
      // valid interactive pages to be aborted at a fixed wall-clock deadline.
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          text += part.text;
          textCharacters += part.text.length;
          recordOutput('text');
        } else if (part.type === 'reasoning-delta') {
          reasoningCharacters += part.text.length;
          recordOutput('reasoning');
        } else if (part.type === 'error') {
          throw part.error;
        } else if (part.type === 'abort') {
          if (params.abortSignal?.aborted) {
            throw new DOMException(part.reason || 'Model stream aborted', 'AbortError');
          }
          // An upstream abort leaves the request state unknown, even before
          // the first visible token. Replaying it can charge for the work twice.
          throw Object.assign(new Error(part.reason || 'Model stream aborted unexpectedly'), {
            code: 'LLM_STREAM_TRUNCATED',
            isRetryable: false,
          });
        } else if (part.type === 'finish') {
          finishReason = part.finishReason;
          reportedUsage = part.totalUsage;
        }
      }
      const details = usageDetails(params, source, reportedUsage);
      usageRecorded = true;
      await reportCourseGenerationTokenUsage(
        reportedUsage?.totalTokens,
        details.inputCharacters + reasoningCharacters + textCharacters,
        { ...details, outputCharacters: textCharacters, reasoningCharacters,
          outcome: params.abortSignal?.aborted ? 'aborted'
            : !finishReason || ['length', 'content-filter', 'error'].includes(finishReason) ? 'failed' : 'response' },
      );
      throwIfAborted(params.abortSignal);
      if (!finishReason) {
        throw Object.assign(
          new Error('Model stream disconnected before a finish event'),
          { code: 'LLM_STREAM_TRUNCATED', isRetryable: false },
        );
      }
      if (finishReason === 'length' || finishReason === 'content-filter' || finishReason === 'error') {
        throw Object.assign(
          new Error(`Model stream ended before a complete response was available (finishReason=${finishReason})`),
          { code: 'LLM_STREAM_INCOMPLETE', isRetryable: false },
        );
      }
      log.info(
        `[${source}] Stream completed in ${Date.now() - startedAt}ms `
        + `(provider=${modelMetadata.provider ?? 'unknown'}, model=${modelMetadata.modelId ?? 'unknown'}, `
        + `firstOutputMs=${firstOutputAt ? firstOutputAt - startedAt : 'none'}, finishReason=${finishReason}, `
        + `events=${activityEvents}, reasoningChars=${reasoningCharacters}, textChars=${textCharacters})`,
      );
      return text;
    } catch (error) {
      let failure = error;
      if (!usageRecorded) {
        usageRecorded = true;
        const details = usageDetails(params, source, reportedUsage);
        const rejected = isFirstPassProviderRejection(error, firstOutputAt !== undefined);
        try {
        await reportCourseGenerationTokenUsage(
          rejected ? 0 : reportedUsage?.totalTokens,
          rejected ? 0 : details.inputCharacters + reasoningCharacters + textCharacters,
          { ...details, outputCharacters: textCharacters, reasoningCharacters,
            outcome: params.abortSignal?.aborted ? 'aborted' : 'failed',
            ...(rejected ? { inputTokens: 0, outputTokens: 0, usageSource: 'estimated' as const } : {}),
          },
        );
        } catch (usageError) {
          failure = usageError;
        }
      }
      log.warn(
        `[${source}] Stream interrupted after ${Date.now() - startedAt}ms `
        + `(provider=${modelMetadata.provider ?? 'unknown'}, model=${modelMetadata.modelId ?? 'unknown'}, `
        + `firstOutputMs=${firstOutputAt ? firstOutputAt - startedAt : 'none'}, finishReason=${finishReason ?? 'missing'}, `
        + `events=${activityEvents}, reasoningChars=${reasoningCharacters}, textChars=${textCharacters})`,
      );
      throw retainModelOutput(failure, text, reasoningCharacters);
    }
  };
  return lifecycle.bypassCourseGenerationLimit
    ? run()
    : withCourseGenerationLlmSlot(run, { signal: params.abortSignal });
}
