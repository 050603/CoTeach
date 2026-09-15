import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

describe('Qwen TTS WAV handling', () => {
  it('does not wrap an upstream WAV header as audible PCM', async () => {
    const pcm = Uint8Array.from([0xfe, 0xff, 0xfd, 0xff, 0x02, 0x00]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(qwenSseResponse(pcmWav(pcm))));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'Cherry', apiKey: 'test' },
      '这是一段测试语音。',
    );

    expect(result.format).toBe('wav');
    expect(result.audio.byteLength).toBe(44 + pcm.byteLength);
    expect(result.audio.slice(44)).toEqual(pcm);
    expect(new DataView(result.audio.buffer).getUint32(40, true)).toBe(pcm.byteLength);
  });

  it('still wraps genuine raw PCM exactly once', async () => {
    const pcm = Uint8Array.from([0, 0, 1, 0]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(qwenSseResponse(pcm)));

    const result = await generateTTS(
      { providerId: 'qwen-tts', voice: 'Cherry', apiKey: 'test' },
      '这是一段测试语音。',
    );

    expect(result.audio.byteLength).toBe(44 + pcm.byteLength);
    expect(result.audio.slice(44)).toEqual(pcm);
  });
});
