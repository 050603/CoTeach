import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  done: vi.fn(), failed: vi.fn(), put: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@openmaic/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({ imageGenerationEnabled: true, imageProviderId: 'qwen-image' }) } }));
vi.mock('@openmaic/lib/store/media-generation', () => ({ useMediaGenerationStore: { getState: () => ({
  getTask: () => undefined, enqueueTasks: vi.fn(), markGenerating: vi.fn(), markDone: mocks.done, markFailed: mocks.failed,
}) } }));
vi.mock('@openmaic/lib/utils/database', () => ({ db: { mediaFiles: { put: mocks.put } }, mediaFileKey: (s: string, e: string) => `${s}:${e}` }));
import { generateMediaForOutlines } from './media-orchestrator';
const outline = (id: string) => [{ id, type: 'slide' as const, title: 't', description: 'd', keyPoints: [], order: 0,
  mediaGenerations: [{ type: 'image' as const, elementId: id, prompt: 'diagram' }],
}];
describe('browser media first-pass recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:test'; } }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('retries downloads of the same result without another image generation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: true, result: { url: 'https://example.com/image.png' } }))
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Blob(['image'])));
    vi.stubGlobal('fetch', fetcher);
    const pending = generateMediaForOutlines(outline('download'), 'stage');
    await vi.runAllTimersAsync(); await pending;
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/openmaic/generate/image', '/api/openmaic/proxy-media', '/api/openmaic/proxy-media']);
    expect(mocks.done).toHaveBeenCalledOnce();
  });
  it('does not repeat the server operation after its provider request retries', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: 'unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const pending = generateMediaForOutlines(outline('fault'), 'stage');
    await vi.runAllTimersAsync(); await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.failed).toHaveBeenCalledOnce();
  });
  it('fails an invalid successful payload without another generation request', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, result: {} }));
    vi.stubGlobal('fetch', fetcher);
    await generateMediaForOutlines(outline('invalid'), 'stage');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledOnce();
  });
  it('does not reinterpret an invalid upstream result as a network fault across the API', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'empty image' }, { status: 500, headers: { 'x-generation-retryable': 'false' } }));
    vi.stubGlobal('fetch', fetcher);
    await generateMediaForOutlines(outline('upstream-invalid'), 'stage');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.failed).toHaveBeenCalledOnce();
  });
});
