import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';

const mocks = vi.hoisted(() => ({ generateText: vi.fn(), streamText: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  generateText: mocks.generateText,
  streamText: mocks.streamText,
}));
vi.mock('@/lib/llm/classroom-capacity', () => ({
  withClassroomAiCapacity: (fn: () => Promise<unknown>) => fn(),
}));

import { runWithCourseGenerationLlmContext } from '@/lib/course-generation/llm-concurrency';
import { createCourseGenerationAiCall } from '../server/course-generation-ai-call';
import { callLLM, callStreamingLLMText } from './llm';

const model = { provider: 'example.messages', modelId: 'unchanged-model' } as unknown as LanguageModel;

function streamWith(parts: unknown[]) {
  return (async function* () { for (const part of parts) yield part; })();
}

afterEach(() => {
  vi.useRealTimers();
  mocks.generateText.mockReset();
  mocks.streamText.mockReset();
});

describe('course authoring SDK boundary', () => {
  it('disables SDK retries and validation regeneration without changing model or output settings', async () => {
    mocks.generateText.mockResolvedValue({ text: '', usage: { totalTokens: 200 } });
    const onCallUsage = vi.fn();
    const result = await runWithCourseGenerationLlmContext(() => callLLM({
      model, prompt: 'author once', maxRetries: 9, maxOutputTokens: 131_072,
    }, 'first-draft', { retries: 4, validate: () => false }), { onCallUsage });
    expect(result.text).toBe('');
    expect(mocks.generateText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model, maxRetries: 0, maxOutputTokens: 131_072,
    }));
    expect(onCallUsage).toHaveBeenCalledOnce();
  });

  it('records complete provider counts with reasoning and cache remaining subsets', async () => {
    mocks.generateText.mockResolvedValue({ text: 'draft', usage: {
      totalTokens: 1_000, inputTokens: 600, outputTokens: 400,
      inputTokenDetails: { cacheReadTokens: 300, cacheWriteTokens: 50 },
      outputTokenDetails: { reasoningTokens: 200 },
    } });
    const onCallUsage = vi.fn();
    const onTokenUsage = vi.fn();
    await runWithCourseGenerationLlmContext(() => callLLM({ model, prompt: 'source' }, 'blueprint'), {
      onCallUsage, onTokenUsage,
    });
    expect(onCallUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'example.messages', modelId: 'unchanged-model', source: 'blueprint',
      totalTokens: 1_000, inputTokens: 600, outputTokens: 400, cacheReadTokens: 300,
      cacheWriteTokens: 50, reasoningTokens: 200, usageSource: 'provider', outcome: 'response',
    }));
    expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(1_000, 'provider');
  });

  it('counts an interrupted reasoning/text stream and preserves its exact partial draft', async () => {
    mocks.streamText.mockReturnValue({ stream: streamWith([
      { type: 'reasoning-delta', text: 'reasoning' },
      { type: 'text-delta', text: ' partial\n' },
      { type: 'error', error: Object.assign(new Error('overloaded after output'), { statusCode: 503 }) },
    ]) });
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callStreamingLLMText({
      model, prompt: 'source', maxRetries: 10,
    }, 'page'), { onCallUsage })).rejects.toMatchObject({
      rawResponse: ' partial\n', outputStarted: true, isRetryable: false,
    });
    expect(mocks.streamText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxRetries: 0 }));
    expect(onCallUsage).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usageSource: 'estimated' }));
  });

  it('cannot turn usage persistence failure after a completed response into another provider call', async () => {
    mocks.generateText.mockResolvedValue({ text: 'keep this draft', usage: { totalTokens: 200 } });
    const cause = Object.assign(new Error('usage database refused'), { statusCode: 503 });
    const onResponse = vi.fn();
    const call = createCourseGenerationAiCall({
      model, vision: false, source: 'page', maxRetries: 1, onResponse, requireResponsePersistence: true,
    });
    await expect(runWithCourseGenerationLlmContext(() => call('system', 'source'), {
      onCallUsage: () => { throw cause; },
    })).rejects.toMatchObject({
      code: 'COURSE_TOKEN_USAGE_PERSISTENCE_FAILED', isRetryable: false, rawResponse: 'keep this draft',
    });
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'page', system: 'system', prompt: 'source', text: 'keep this draft', complete: false,
    });
  });

  it('records a refused attempt and its one transport retry under separate call IDs', async () => {
    vi.useFakeTimers();
    mocks.generateText.mockRejectedValueOnce(Object.assign(new Error('refused'), { statusCode: 503 }))
      .mockResolvedValueOnce({ text: 'draft', usage: { totalTokens: 400 } });
    const onCallUsage = vi.fn();
    const call = createCourseGenerationAiCall({ model, vision: false, source: 'knowledge', maxRetries: 2 });
    const assertion = expect(runWithCourseGenerationLlmContext(() => call('system', 'source'), {
      onCallUsage,
    })).resolves.toBe('draft');
    await vi.runAllTimersAsync();
    await assertion;
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    const first = onCallUsage.mock.calls[0]![0];
    const second = onCallUsage.mock.calls[1]![0];
    expect(first).toMatchObject({ source: 'knowledge', attempt: 1, transportRetry: false, outcome: 'failed', totalTokens: 0 });
    expect(second).toMatchObject({ source: 'knowledge', attempt: 2, transportRetry: true, outcome: 'response', totalTokens: 400 });
    expect(first.callId).not.toBe(second.callId);
  });

  it('rejects a length-truncated response even when its visible JSON is parseable', async () => {
    mocks.generateText.mockResolvedValue({ text: '{"partial":true}', finishReason: 'length', usage: { totalTokens: 200 } });
    const onCallUsage = vi.fn();
    const onResponse = vi.fn();
    const call = createCourseGenerationAiCall({
      model, vision: false, source: 'truncated', onResponse, requireResponsePersistence: true,
    });
    await expect(runWithCourseGenerationLlmContext(() => call('system', 'source'), {
      onCallUsage,
    })).rejects.toMatchObject({ code: 'LLM_STREAM_INCOMPLETE', isRetryable: false, rawResponse: '{"partial":true}' });
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', totalTokens: 200 }));
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ text: '{"partial":true}', complete: false }));
  });
});
