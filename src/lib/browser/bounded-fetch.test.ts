import { afterEach, expect, it, vi } from 'vitest';
import { boundedFetch } from './bounded-fetch';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('releases a request whose transport never settles', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input, init) => {
    signal = init.signal;
    return new Promise(() => undefined);
  }));
  const pending = expect(boundedFetch('/slow', {}, 50)).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(signal?.aborted).toBe(true);
});

it('bounds a response whose headers arrive but body hangs', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
  const pending = expect(boundedFetch('/slow-body', {}, 50)).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(50);
  await pending;
});

it('propagates course switch cancellation and preserves response status/body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ saved: true }, { status: 202 })));
  const response = await boundedFetch('/ok');
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ saved: true });
  vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController();
  const pending = expect(boundedFetch('/old-course', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await pending;
});
