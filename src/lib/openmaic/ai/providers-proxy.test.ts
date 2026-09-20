import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  proxyAgentUrls: [] as string[],
  undiciFetch: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock('undici', () => ({
  ProxyAgent: class ProxyAgent {
    constructor(url: string) {
      mocks.proxyAgentUrls.push(url);
    }
  },
  fetch: mocks.undiciFetch,
}));

import { getModel } from './providers';

describe('OpenAI-compatible provider proxy transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyAgentUrls.length = 0;
    mocks.createOpenAI.mockImplementation(() => ({
      chat: (modelId: string) => ({ modelId }),
      responses: (modelId: string) => ({ modelId }),
    }));
  });

  it('passes requests through the configured HTTP proxy', async () => {
    mocks.undiciFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    getModel({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'test-key',
      proxy: 'http://127.0.0.1:9999',
    });

    const options = mocks.createOpenAI.mock.calls[0]?.[0] as {
      fetch?: typeof fetch;
    };
    expect(options.fetch).toBeTypeOf('function');

    await options.fetch?.('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });

    expect(mocks.proxyAgentUrls).toEqual(['http://127.0.0.1:9999']);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        dispatcher: expect.anything(),
      }),
    );
  });
});
