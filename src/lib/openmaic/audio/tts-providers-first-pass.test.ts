import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateTTS,
  qwenSpeechLanguage,
  resolveQwenAudioTtsEndpoint,
  throwIfTtsRateLimited,
} from './tts-providers';

afterEach(() => vi.unstubAllGlobals());

describe('TTS provider first-pass requests', () => {
  it('does not request a second synthesis when a Qwen stream has no audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"output":{}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTS({ providerId: 'qwen-tts', voice: 'loongmary', language: 'en-US', apiKey: 'test' }, 'Observe this leaf.'))
      .rejects.toMatchObject({ isRetryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'qwen-audio-3.0-tts-flash',
      input: {
        voice: 'loongmary',
        format: 'wav',
        sample_rate: 24000,
        rate: 1,
        language_hints: ['en'],
      },
    });
  });

  it('preserves temporary HTTP failure and Retry-After metadata', () => {
    expect(() => throwIfTtsRateLimited('Qwen', 503, new Headers({ 'Retry-After': '12' })))
      .toThrow(expect.objectContaining({ statusCode: 503, retryAfterMs: 12_000 }));
    expect(() => throwIfTtsRateLimited('Qwen', 429, new Headers({ 'Retry-After': '3' })))
      .toThrow(expect.objectContaining({ statusCode: 429, retryAfterMs: 3_000 }));
    expect(() => throwIfTtsRateLimited('Qwen', 401)).not.toThrow();
  });

  it('uses supported ISO language hints and normalizes compatible-mode URLs', () => {
    expect(qwenSpeechLanguage('zh-CN')).toBe('zh');
    expect(qwenSpeechLanguage('en-US')).toBe('en');
    expect(qwenSpeechLanguage('mixed')).toBeUndefined();
    expect(resolveQwenAudioTtsEndpoint('https://example.test/compatible-mode/v1')).toBe(
      'https://example.test/api/v1/services/audio/tts/SpeechSynthesizer',
    );
  });
});
