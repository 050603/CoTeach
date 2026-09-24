import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock('@openmaic/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));

import { generateTTS } from './tts-providers';

function pcmWav(payload: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + payload.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 0x7fffffff, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, 0x7fffffff, true);
  wav.set(payload, 44);
  return wav;
}

function qwenSseResponse(audio: Uint8Array): Response {
  const base64 = Buffer.from(audio).toString('base64');
  return new Response(
    `data: ${JSON.stringify({ output: { audio: { data: base64 } } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => mocks.proxyFetch.mockReset());

describe('Qwen TTS WAV handling', () => {
  it('does not wrap an upstream WAV header as audible PCM', async () => {
    const pcm = Uint8Array.from([0xfe, 0xff, 0xfd, 0xff, 0x02, 0x00]);
    mocks.proxyFetch.mockResolvedValue(qwenSseResponse(pcmWav(pcm)));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段测试语音。',
    );

    expect(result.format).toBe('wav');
    expect(result.audio.byteLength).toBe(44 + pcm.byteLength);
    expect(result.audio.slice(44)).toEqual(pcm);
    expect(new DataView(result.audio.buffer).getUint32(40, true)).toBe(pcm.byteLength);
  });

  it('still wraps genuine raw PCM exactly once', async () => {
    const pcm = Uint8Array.from([0, 0, 1, 0]);
    mocks.proxyFetch.mockResolvedValue(qwenSseResponse(pcm));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段测试语音。',
    );

    expect(result.audio.byteLength).toBe(44 + pcm.byteLength);
    expect(result.audio.slice(44)).toEqual(pcm);
  });

  it('marks an empty successful SSE response as retryable', async () => {
    mocks.proxyFetch.mockResolvedValue(new Response(
      'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));

    await expect(generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段需要重试的语音。',
    )).rejects.toMatchObject({ isRetryable: true });
  });

  it('downloads the completed audio when SSE ends with a URL but no audio chunks', async () => {
    const wav = pcmWav(Uint8Array.from([1, 0, 2, 0]));
    mocks.proxyFetch
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({ request_id: 'req-url', output: { finish_reason: 'stop', audio: { data: '', url: 'https://audio.example.test/result.wav' } } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ))
      .mockResolvedValueOnce(new Response(Uint8Array.from(wav).buffer));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段测试语音。',
    );

    expect(result.audio.slice(44)).toEqual(wav.slice(44));
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyFetch.mock.calls[1][0]).toBe('https://audio.example.test/result.wav');
  });

  it('reports an upstream SSE error instead of treating it as an empty stream', async () => {
    mocks.proxyFetch.mockResolvedValue(new Response(
      `data: ${JSON.stringify({ request_id: 'req-error', code: 'DataInspectionFailed', message: 'Input rejected' })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));

    await expect(generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段测试语音。',
    )).rejects.toMatchObject({ code: 'DataInspectionFailed', isRetryable: false, message: expect.stringContaining('req-error') });
  });

  it('rejects a partial SSE audio stream without a completion event', async () => {
    const audio = Buffer.from([0, 0, 1, 0]).toString('base64');
    mocks.proxyFetch.mockResolvedValue(new Response(
      `data: ${JSON.stringify({ request_id: 'req-partial', output: { audio: { data: audio } } })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));

    await expect(generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test' },
      '这是一段测试语音。',
    )).rejects.toMatchObject({ isRetryable: true, qwenUseNonStreamingOnRetry: true, message: expect.stringContaining('req-partial') });
  });

  it('uses a URL response on a caller-selected non-streaming retry', async () => {
    const wav = pcmWav(Uint8Array.from([1, 0, 2, 0]));
    mocks.proxyFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { audio: { url: 'https://audio.example.test/download.wav' } } }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(wav).buffer));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'longanfengyue', apiKey: 'test', providerOptions: { qwenTransport: 'download' } },
      '这是一段测试语音。',
    );

    expect(result.audio.slice(44)).toEqual(wav.slice(44));
    expect(mocks.proxyFetch.mock.calls[0][1].headers).not.toHaveProperty('X-DashScope-SSE');
  });
});
