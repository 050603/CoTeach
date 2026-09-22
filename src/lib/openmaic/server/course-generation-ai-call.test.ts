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
  it('shares one durable request budget across technical corrections in a stage', async () => {
    mocks.call.mockReset().mockResolvedValue({ text: '{}' });
    const onAttemptStarting = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'stage', maxRetries: 1,
    }), { onAttemptStarting });
    await call('system', 'first draft');
    await call('system', 'correct invalid structure');
    await expect(call('system', 'another correction')).rejects.toMatchObject({
      code: 'LLM_RETRY_BUDGET_EXHAUSTED', isRetryable: false,
    });
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(onAttemptStarting.mock.calls.map(([event]) => event.totalAttempt)).toEqual([1, 2]);
  });

  it.each([true, false])('uses the artifact output budget for streaming=%s', async (streamResponse) => {
    mocks.call.mockReset().mockResolvedValue({ text: 'complete' });
    mocks.stream.mockReset().mockResolvedValue('complete');
    const outputBudget = vi.fn().mockReturnValue(4096);
    const onStarted = vi.fn();
    const thinking = { mode: 'disabled', effort: 'none' } as const;
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'test',
      maxOutputTokens: 393216, outputBudget, streamResponse, thinking,
    }), { onStarted });
    await expect(call('system', 'page')).resolves.toBe('complete');
    expect(outputBudget).toHaveBeenCalledExactlyOnceWith('system', 'page');
    expect((streamResponse ? mocks.stream : mocks.call).mock.calls[0][0].maxOutputTokens).toBe(4096);
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({
      requestPolicy: { maxOutputTokens: 4096, thinking },
    }));
  });

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
    ['SDK wrapped proxy socket close', Object.assign(new Error('Cannot connect to API: other side closed'), {
      name: 'AI_APICallError', isRetryable: true,
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })],
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

  it('allows active high-thinking work past the old fixed deadline without changing teacher settings', async () => {
    vi.useFakeTimers();
    try {
      const thinking = { mode: 'enabled', effort: 'high' } as const;
      mocks.stream.mockReset().mockImplementation((params, _source, selectedThinking, lifecycle) => {
        expect(selectedThinking).toBe(thinking);
        return new Promise<string>((resolve, reject) => {
          const activity = setInterval(() => lifecycle.onActivity({
            kind: 'reasoning', reasoningCharacters: 100, textCharacters: 0, firstOutputAt: Date.now(),
          }), 60_000);
          const completion = setTimeout(() => { clearInterval(activity); resolve('complete page'); }, 2_000_000);
          params.abortSignal.addEventListener('abort', () => {
            clearInterval(activity);
            clearTimeout(completion);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      });
      const onStarted = vi.fn();
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'high-thinking', thinking,
        outputBudget: () => 100_000, timeoutMs: 180_000, maxRetries: 0, streamResponse: true,
        executionBudget: { minTokensPerSecond: 20, startupAllowanceMs: 120_000, maxDurationMs: 7_200_000 },
      }), { onStarted });
      const assertion = expect(call('system', 'page')).resolves.toBe('complete page');
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({
        requestPolicy: expect.objectContaining({ maxOutputTokens: 100_000, thinking, maxDurationMs: 5_120_000, idleTimeoutMs: 180_000 }),
      }));
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('honors an explicit safety ceiling shorter than the idle allowance', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementation((params) => new Promise<string>((_resolve, reject) => {
        params.abortSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'bounded-high-thinking',
        timeoutMs: 3000, streamMaxDurationMs: 1000, maxRetries: 2, streamResponse: true,
        executionBudget: { minTokensPerSecond: 20, startupAllowanceMs: 120_000, maxDurationMs: 7_200_000 },
      });
      const assertion = expect(call('system', 'page')).rejects.toMatchObject({
        code: 'LLM_EXECUTION_BUDGET_EXCEEDED', isRetryable: false,
      });
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
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

  it('does not replay a continuously active stream that exhausts its execution budget', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementation((params, _source, _thinking, lifecycle) => (
        new Promise<string>((_resolve, reject) => {
          const activity = setInterval(() => lifecycle.onActivity({
            kind: 'reasoning', reasoningCharacters: 10, textCharacters: 0, firstOutputAt: Date.now(),
          }), 500);
          params.abortSignal.addEventListener('abort', () => {
            clearInterval(activity);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        })
      ));
      const onRetry = vi.fn();
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'page-content',
        timeoutMs: 1000, streamMaxDurationMs: 3000, maxRetries: 2, streamResponse: true,
      }), { onRetry });
      const rejection = expect(call('system', 'page')).rejects.toMatchObject({
        code: 'LLM_EXECUTION_BUDGET_EXCEEDED', isRetryable: false,
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an idle stream within the transport budget', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementationOnce((params) => (
        new Promise<string>((_resolve, reject) => {
          params.abortSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        })
      )).mockResolvedValueOnce('complete page');
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'page-content',
        timeoutMs: 1000, streamMaxDurationMs: 3000, maxRetries: 1, streamResponse: true,
      });
      const assertion = expect(call('system', 'page')).resolves.toBe('complete page');
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves external cancellation when it races the execution deadline', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const cancelled = new DOMException('teacher cancelled', 'AbortError');
      mocks.stream.mockReset().mockImplementation((params, _source, _thinking, lifecycle) => (
        new Promise<string>((_resolve, reject) => {
          const activity = setInterval(() => lifecycle.onActivity({
            kind: 'reasoning', reasoningCharacters: 10, textCharacters: 0, firstOutputAt: Date.now(),
          }), 500);
          params.abortSignal.addEventListener('abort', () => {
            clearInterval(activity);
            controller.abort(cancelled);
            reject(new Error('provider wrapped cancellation'));
          }, { once: true });
        })
      ));
      const call = createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'page-content', signal: controller.signal,
        timeoutMs: 1000, streamMaxDurationMs: 3000, maxRetries: 2, streamResponse: true,
      });
      const assertion = expect(call('system', 'page')).rejects.toBe(cancelled);
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
