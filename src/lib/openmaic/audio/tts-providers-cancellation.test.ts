// @vitest-environment node
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSModelConfig } from './types';
const mocks = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock('@openmaic/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
import { generateTTS } from './tts-providers';

afterEach(() => mocks.proxyFetch.mockReset());

const providers: Array<[string, Partial<TTSModelConfig>]> = [
  ['OpenAI', { providerId: 'openai-tts' }],
  ['Azure', { providerId: 'azure-tts' }],
  ['GLM', { providerId: 'glm-tts' }],
  ['MiniMax', { providerId: 'minimax-tts' }],
  ['ElevenLabs', { providerId: 'elevenlabs-tts' }],
  ['Lemonade', { providerId: 'lemonade-tts' }],
  ['Doubao', { providerId: 'doubao-tts', apiKey: 'app:secret' }],
  ['VoxCPM Omni', { providerId: 'voxcpm-tts', providerOptions: { backend: 'vllm-omni' } }],
  ['VoxCPM Python', { providerId: 'voxcpm-tts', providerOptions: { backend: 'python-api' } }],
  ['VoxCPM Nano', { providerId: 'voxcpm-tts', providerOptions: { backend: 'nano-vllm' } }],
  ['custom OpenAI-compatible', { providerId: 'custom-tts-test' }],
];
describe('TTS provider cancellation', () => {
  it.each(providers)('forwards cancellation to %s synthesis without retrying', async (_name, settings) => {
    const controller = new AbortController();
    mocks.proxyFetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      expect(init.signal).toBe(controller.signal);
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const work = generateTTS({ providerId: 'openai-tts', apiKey: 'secret', baseUrl: 'http://localhost', voice: 'voice', ...settings, signal: controller.signal }, 'sample');
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(mocks.proxyFetch).toHaveBeenCalledOnce();
  });

  it('rejects an already cancelled request before any provider call', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(generateTTS({ providerId: 'openai-tts', apiKey: 'secret', voice: 'voice', signal: controller.signal }, 'sample'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('cancels a Qwen audio download without synthesizing the text again', async () => {
    const controller = new AbortController();
    mocks.proxyFetch.mockResolvedValueOnce(Response.json({ output: { audio: { url: 'https://audio.test/result.wav' } } }))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }));
    const work = generateTTS({ providerId: 'qwen-tts', apiKey: 'secret', voice: 'longanfengyue', signal: controller.signal }, 'sample');
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.proxyFetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyFetch.mock.calls[1][0]).toBe('https://audio.test/result.wav');
  });

  it.each(['openai-tts', 'minimax-tts'] as const)('aborts a real stalled HTTP response body for %s', async (providerId) => {
    let responseStarted!: () => void;
    const started = new Promise<void>(resolve => { responseStarted = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': providerId === 'minimax-tts' ? 'application/json' : 'audio/mpeg' });
      response.write(providerId === 'minimax-tts' ? '{"data":{"audio":"' : 'audio-prefix');
      responseStarted();
      // Deliberately leave the body open; only actual fetch cancellation ends it.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
      mocks.proxyFetch.mockImplementation((url: string, init: RequestInit) => fetch(url, init));
      const controller = new AbortController();
      const work = generateTTS({ providerId, apiKey: 'secret', baseUrl: `http://127.0.0.1:${address.port}`, voice: 'voice', signal: controller.signal }, 'sample');
      const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
      await started;
      controller.abort();
      await rejected;
      expect(mocks.proxyFetch).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
