import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModel } from './providers';
import { streamLLM } from './llm';
import { thinkingConfigFromPreset } from './thinking-scenarios';

afterEach(() => vi.unstubAllGlobals());

describe('streamed Alibaba thinking request', () => {
  it('carries each concurrent request preference through the SDK to the HTTP body', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
        choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash',
      apiKey: 'test-key', baseUrl: 'https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' });
    await Promise.all((['none', 'low', 'high', 'baseline'] as const).map(async (preset) => {
      const result = streamLLM({ model, prompt: preset, maxOutputTokens: 24000, maxRetries: 0 },
        'wire-test', thinkingConfigFromPreset(preset));
      expect(await result.text).toBe('{}');
    }));
    const find = (preset: string) => bodies.find((body) => JSON.stringify(body.messages).includes(preset));
    expect(find('none')).toMatchObject({ enable_thinking: false, max_tokens: 24000 });
    expect(find('low')).toMatchObject({ enable_thinking: true, reasoning_effort: 'low' });
    expect(find('high')).toMatchObject({ enable_thinking: true, reasoning_effort: 'high' });
    expect(find('baseline')).not.toHaveProperty('enable_thinking');
    expect(bodies.every((body) => !('thinking_budget' in body))).toBe(true);
  });
});
