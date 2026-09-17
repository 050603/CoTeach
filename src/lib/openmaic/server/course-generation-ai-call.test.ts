import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
const mocks = vi.hoisted(() => ({ call: vi.fn(), stream: vi.fn() }));
vi.mock('@openmaic/lib/ai/llm', () => ({
  callLLM: mocks.call,
  callStreamingLLMText: mocks.stream,
}));
import {
  createCourseGenerationAiCall,
  withCourseGenerationAiCallContext,
} from './course-generation-ai-call';

describe('course generation model input', () => {
  it.each([true, false])('respects the selected model vision capability: %s', async (vision) => {
    mocks.call.mockReset().mockResolvedValue({ text: '{}' });
    const model = {} as LanguageModel;
    const call = createCourseGenerationAiCall({ model, vision, source: 'test' });
    await call('system', 'spatial budget', [{ id: 'spatial-plan', src: 'data:image/png;base64,YQ==' }]);
    expect(mocks.call).toHaveBeenCalledOnce();
    const params = mocks.call.mock.calls[0][0];
    expect(params.model).toBe(model);
    expect(params.maxRetries).toBe(0);
    expect(params.messages[0].content).toEqual(vision ? [
      { type: 'text', text: 'spatial budget' },
      { type: 'text', text: 'Image reference: spatial-plan' },
      { type: 'image', image: 'data:image/png;base64,YQ==' },
    ] : 'spatial budget');
  });
  it('returns a completed empty response without regenerating', async () => {
    mocks.call.mockReset().mockResolvedValue({ text: '' });
    expect(await createCourseGenerationAiCall({ model: {} as LanguageModel, vision: false, source: 'test' })('s', 'p')).toBe('');
    expect(mocks.call).toHaveBeenCalledOnce();
  });

  it('streams one long transport attempt for large interactive HTML', async () => {
    mocks.call.mockReset();
    mocks.stream.mockReset().mockResolvedValue('<html>widget</html>');
    const model = {} as LanguageModel;
    const call = createCourseGenerationAiCall({
      model,
      vision: false,
      source: 'interactive',
      maxRetries: 0,
      streamResponse: true,
      temperature: 0.5,
    });
    await expect(call('system', 'widget')).resolves.toBe('<html>widget</html>');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({
      model,
      maxRetries: 0,
      temperature: 0.5,
      system: 'system',
      messages: [{ role: 'user', content: 'widget' }],
    });
  });

  it('does not replay a failed streamed interactive request', async () => {
    mocks.call.mockReset();
    mocks.stream.mockReset().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const call = createCourseGenerationAiCall({
      model: {} as LanguageModel,
      vision: false,
      source: 'interactive',
      maxRetries: 0,
      streamResponse: true,
    });
    await expect(call('system', 'widget')).rejects.toThrow('timed out');
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('reports bounded transport retries to the page execution context', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset()
        .mockRejectedValueOnce(Object.assign(new Error('Receive batching backend response failed'), {
          code: 'InternalError',
        }))
        .mockResolvedValueOnce('complete page');
      const callbacks = {
        onQueued: vi.fn(),
        onAttemptStarting: vi.fn(),
        onStarted: vi.fn(),
        onActivity: vi.fn(),
        onRetry: vi.fn(),
        onSettled: vi.fn(),
      };
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel,
        vision: false,
        source: 'page-content',
        maxRetries: 2,
        streamResponse: true,
      }), callbacks);
      const pending = call('system', 'page');
      const assertion = expect(pending).resolves.toBe('complete page');
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledTimes(2);
      expect(callbacks.onQueued).toHaveBeenCalledTimes(2);
      expect(callbacks.onAttemptStarting).toHaveBeenCalledTimes(2);
      expect(callbacks.onStarted).toHaveBeenCalledTimes(2);
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
      expect(callbacks.onRetry).toHaveBeenCalledWith(expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
      }));
      expect(callbacks.onSettled).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['provider InternalError', Object.assign(new Error('Receive batching backend response failed'), { code: 'InternalError' })],
    ['HTTP 429', Object.assign(new Error('rate limit'), { statusCode: 429, responseHeaders: { 'retry-after': '2' } })],
    ['HTTP 503', Object.assign(new Error('service unavailable'), { statusCode: 503 })],
    ['response header timeout', new DOMException('Headers Timeout Error', 'TimeoutError')],
    ['reasoning stream disconnect', Object.assign(new Error('Model stream disconnected before a finish event'), {
      code: 'LLM_STREAM_TRUNCATED',
      isRetryable: true,
    })],
  ])('retries %s once inside the single transport boundary', async (_label, failure) => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockRejectedValueOnce(failure).mockResolvedValueOnce('complete graph');
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel,
        vision: false,
        source: 'knowledge-structure',
        maxRetries: 1,
        streamResponse: true,
      });
      const pending = call('system', 'graph');
      const assertion = expect(pending).resolves.toBe('complete graph');
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['cancelled request', new DOMException('cancelled', 'AbortError')],
    ['output truncation', Object.assign(new Error('finishReason=length'), {
      code: 'LLM_STREAM_INCOMPLETE',
      isRetryable: false,
    })],
  ])('does not retry %s', async (_label, failure) => {
    mocks.stream.mockReset().mockRejectedValue(failure);
    const call = createCourseGenerationAiCall({
      model: {} as LanguageModel,
      vision: false,
      source: 'knowledge-structure',
      maxRetries: 2,
      streamResponse: true,
    });
    await expect(call('system', 'graph')).rejects.toBe(failure);
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('does not reset a persisted stage attempt budget after restart', async () => {
    mocks.stream.mockReset().mockRejectedValue(Object.assign(new Error('service unavailable'), {
      statusCode: 503,
    }));
    const base = createCourseGenerationAiCall({
      model: {} as LanguageModel,
      vision: false,
      source: 'resumed-page-content',
      maxRetries: 2,
      streamResponse: true,
    });
    const lastAttempt = withCourseGenerationAiCallContext(base, {
      attemptsStarted: 2,
    });
    await expect(lastAttempt('system', 'page')).rejects.toThrow('service unavailable');
    expect(mocks.stream).toHaveBeenCalledOnce();

    mocks.stream.mockClear();
    const exhausted = withCourseGenerationAiCallContext(base, {
      attemptsStarted: 3,
    });
    await expect(exhausted('system', 'page')).rejects.toMatchObject({
      code: 'LLM_RETRY_BUDGET_EXHAUSTED',
      isRetryable: false,
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('refreshes the stream inactivity deadline when reasoning or text arrives', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementation(async (...args: unknown[]) => {
        const lifecycle = args[3] as { onActivity?: (activity: {
          kind: 'reasoning' | 'text'; reasoningCharacters: number; textCharacters: number; firstOutputAt: number;
        }) => void } | undefined;
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        lifecycle?.onActivity?.({ kind: 'reasoning', reasoningCharacters: 8, textCharacters: 0, firstOutputAt: Date.now() });
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        lifecycle?.onActivity?.({ kind: 'text', reasoningCharacters: 8, textCharacters: 4, firstOutputAt: Date.now() - 750 });
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        return '<html>complete widget</html>';
      });
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel,
        vision: false,
        source: 'interactive',
        timeoutMs: 1_000,
        streamMaxDurationMs: 3_000,
        maxRetries: 0,
        streamResponse: true,
      });
      const result = call('system', 'widget');
      await vi.advanceTimersByTimeAsync(2_250);
      await expect(result).resolves.toBe('<html>complete widget</html>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a streamed request only after genuine inactivity', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementation(async (...args: unknown[]) => {
        const params = args[0] as { abortSignal?: AbortSignal };
        return new Promise<string>((_resolve, reject) => {
          params.abortSignal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      });
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel,
        vision: false,
        source: 'interactive',
        timeoutMs: 1_000,
        streamMaxDurationMs: 3_000,
        maxRetries: 0,
        streamResponse: true,
      });
      const result = call('system', 'widget');
      const rejection = expect(result).rejects.toThrow(
        'Course model stream timed out after no reasoning or text activity',
      );
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(mocks.stream).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
