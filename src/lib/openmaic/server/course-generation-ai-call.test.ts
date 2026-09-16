import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
const mocks = vi.hoisted(() => ({ call: vi.fn(), stream: vi.fn() }));
vi.mock('@openmaic/lib/ai/llm', () => ({
  callLLM: mocks.call,
  callStreamingLLMText: mocks.stream,
}));
import { createCourseGenerationAiCall } from './course-generation-ai-call';

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
    });
    await expect(call('system', 'widget')).resolves.toBe('<html>widget</html>');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(mocks.stream.mock.calls[0][0]).toMatchObject({
      model,
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

  it('refreshes the stream inactivity deadline when reasoning or text arrives', async () => {
    vi.useFakeTimers();
    try {
      mocks.stream.mockReset().mockImplementation(async (...args: unknown[]) => {
        const lifecycle = args[3] as { onActivity?: () => void } | undefined;
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        lifecycle?.onActivity?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        lifecycle?.onActivity?.();
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
