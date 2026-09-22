import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }));
vi.mock('undici', () => ({
  ProxyAgent: class {
    close = mocks.close;
    constructor(options: unknown) { mocks.agent(options); }
  },
  fetch: mocks.fetch,
}));
import { proxyFetch, resolveProxyUrl } from './proxy-fetch';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('proxy fetch configuration', () => {
  it('prefers the media-scoped outbound proxy', () => {
    expect(resolveProxyUrl({
      OPENPBL_OUTBOUND_PROXY: 'http://media-proxy.internal:8080',
      HTTPS_PROXY: 'http://global-proxy.internal:8080',
    })).toBe('http://media-proxy.internal:8080');
  });

  it('keeps supporting standard proxy environment variables', () => {
    expect(resolveProxyUrl({ HTTPS_PROXY: 'http://proxy.internal:8080' }))
      .toBe('http://proxy.internal:8080');
  });

  it('returns undefined when no proxy is configured', () => {
    expect(resolveProxyUrl({})).toBeUndefined();
  });

  it('uses a fresh tunnel policy and preserves bodies and cancellation', async () => {
    vi.stubEnv('OPENPBL_OUTBOUND_PROXY', 'http://managed.test:19999');
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '');
    const response = new Response('complete');
    mocks.fetch.mockResolvedValueOnce(response);
    const signal = new AbortController().signal;
    expect(await proxyFetch('https://model.test/v1', { method: 'POST', body: '{}', signal })).toBe(response);
    expect(mocks.agent).toHaveBeenCalledWith({ uri: 'http://managed.test:19999', pipelining: 0 });
    expect(mocks.fetch).toHaveBeenCalledWith('https://model.test/v1', expect.objectContaining({ method: 'POST', body: '{}', signal }));
  });

  it('honors an explicit provider proxy before the deployment fallback', async () => {
    vi.stubEnv('OPENPBL_OUTBOUND_PROXY', 'http://managed.test:19999');
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '');
    mocks.fetch.mockResolvedValueOnce(new Response('ok'));
    await proxyFetch('https://model.test', {}, 'http://provider.test:8080');
    expect(mocks.agent).toHaveBeenCalledWith({ uri: 'http://provider.test:8080', pipelining: 0 });
  });

  it('bridges SDK Request objects while preserving uploads and cancellation', async () => {
    vi.stubEnv('OPENPBL_OUTBOUND_PROXY', 'http://upload-proxy.test:19999');
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '');
    mocks.fetch.mockResolvedValueOnce(new Response('{}'));
    const controller = new AbortController();
    const request = new Request('https://model.test/transcribe', {
      method: 'POST', body: 'audio payload', headers: { 'content-type': 'audio/wav' }, signal: controller.signal,
    });
    await proxyFetch(request);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe(request.url);
    expect(options).toMatchObject({ method: 'POST', duplex: 'half' });
    expect(options.headers.get('content-type')).toBe('audio/wav');
    expect(await new Response(options.body).text()).toBe('audio payload');
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  it.each(['http://127.0.0.1:11434/api/embed', 'http://127.0.0.2:3004', 'http://[::1]:11434', 'http://localhost:3003']) (
    'keeps local service %s direct even with an invalid proxy', async (url) => {
      vi.stubEnv('OPENPBL_OUTBOUND_PROXY', 'invalid proxy');
      const direct = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', direct);
      await proxyFetch(url);
      expect(direct).toHaveBeenCalledWith(url, undefined);
      expect(mocks.agent).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('honors NO_PROXY host and port exclusions', async () => {
    vi.stubEnv('no_proxy', ''); vi.stubEnv('NO_PROXY', '.internal.test:443');
    vi.stubEnv('OPENPBL_OUTBOUND_PROXY', 'http://managed.test:19999');
    const direct = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', direct);
    await proxyFetch('https://model.internal.test/chat');
    expect(direct).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
