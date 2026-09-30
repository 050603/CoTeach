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
  it.each([true, false])('records exact completed text before the caller can parse it for streaming=%s', async (streamResponse) => {
    const text = '  {"invalid-first-draft": unclosed}\n';
    mocks.call.mockReset().mockResolvedValue({ text });
    mocks.stream.mockReset().mockResolvedValue(text);
    const model = { apiKey: 'private-model-key', baseURL: 'private-endpoint', config: { private: true } } as unknown as LanguageModel;
    let releaseObserver!: () => void;
    let markObserved!: () => void;
    const held = new Promise<void>((resolve) => { releaseObserver = resolve; });
    const observed = new Promise<void>((resolve) => { markObserved = resolve; });
    let recordingComplete = false;
    let returned = false;
    const onResponse = vi.fn(async () => {
      markObserved();
      await held;
      recordingComplete = true;
    });
    const call = createCourseGenerationAiCall({
      model, vision: true, source: 'first-authoring', streamResponse, onResponse,
    });
    const result = call('system contract', 'page authoring', [{ id: 'source-image', src: 'private-image-data' }])
      .then((response) => { returned = true; return response; });
    await observed;

    expect(returned).toBe(false);
    expect(recordingComplete).toBe(false);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'first-authoring', system: 'system contract', prompt: 'page authoring', text, complete: true,
    });
    releaseObserver();
    expect(await result).toBe(text);
    expect(recordingComplete).toBe(true);
    expect(() => JSON.parse(text)).toThrow();
    expect((streamResponse ? mocks.stream : mocks.call)).toHaveBeenCalledOnce();
  });

  it.each([
    [true, 'sync'], [true, 'async'], [false, 'sync'], [false, 'async'],
  ] as const)('preserves a usable response when its observer fails for streaming=%s, failure=%s', async (streamResponse, failureKind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.call.mockReset().mockResolvedValue({ text: 'complete response' });
      mocks.stream.mockReset().mockResolvedValue('complete response');
      // A failure that normally qualifies for transport retry must still be
      // confined to optional diagnostics, without leaking its error details.
      const observerFailure = Object.assign(new Error('private observer details'), { statusCode: 503 });
      const onResponse = vi.fn(() => {
        if (failureKind === 'sync') throw observerFailure;
        return Promise.reject(observerFailure);
      });
      const context = { onRetry: vi.fn(), onAttemptStarting: vi.fn(), onSettled: vi.fn() };
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'recorded-page', streamResponse,
        maxRetries: 2, maxOutputTokens: 131072, onResponse,
      }), context);

      await expect(call('system', 'prompt')).resolves.toBe('complete response');
      expect((streamResponse ? mocks.stream : mocks.call)).toHaveBeenCalledOnce();
      expect((streamResponse ? mocks.stream : mocks.call).mock.calls[0][0].maxOutputTokens).toBe(131072);
      expect(onResponse).toHaveBeenCalledOnce();
      expect(context.onRetry).not.toHaveBeenCalled();
      expect(context.onAttemptStarting).toHaveBeenCalledOnce();
      expect(context.onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'response', totalAttempt: 1 }));
      expect(warn).toHaveBeenCalledExactlyOnceWith('[CourseGenerationAI]', 'Could not record course model response');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not use the transport allowance for a second authoring after any completed draft', async () => {
    mocks.call.mockReset().mockResolvedValue({ text: '{}' });
    const onAttemptStarting = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'stage', maxRetries: 1,
    }), { onAttemptStarting });
    await call('system', 'first draft');
    await expect(call('system', 'correct invalid structure')).rejects.toMatchObject({
      code: 'LLM_RETRY_BUDGET_EXHAUSTED', isRetryable: false,
    });
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(onAttemptStarting.mock.calls.map(([event]) => event.totalAttempt)).toEqual([1]);
  });

  it('stops acceptance when required raw-response storage fails and retains the exact draft', async () => {
    mocks.call.mockReset().mockResolvedValue({ text: '  first draft\n' });
    const cause = Object.assign(new Error('database temporarily unavailable'), { statusCode: 503 });
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'durable-authoring', maxRetries: 2,
      onResponse: () => { throw cause; }, requireResponsePersistence: true,
    }), { onRetry });
    await expect(call('system', 'prompt')).rejects.toMatchObject({
      code: 'LLM_RESPONSE_PERSISTENCE_FAILED', isRetryable: false, rawResponse: '  first draft\n', cause,
    });
    await expect(call('system', 'prompt')).rejects.toMatchObject({ code: 'LLM_RETRY_BUDGET_EXHAUSTED' });
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
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
    const onResponse = vi.fn();
    expect(await createCourseGenerationAiCall({ model: {} as LanguageModel, vision: false, source: 'test', onResponse })('s', 'p')).toBe('');
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({ source: 'test', system: 's', prompt: 'p', text: '', complete: true });
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
    const onResponse = vi.fn();
    const call = createCourseGenerationAiCall({
      model: {} as LanguageModel,
      vision: false,
      source: 'interactive',
      maxRetries: 0,
      streamResponse: true,
      onResponse,
    });
    await expect(call('system', 'widget')).rejects.toThrow('timed out');
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('reports bounded transport retries to the page execution context', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset()
        .mockRejectedValueOnce(Object.assign(new Error('Receive batching backend response failed'), {
          statusCode: 503,
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
      const onResponse = vi.fn();
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel,
        vision: false,
        source: 'page-content',
        maxRetries: 2,
        streamResponse: true,
        onResponse,
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
        maxAttempts: 2,
      }));
      expect(callbacks.onSettled).toHaveBeenCalledTimes(2);
      expect(callbacks.onSettled.mock.calls.map(([event]) => event.outcome)).toEqual(['failed', 'response']);
      expect(onResponse).toHaveBeenCalledExactlyOnceWith({
        source: 'page-content', system: 'system', prompt: 'page', text: 'complete page', complete: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['HTTP 429', Object.assign(new Error('rate limit'), { statusCode: 429, responseHeaders: { 'retry-after': '2' } })],
    ['HTTP 503', Object.assign(new Error('service unavailable'), { statusCode: 503 })],
    ['SDK wrapped HTTP 503', new Error('SDK wrapper', {
      cause: Object.assign(new Error('service unavailable'), { statusCode: 503 }),
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
    ['provider InternalError', Object.assign(new Error('Receive batching backend response failed'), { code: 'InternalError' })],
    ['SDK wrapped proxy socket close', Object.assign(new Error('Cannot connect to API: other side closed'), {
      name: 'AI_APICallError', isRetryable: true,
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })],
    ['response header timeout', new DOMException('Headers Timeout Error', 'TimeoutError')],
    ['reasoning stream disconnect', Object.assign(new Error('Model stream disconnected before a finish event'), {
      code: 'LLM_STREAM_TRUNCATED', isRetryable: true,
    })],
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

  it.each(['reasoning', 'text'] as const)('does not replay HTTP refusal metadata after %s output', async (kind) => {
    const failure = Object.assign(new Error('provider failed after output'), { statusCode: 503 });
    mocks.stream.mockReset().mockImplementation(async (_params, _source, _thinking, lifecycle) => {
      lifecycle.onActivity({
        kind, firstOutputAt: Date.now(), reasoningCharacters: kind === 'reasoning' ? 1 : 0,
        textCharacters: kind === 'text' ? 1 : 0,
      });
      throw failure;
    });
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'first-draft', maxRetries: 2, streamResponse: true,
    }), { onRetry });
    await expect(call('system', 'page')).rejects.toBe(failure);
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('never treats a checkpoint write failure before provider I/O as a provider refusal', async () => {
    const failure = Object.assign(new Error('database refused checkpoint'), { statusCode: 503 });
    mocks.call.mockReset();
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'checkpointed', maxRetries: 2,
    }), { onAttemptStarting: () => { throw failure; }, onRetry });
    await expect(call('system', 'page')).rejects.toBe(failure);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retains an interrupted draft before propagating its failure', async () => {
    const failure = Object.assign(new Error('stream incomplete'), {
      code: 'LLM_STREAM_TRUNCATED', isRetryable: false, rawResponse: 'partial draft',
    });
    mocks.stream.mockReset().mockRejectedValue(failure);
    const onResponse = vi.fn();
    const call = createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'partial', streamResponse: true,
      onResponse, requireResponsePersistence: true,
    });
    await expect(call('system', 'page')).rejects.toBe(failure);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'partial', system: 'system', prompt: 'page', text: 'partial draft', complete: false,
    });
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('persists a partial response through its request identity before the shared observer', async () => {
    const failure = Object.assign(new Error('stream incomplete'), {
      code: 'LLM_STREAM_TRUNCATED', isRetryable: false, rawResponse: 'identity-owned partial draft',
    });
    mocks.stream.mockReset().mockRejectedValue(failure);
    const order: string[] = [];
    const onResponse = vi.fn(() => { order.push('request'); });
    const sharedObserver = vi.fn(() => { order.push('shared'); });
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'page-content', streamResponse: true,
      onResponse: sharedObserver, requireResponsePersistence: true,
    }), { onResponse });
    await expect(call('system', 'page')).rejects.toBe(failure);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'page-content', system: 'system', prompt: 'page', text: 'identity-owned partial draft', complete: false,
    });
    expect(order).toEqual(['request', 'shared']);
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('marks parseable JSON as incomplete when the provider truncates its stream', async () => {
    const text = '{"questions":[]}';
    const failure = Object.assign(new Error('stream truncated'), {
      code: 'LLM_STREAM_INCOMPLETE', isRetryable: false, rawResponse: text,
    });
    mocks.stream.mockReset().mockRejectedValue(failure);
    const onResponse = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'quiz', streamResponse: true,
      requireResponsePersistence: true,
    }), { onResponse });
    await expect(call('system', 'question contract')).rejects.toBe(failure);
    expect(JSON.parse(text)).toEqual({ questions: [] });
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'quiz', system: 'system', prompt: 'question contract', text, complete: false,
    });
    await expect(call('system', 'question contract')).rejects.toMatchObject({ code: 'LLM_RETRY_BUDGET_EXHAUSTED' });
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it.each(['request', 'shared'])('does not replay an interrupted draft when %s raw storage fails', async (owner) => {
    const partial = Object.assign(new Error('stream incomplete'), {
      code: 'LLM_STREAM_TRUNCATED', isRetryable: false, rawResponse: 'saved-costly-partial',
    });
    mocks.stream.mockReset().mockRejectedValue(partial);
    const cause = Object.assign(new Error('store unavailable'), { statusCode: 503 });
    const observer = (label: string) => vi.fn(() => { if (label === owner) throw cause; });
    const request = observer('request');
    const shared = observer('shared');
    const context = { onResponse: request, onRetry: vi.fn() };
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'page-content', streamResponse: true,
      onResponse: shared, requireResponsePersistence: true,
    }), context);
    await expect(call('system', 'page')).rejects.toMatchObject({
      code: 'LLM_RESPONSE_PERSISTENCE_FAILED', isRetryable: false, rawResponse: partial.rawResponse, cause,
    });
    await expect(call('system', 'page')).rejects.toMatchObject({ code: 'LLM_RETRY_BUDGET_EXHAUSTED' });
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(shared).toHaveBeenCalledTimes(owner === 'shared' ? 1 : 0);
    expect(context.onRetry).not.toHaveBeenCalled();
  });

  it('caps an explicitly rejected request at two provider attempts and cannot reset it', async () => {
    vi.useFakeTimers();
    try {
      const failure = Object.assign(new Error('overloaded'), { statusCode: 503 });
      mocks.call.mockReset().mockRejectedValue(failure);
      const context = { onAttemptStarting: vi.fn() };
      const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
        model: {} as LanguageModel, vision: false, source: 'overloaded', maxRetries: 10,
      }), context);
      const assertion = expect(call('system', 'page')).rejects.toBe(failure);
      await vi.runAllTimersAsync();
      await assertion;
      await expect(call('system', 'page')).rejects.toMatchObject({ code: 'LLM_RETRY_BUDGET_EXHAUSTED' });
      expect(mocks.call).toHaveBeenCalledTimes(2);
      expect(context.onAttemptStarting.mock.calls.map(([event]) => event.totalAttempt)).toEqual([1, 2]);
    } finally { vi.useRealTimers(); }
  });

  it.each([1, 2, 3])('does not restart an already-started stage after restart (attempts=%s)', async (attemptsStarted) => {
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
    const exhausted = withCourseGenerationAiCallContext(base, {
      attemptsStarted,
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

  it('does not retry an idle stream with an unknown provider state', async () => {
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
      const assertion = expect(call('system', 'page')).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.runAllTimersAsync();
      await assertion;
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new DOMException('teacher cancelled', 'AbortError'),
    Object.freeze(new DOMException('teacher cancelled', 'AbortError')),
    'teacher cancelled',
  ])('persists emitted content before preserving external cancellation %s', async (cancelled) => {
    const controller = new AbortController();
    const text = '{"completed-looking":"draft"}';
    mocks.stream.mockReset().mockImplementation(async () => {
      controller.abort(cancelled);
      throw Object.assign(new Error('provider wrapped cancellation'), { rawResponse: text });
    });
    const onResponse = vi.fn();
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model: {} as LanguageModel, vision: false, source: 'page-content',
      signal: controller.signal, streamResponse: true, requireResponsePersistence: true,
    }), { onResponse, onRetry });

    if (typeof cancelled === 'string') {
      await expect(call('system', 'page')).rejects.toMatchObject({ name: 'AbortError' });
    } else {
      await expect(call('system', 'page')).rejects.toBe(cancelled);
    }
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      source: 'page-content', system: 'system', prompt: 'page', text, complete: false,
    });
    await expect(call('system', 'page')).rejects.toMatchObject({ code: 'LLM_RETRY_BUDGET_EXHAUSTED' });
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
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
