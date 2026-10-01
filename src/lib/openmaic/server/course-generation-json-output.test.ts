import { describe, expect, it, vi } from 'vitest';
import { getModel } from '../ai/providers';
import { runWithCourseGenerationLlmContext } from '@/lib/course-generation/llm-concurrency';
import { createCourseGenerationAiCall, withCourseGenerationAiCallContext } from './course-generation-ai-call';

vi.mock('@/lib/llm/classroom-capacity', () => ({
  withClassroomAiCapacity: (fn: () => Promise<unknown>) => fn(),
}));

const draft = JSON.stringify({ sections: [{ pages: [{
  taskConnection: { mode: 'none', rationale: '独立说明更清楚' },
  caseObservation: { kind: 'none', reason: '本页用文字解释判据' },
}] }] });

function completedResponse(text: string, stream: boolean): Response {
  const usage = { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 };
  if (!stream) return new Response(JSON.stringify({
    id: 'test-response', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage,
  }), { headers: { 'content-type': 'application/json' } });
  const parts = [
    { delta: { role: 'assistant', reasoning_content: '先确定页面职责与字段层级。' }, finish_reason: null },
    { delta: { content: text.slice(0, 20) }, finish_reason: null },
    { delta: { content: text.slice(20) }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' },
  ];
  const events = parts.map((part, index) => `data: ${JSON.stringify({
    id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, ...part }], ...(index === parts.length - 1 ? { usage } : {}),
  })}\n\n`).join('');
  return new Response(`${events}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

describe('native course JSON authoring transport', () => {
  it.each([false, true])('requests JSON in the original provider call and retains the exact draft for streaming=%s', async (streamResponse) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(draft, streamResponse));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash', apiKey: 'test-key', fetchImpl });
    const onResponse = vi.fn();
    const onStarted = vi.fn();
    const onCallUsage = vi.fn();
    const onActivity = vi.fn();
    const thinking = { mode: 'enabled', effort: 'high' } as const;
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model, vision: false, source: 'blueprint', streamResponse, responseFormat: 'json',
      maxOutputTokens: 131_072, thinking, onResponse, requireResponsePersistence: true,
    }), { onStarted, onActivity });
    const text = await runWithCourseGenerationLlmContext(() => call('Return JSON.', 'Write the object once.'), { onCallUsage });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ model: 'deepseek-flash', response_format: { type: 'json_object' },
      max_tokens: 131_072, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(text).toBe(draft);
    expect(JSON.parse(text).sections[0].pages[0]).toHaveProperty('caseObservation.kind', 'none');
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: draft, complete: true }));
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ requestPolicy: {
      maxOutputTokens: 131_072, thinking, responseFormat: 'json',
    } }));
    expect(onCallUsage).toHaveBeenCalledOnce();
    if (streamResponse) expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reasoning' }));
  });

  it.each([false, true])('does not commission a format fallback when the provider rejects JSON for streaming=%s', async (streamResponse) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'response_format is unsupported', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash', apiKey: 'test-key', fetchImpl });
    const onRetry = vi.fn();
    const onResponse = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model, vision: false, source: 'blueprint', streamResponse, responseFormat: 'json', onResponse,
    }), { onRetry });
    await expect(runWithCourseGenerationLlmContext(() => call('Return JSON.', 'Write the object.'), {
      onCallUsage: vi.fn(),
    })).rejects.toThrow('response_format is unsupported');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    // Streaming failures can retain an empty partial draft for diagnostics.
    expect(onResponse.mock.calls.every(([response]) => response.complete === false)).toBe(true);
  });

  it('retains every raw delta and reports whitespace activity when a native JSON stream fails inside a property name', async () => {
    const deltas = ['{"value":1', '   ', ',"unfinishedKey'];
    const events = deltas.map((content) => `data: ${JSON.stringify({
      id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`).join('');
    const response = new Response(`${events}data: ${JSON.stringify({
      error: { message: 'connection interrupted after output', type: 'server_error' },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash', apiKey: 'test-key', fetchImpl });
    const onResponse = vi.fn();
    const onActivity = vi.fn();
    const onRetry = vi.fn();
    const call = withCourseGenerationAiCallContext(createCourseGenerationAiCall({
      model, vision: false, source: 'blueprint', streamResponse: true, responseFormat: 'json',
      onResponse, requireResponsePersistence: true,
    }), { onActivity, onRetry });
    await expect(runWithCourseGenerationLlmContext(() => call('Return JSON.', 'Write the object once.'), {
      onCallUsage: vi.fn(),
    })).rejects.toMatchObject({ rawResponse: deltas.join(''), outputStarted: true, isRetryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: deltas.join(''), complete: false }));
    expect(onActivity.mock.calls.filter(([activity]) => activity.kind === 'text').map(([activity]) => activity.textCharacters))
      .toEqual(deltas.map((_, index) => deltas.slice(0, index + 1).join('').length));
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toHaveProperty('response_format.type', 'json_object');
  });

  it('stores a malformed complete native JSON draft before the existing course parser checks it', async () => {
    const raw = '{"value":';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(raw, false));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash', apiKey: 'test-key', fetchImpl });
    const onResponse = vi.fn();
    const call = createCourseGenerationAiCall({ model, vision: false, source: 'blueprint', responseFormat: 'json',
      onResponse, requireResponsePersistence: true });
    expect(await runWithCourseGenerationLlmContext(() => call('Return JSON.', 'Write the object.'), {
      onCallUsage: vi.fn(),
    })).toBe(raw);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: raw, complete: true }));
    expect(() => JSON.parse(raw)).toThrow();
  });

  it('continues to author complete HTML without JSON mode in the same transport', async () => {
    const html = '<html><body>可操作的完整页面</body></html>';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completedResponse(html, true));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash', apiKey: 'test-key', fetchImpl });
    const call = createCourseGenerationAiCall({ model, vision: false, source: 'interactive', streamResponse: true });
    expect(await runWithCourseGenerationLlmContext(() => call('Return HTML.', 'Write the widget.'), {
      onCallUsage: vi.fn(),
    })).toBe(html);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).not.toHaveProperty('response_format');
  });
});
