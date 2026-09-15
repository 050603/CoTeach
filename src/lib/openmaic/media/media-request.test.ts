import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from './image-providers';
import { generateVideo } from './video-providers';
import { generateWithSeedance } from './adapters/seedance-adapter';
import { withGenerationRetry } from '../generation/generation-retry';
import { fetchMediaRequest } from './media-request';
import type { ImageProviderId, VideoProviderId } from './types';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T00:00:00Z')); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function exhaust(operation: Promise<unknown>, expected: Record<string, unknown>) {
  const assertion = expect(operation).rejects.toMatchObject(expected);
  await vi.runAllTimersAsync();
  await assertion;
}

describe('media HTTP request retry boundary', () => {
  it.each<ImageProviderId>(['seedream', 'openai-image', 'qwen-image', 'nano-banana', 'minimax-image', 'grok-image', 'lemonade'])('%s keeps Retry-After and caps its HTTP attempts at three', async (providerId) => {
    const requestedAt: number[] = [];
    const fetcher = vi.fn().mockImplementation(async () => {
      requestedAt.push(Date.now());
      return new Response('throttled', { status: 429, headers: { 'Retry-After': '30' } });
    });
    vi.stubGlobal('fetch', fetcher);
    await exhaust(generateImage({ providerId, apiKey: 'test-key' }, { prompt: 'A leaf' }), { statusCode: 429, retryAfterMs: 30_000, isRetryable: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(requestedAt.map((time) => time - requestedAt[0])).toEqual([0, 30_000, 60_000]);
  });

  it.each<VideoProviderId>(['seedance', 'kling', 'veo', 'minimax-video', 'grok-video', 'happyhorse'])('%s preserves failed submission metadata without stacked retries', async (providerId) => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('busy', { status: 503, headers: { 'Retry-After': '7' } }));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(withGenerationRetry(() => generateVideo({ providerId, apiKey: 'access:secret' }, { prompt: 'Moving leaf' }), { label: 'outer guard test', maxRetries: 2 }), { statusCode: 503, retryAfterMs: 7_000, isRetryable: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('honors HTTP-date Retry-After on the same read-only poll request', async () => {
    const initial = Date.now();
    const times: number[] = [];
    const fetcher = vi.fn().mockImplementation(async () => {
      times.push(Date.now());
      return times.length === 1 ? new Response('wait', { status: 429, headers: { 'Retry-After': new Date(initial + 45_000).toUTCString() } }) : Response.json({ status: 'running' });
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchMediaRequest('https://provider.test/task/same');
    await vi.runAllTimersAsync();
    expect((await pending).ok).toBe(true);
    expect(times[1] - times[0]).toBe(45_000);
  });

  it('retries a failed poll against its original task and never submits another video', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') return Response.json({ id: 'original-task' });
      const polls = fetcher.mock.calls.filter(([, request]) => request.method === 'GET').length;
      if (polls < 3) return new Response('busy', { status: 503 });
      return Response.json({ status: 'succeeded', content: { video_url: 'https://cdn.test/video.mp4' }, duration: 5 });
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = generateWithSeedance({ providerId: 'seedance', apiKey: 'test' }, { prompt: 'A leaf' });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ url: 'https://cdn.test/video.mp4' });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    const polls = fetcher.mock.calls.filter(([, init]) => init.method === 'GET');
    expect(polls).toHaveLength(3);
    expect(new Set(polls.map(([url]) => url))).toEqual(new Set(['https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/original-task']));
  });

  it('exhausted poll errors cannot make an enclosing retry submit again', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => init.method === 'POST'
      ? Response.json({ id: 'original-task' }) : new Response('busy', { status: 503, headers: { 'Retry-After': '1' } }));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(withGenerationRetry(() => generateWithSeedance({ providerId: 'seedance', apiKey: 'test' }, { prompt: 'A leaf' }), { label: 'outer guard', maxRetries: 2 }), { statusCode: 503, isRetryable: false });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(3);
  });

  it('does not repeat successful HTTP responses with missing IDs or invalid poll structures', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(generateWithSeedance({ providerId: 'seedance', apiKey: 'test' }, { prompt: 'A leaf' }), { isRetryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockImplementation(async (_url: string, init: RequestInit) => Response.json(init.method === 'POST' ? { id: 'original-task' } : {}));
    await exhaust(generateWithSeedance({ providerId: 'seedance', apiKey: 'test' }, { prompt: 'A leaf' }), { isRetryable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each<ImageProviderId>(['seedream', 'openai-image', 'qwen-image', 'nano-banana', 'minimax-image', 'grok-image', 'lemonade'])('%s rejects invalid completed image data without requesting another image', async (providerId) => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(generateImage({ providerId, apiKey: 'test' }, { prompt: 'A leaf' }), { isRetryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not let a task polling deadline trigger resubmission', async () => {
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => Response.json(init.method === 'POST' ? { id: 'original-task' } : { status: 'running' }));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(withGenerationRetry(() => generateWithSeedance({ providerId: 'seedance', apiKey: 'test' }, { prompt: 'A leaf' }), { label: 'outer guard', maxRetries: 2 }), { isRetryable: false });
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(60);
  });

  it('does not classify unsupported HTTP errors by misleading body wording', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('upstream timeout', { status: 501 }));
    vi.stubGlobal('fetch', fetcher);
    await exhaust(fetchMediaRequest('https://provider.test/task/one'), { statusCode: 501, isRetryable: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
