import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  createAzure: vi.fn(),
  createAnthropic: vi.fn(),
  createGoogle: vi.fn(),
  createBedrock: vi.fn(),
  proxyAgentUrls: [] as Array<{ uri: string; pipelining: number }>,
  undiciFetch: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI,
}));
vi.mock('@ai-sdk/azure', () => ({ createAzure: mocks.createAzure }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: mocks.createGoogle }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: mocks.createBedrock }));

vi.mock('undici', () => ({
  ProxyAgent: class ProxyAgent {
    constructor(url: { uri: string; pipelining: number }) {
      mocks.proxyAgentUrls.push(url);
    }
  },
  fetch: mocks.undiciFetch,
}));

import { getModel } from './providers';

describe('OpenAI-compatible provider proxy transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.undiciFetch.mockReset();
    mocks.proxyAgentUrls.length = 0;
    mocks.createOpenAI.mockImplementation(() => ({
      chat: (modelId: string) => ({ modelId }),
      responses: (modelId: string) => ({ modelId }),
    }));
    mocks.createAzure.mockReturnValue((modelId: string) => ({ modelId }));
    mocks.createBedrock.mockReturnValue((modelId: string) => ({ modelId }));
    mocks.createAnthropic.mockReturnValue({ chat: (modelId: string) => ({ modelId }) });
    mocks.createGoogle.mockReturnValue({ chat: (modelId: string) => ({ modelId }) });
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each([
    ['azure', mocks.createAzure], ['anthropic', mocks.createAnthropic],
    ['google', mocks.createGoogle], ['bedrock', mocks.createBedrock],
  ] as const)('honors the explicit proxy for %s SDK requests', async (providerId, factory) => {
    mocks.undiciFetch.mockResolvedValue(new Response('{}'));
    getModel({ providerId, modelId: 'test-model', apiKey: 'test', proxy: 'http://managed.test:19999' });
    const transport = factory.mock.calls[0][0].fetch as typeof fetch;
    expect(transport).toBeTypeOf('function');
    await transport('https://model.test/v1', { method: 'POST', body: '{}' });
    expect(mocks.proxyAgentUrls).toEqual([{ uri: 'http://managed.test:19999', pipelining: 0 }]);
    expect(mocks.undiciFetch).toHaveBeenCalledOnce();
  });

  it('keeps a local model direct even when an explicit proxy is configured', async () => {
    const direct = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', direct);
    getModel({ providerId: 'openai', modelId: 'test', apiKey: 'test', proxy: 'http://managed.test:19999' });
    await mocks.createOpenAI.mock.calls[0][0].fetch('http://127.0.0.1:11434/v1/chat/completions', {});
    expect(direct).toHaveBeenCalledOnce();
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
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

    expect(mocks.proxyAgentUrls).toEqual([{ uri: 'http://127.0.0.1:9999', pipelining: 0 }]);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        dispatcher: expect.anything(),
      }),
    );
  });

  it('recovers an empty-response DeepSeek socket reset within the first model call', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const socketClose = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET', socket: { bytesRead: 0 },
      }),
    });
    mocks.undiciFetch.mockRejectedValueOnce(socketClose)
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    getModel({ providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test', proxy: 'http://127.0.0.1:19999' });
    const transport = mocks.createOpenAI.mock.calls[0]?.[0].fetch as typeof fetch;

    const response = await transport('https://api.deepseek.com/chat/completions', {
      method: 'POST', body: '{}',
    });

    expect(response.status).toBe(200);
    expect(mocks.undiciFetch).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it('does not replay a request after response bytes were received', async () => {
    const socketClose = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET', socket: { bytesRead: 1 },
      }),
    });
    mocks.undiciFetch.mockRejectedValueOnce(socketClose);
    getModel({ providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test', proxy: 'http://127.0.0.1:19999' });
    const transport = mocks.createOpenAI.mock.calls[0]?.[0].fetch as typeof fetch;

    await expect(transport('https://api.deepseek.com/chat/completions', {
      method: 'POST', body: '{}',
    })).rejects.toBe(socketClose);
    expect(mocks.undiciFetch).toHaveBeenCalledOnce();
  });
});
