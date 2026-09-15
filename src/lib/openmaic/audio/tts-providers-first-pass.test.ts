import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTTS, qwenSpeechLanguage, throwIfTtsRateLimited } from './tts-providers';

afterEach(() => vi.unstubAllGlobals());

describe('TTS provider first-pass requests', () => {
  it('does not request a second synthesis when a Qwen stream has no audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"output":{}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTS({ providerId: 'qwen-tts', voice: 'Ethan', language: 'en-US', apiKey: 'test' }, 'Observe this leaf.'))
      .rejects.toMatchObject({ isRetryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input.language_type).toBe('English');
  });

  it('preserves temporary HTTP failure and Retry-After metadata', () => {
    expect(() => throwIfTtsRateLimited('Qwen', 503, new Headers({ 'Retry-After': '12' })))
      .toThrow(expect.objectContaining({ statusCode: 503, retryAfterMs: 12_000 }));
    expect(() => throwIfTtsRateLimited('Qwen', 429, new Headers({ 'Retry-After': '3' })))
      .toThrow(expect.objectContaining({ statusCode: 429, retryAfterMs: 3_000 }));
    expect(() => throwIfTtsRateLimited('Qwen', 401)).not.toThrow();
  });

  it('uses automatic language only for mixed or unspecified speech', () => {
    expect(qwenSpeechLanguage('zh-CN')).toBe('Chinese');
    expect(qwenSpeechLanguage('en-US')).toBe('English');
    expect(qwenSpeechLanguage('mixed')).toBe('Auto');
  });
});
