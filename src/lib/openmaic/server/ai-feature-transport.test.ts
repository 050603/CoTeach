// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@openmaic/lib/server/proxy-fetch', () => ({ proxyFetch: transport }));
vi.mock('@/lib/openmaic/server/provider-config', () => ({
  resolveServerEmbeddingProvider: () => ({
    providerId: 'qwen-embedding', baseUrl: 'https://embedding.test/v1', model: 'embedding-model', apiKey: 'test',
  }),
}));

import { generateTTS } from '../audio/tts-providers';
import { transcribeAudio } from '../audio/asr-providers';
import { fetchMediaRequest } from '../media/media-request';
import { testImageConnectivity } from '../media/image-providers';
import { embedTextbookTexts } from '@/lib/textbook/embedding';

beforeEach(() => {
  transport.mockReset();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('AI request bypassed the managed transport'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('AI feature managed transport', () => {
  it('synthesizes speech through the shared outbound transport on its first request', async () => {
    transport.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await generateTTS({ providerId: 'openai-tts', apiKey: 'test', voice: 'alloy' }, 'Hello');
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith('https://api.openai.com/v1/audio/speech', expect.objectContaining({ method: 'POST' }));
  });

  it('routes Qwen transcription through the shared transport', async () => {
    transport.mockResolvedValue(Response.json({ text: 'Hello' }));
    await expect(transcribeAudio({ providerId: 'qwen-asr', apiKey: 'test' }, Buffer.from('RIFFxxxxWAVEaudio')))
      .resolves.toMatchObject({ text: 'Hello' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('injects the shared transport into the Whisper SDK', async () => {
    transport.mockResolvedValue(Response.json({ text: 'Hello' }));
    await expect(transcribeAudio({ providerId: 'openai-whisper', apiKey: 'test' }, Buffer.from('RIFFxxxxWAVEaudio')))
      .resolves.toMatchObject({ text: 'Hello' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('preserves caller cancellation on media requests through the shared transport', async () => {
    const controller = new AbortController();
    transport.mockResolvedValue(Response.json({ id: 'one' }));
    await fetchMediaRequest('https://media.test/jobs', { method: 'POST', signal: controller.signal });
    expect(transport).toHaveBeenCalledOnce();
    const signal = transport.mock.calls[0][1].signal as AbortSignal;
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('uses the same transport for provider connectivity checks', async () => {
    transport.mockResolvedValue(Response.json({ id: 'gpt-image-2' }));
    await testImageConnectivity({ providerId: 'openai-image', apiKey: 'test' });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('embeds textbook content through the shared transport', async () => {
    transport.mockResolvedValue(Response.json({ data: [{ index: 0, embedding: Array(1024).fill(0.5) }] }));
    const result = await embedTextbookTexts(['A textbook paragraph']);
    expect(result.vectors[0]).toHaveLength(1024);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith('https://embedding.test/v1/embeddings', expect.objectContaining({ method: 'POST' }));
  });
});
