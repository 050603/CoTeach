import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateWithQwenImage, testQwenImageConnectivity } from './qwen-image-adapter';

describe('Qwen image throttling metadata', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('preserves 429 status and Retry-After for the shared retry policy', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ code: 'Throttling.RateQuota', message: 'rate limit exceeded' }),
      { status: 429, headers: { 'Retry-After': '30' } },
    )));

    const pending = expect(generateWithQwenImage(
      { providerId: 'qwen-image', apiKey: 'test-key' },
      { prompt: 'classroom illustration' },
    )).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 30_000, isRetryable: false });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('forwards cover controls and cancellation to Qwen Image 3.0 Pro', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: {
        choices: [{ message: { content: [{ image: 'https://cdn.example.test/cover.png' }] } }],
      },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await generateWithQwenImage(
      { providerId: 'qwen-image', apiKey: 'test-key', model: 'qwen-image-3.0-pro' },
      {
        prompt: 'specific course scene',
        width: 2688,
        height: 1536,
        promptExtend: false,
        seed: 1_234_567,
        signal: controller.signal,
      },
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal?.aborted).toBe(false);
    controller.abort();
    expect(request.signal?.aborted).toBe(true);
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'qwen-image-3.0-pro',
      parameters: { prompt_extend: false, seed: 1_234_567, size: '2688*1536' },
    });
  });
});

describe('Qwen image connectivity security', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not automatically follow redirects during the credential probe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', fetchMock);

    await testQwenImageConnectivity({ providerId: 'qwen-image', apiKey: 'test-key' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});
