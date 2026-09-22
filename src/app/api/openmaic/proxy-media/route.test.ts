import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), connection: vi.fn(), close: vi.fn() }));
vi.mock('undici', () => ({ fetch: mocks.fetch }));
vi.mock('@/lib/openmaic/server/ssrf-guard', () => ({ createSsrfSafeDispatcher: mocks.connection }));
vi.mock('@/lib/auth/request-guards', () => ({
  requireSameOrigin: () => null,
  authenticateRequest: async () => ({ claims: { sub: 'test' } }),
}));
vi.mock('@/lib/auth/distributed-rate-limit', () => ({ checkDistributedRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/observability/logger', () => ({ logger: { warn: vi.fn() } }));
import { POST } from './route';
const request = (signal?: AbortSignal) => new Request('https://coteach.example/api/openmaic/proxy-media', {
  method: 'POST', body: JSON.stringify({ url: 'https://media.example/a.png' }), signal,
});

describe('media proxy connection lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.connection.mockResolvedValue({ dispatcher: {}, close: mocks.close });
  });
  afterEach(() => vi.restoreAllMocks());

  it('closes the connection on fetch failure and reports an upstream error', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection reset'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('UPSTREAM_ERROR');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps safety rejections forbidden without starting a request', async () => {
    mocks.connection.mockRejectedValue(new Error('Local/private network URLs are not allowed'));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('INVALID_URL');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('revalidates each redirect and closes its previous connection', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    mocks.connection.mockResolvedValueOnce({ dispatcher: {}, close: mocks.close })
      .mockRejectedValueOnce(new Error('private destination'));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.connection.mock.calls.map(([url]) => url)).toEqual(['https://media.example/a.png', 'http://127.0.0.1/private']);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps the dispatcher alive until the returned response body finishes', async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const response = await POST(request());
    expect(mocks.close).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('closes the dispatcher when the downstream cancels a stream', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/png' } }));
    const response = await POST(request());
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('propagates user cancellation to fetch and closes its dispatcher', async () => {
    const controller = new AbortController();
    const reason = new Error('user left');
    mocks.fetch.mockImplementation(async (_url, { signal }: { signal: AbortSignal }) => {
      controller.abort(reason);
      signal.throwIfAborted();
    });
    const response = await POST(request(controller.signal));
    expect(response.status).toBe(502);
    expect(mocks.fetch.mock.calls[0][1].signal.reason).toBe(reason);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('preserves media content and size restrictions', async () => {
    mocks.fetch.mockResolvedValue(new Response('html', { headers: { 'content-type': 'text/html' } }));
    expect((await POST(request())).status).toBe(415);
    mocks.fetch.mockResolvedValue(new Response('image', { headers: { 'content-type': 'image/png', 'content-length': String(26 * 1024 * 1024) } }));
    expect((await POST(request())).status).toBe(413);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
