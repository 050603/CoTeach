import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudio } from './asr-providers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Qwen ASR', () => {
  it('uses the DashScope endpoint and payload for the recommended Qwen Audio model', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ text: '这是学生的课堂发言。', request_id: 'request-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const wav = new Blob(['RIFFxxxxWAVEaudio'], { type: 'audio/wav' });

    await expect(
      transcribeAudio(
        {
          providerId: 'qwen-asr',
          modelId: 'qwen-audio-3.0-asr-flash',
          apiKey: 'test-key',
          baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          language: 'zh-CN',
        },
        wav,
      ),
    ).resolves.toEqual({ text: '这是学生的课堂发言。' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(init?.headers).toMatchObject({ 'X-DashScope-SSE': 'disable' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'qwen-audio-3.0-asr-flash',
      input: {
        messages: [
          {
            content: [
              {
                type: 'input_audio',
                input_audio: { data: expect.stringMatching(/^data:audio\/wav;base64,/) },
              },
            ],
          },
        ],
      },
      parameters: { format: 'wav', language_hints: ['zh'] },
    });
  });

  it('keeps Qwen3 ASR compatible while correcting the configured base URL', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        output: { choices: [{ message: { content: [{ text: '兼容旧模型' }] } }] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeAudio(
        {
          providerId: 'qwen-asr',
          modelId: 'qwen3-asr-flash',
          apiKey: 'test-key',
          baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/',
          language: 'auto',
        },
        Buffer.from('RIFFxxxxWAVEaudio'),
      ),
    ).resolves.toEqual({ text: '兼容旧模型' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'qwen3-asr-flash',
      input: { messages: [{ content: [{ audio: expect.stringMatching(/^data:audio\/wav;base64,/) }] }] },
      parameters: { asr_options: { enable_itn: true } },
    });
  });

  it('includes status and upstream details in actionable errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"code":"InvalidParameter","message":"bad model"}', { status: 400 })),
    );

    await expect(
      transcribeAudio(
        {
          providerId: 'qwen-asr',
          modelId: 'qwen-audio-3.0-asr-flash',
          apiKey: 'test-key',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          language: 'zh',
        },
        new Blob(['audio'], { type: 'audio/webm' }),
      ),
    ).rejects.toThrow('Qwen ASR API error (400)');
  });
});
