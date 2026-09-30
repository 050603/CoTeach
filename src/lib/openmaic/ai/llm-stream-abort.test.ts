import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';

const mocks = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  streamText: mocks.streamText,
}));

import { callStreamingLLMText } from './llm';
import {
  createCourseGenerationAiCall,
  withCourseGenerationAiCallContext,
} from '../server/course-generation-ai-call';

function streamWith(parts: unknown[]) {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

afterEach(() => {
  vi.useRealTimers();
  mocks.streamText.mockReset();
});

describe('streamed model abort classification', () => {
  it('stops an unexpected upstream abort without replaying an unknown request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.streamText
      .mockReturnValueOnce({ stream: streamWith([{ type: 'abort', reason: 'terminated' }]) })
      .mockReturnValueOnce({ stream: streamWith([
        { type: 'text-delta', text: 'complete page' },
        { type: 'finish', finishReason: 'stop', totalUsage: { totalTokens: 3 } },
      ]) });
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel,
      vision: false,
      source: 'scene-content',
      signal: controller.signal,
      streamResponse: true,
      maxRetries: 1,
    }), { onRetry });

    const result = expect(call('system', 'page')).rejects.toMatchObject({
      code: 'LLM_STREAM_TRUNCATED', isRetryable: false,
    });
    await vi.runAllTimersAsync();
    await result;

    expect(mocks.streamText).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('marks an unexpected upstream abort as a terminal truncated stream', async () => {
    mocks.streamText.mockReturnValue({ stream: streamWith([{ type: 'abort', reason: 'terminated' }]) });

    await expect(callStreamingLLMText({
      model: {} as LanguageModel,
      prompt: 'page',
    }, 'scene-content')).rejects.toMatchObject({
      name: 'Error',
      message: 'terminated',
      code: 'LLM_STREAM_TRUNCATED',
      isRetryable: false,
    });
  });

  it('keeps a caller-aborted stream as AbortError', async () => {
    const controller = new AbortController();
    mocks.streamText.mockReturnValue({
      stream: (async function* () {
        controller.abort();
        yield { type: 'abort', reason: 'cancelled' };
      })(),
    });

    await expect(callStreamingLLMText({
      model: {} as LanguageModel,
      prompt: 'page',
      abortSignal: controller.signal,
    }, 'scene-content')).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.streamText).toHaveBeenCalledOnce();
  });
});
