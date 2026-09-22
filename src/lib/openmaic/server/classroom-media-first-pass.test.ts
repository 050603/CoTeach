import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { buildTtsTimingPlan } from '@openmaic/lib/audio/tts-timing';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  generateTTS: vi.fn(),
  download: vi.fn(),
  alignSpeech: vi.fn(),
}));
vi.mock('@openmaic/lib/media/video-providers', async (original) => ({
  ...await original<typeof import('@openmaic/lib/media/video-providers')>(), generateVideo: mocks.generateVideo,
}));
vi.mock('@openmaic/lib/audio/tts-providers', () => ({ generateTTS: mocks.generateTTS }));
vi.mock('@openmaic/lib/media/image-providers', () => ({ generateImage: mocks.generateImage, IMAGE_PROVIDERS: { 'openai-image': { models: [{ id: 'image-model' }] } } }));
vi.mock('@openmaic/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.download }));
vi.mock('@openmaic/lib/server/speech-alignment', async (original) => ({
  ...await original<typeof import('@openmaic/lib/server/speech-alignment')>(),
  alignSpeechFile: mocks.alignSpeech,
}));
vi.mock('@openmaic/lib/server/provider-config', () => ({
  getServerImageProviders: () => ({ 'openai-image': {} }), getServerVideoProviders: () => ({ veo: {}, seedance: {} }),
  resolveVideoApiKey: () => 'test-key', resolveVideoBaseUrl: () => undefined,
  getServerTTSProviders: () => ({ 'qwen-tts': {}, 'openai-tts': {} }),
  resolveImageApiKey: () => 'test-key', resolveImageBaseUrl: () => undefined,
  resolveTTSApiKey: () => 'test-key', resolveTTSBaseUrl: () => undefined,
  resolveTTSModel: () => 'configured-model', resolveTTSVoice: () => 'configured-voice',
  resolveTTSTimingCalibration: () => undefined, getTtsConcurrencyLimit: () => 1,
}));
vi.mock('@openmaic/lib/generation/generation-retry', async (original) => {
  const real = await original<typeof import('@openmaic/lib/generation/generation-retry')>();
  return { ...real, withGenerationRetry: <T>(operation: (attempt: number) => Promise<T>, options: import('@openmaic/lib/generation/generation-retry').GenerationRetryOptions<T>) => real.withGenerationRetry(operation, { ...options, sleep: async () => undefined }) };
});
import { generateMediaForClassroom, generateTTSForClassroom } from './classroom-media-generation';
import { prepareVideoTimingRequests } from './video-timing-plan';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
  vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
  vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  mocks.alignSpeech.mockImplementation(async ({ text, language }) => ({
    version: 'test-align-v1',
    textHash: 'text-hash',
    audioHash: 'audio-hash',
    inputHash: 'input-hash',
    language: language ?? 'English',
    durationMs: 1_000,
    spans: [{ text, startChar: 0, endChar: text.length, startMs: 0, endMs: 1_000 }],
  }));
});

const outlines = [{ mediaGenerations: [{ type: 'image', elementId: 'image-1', prompt: 'Observe water', aspectRatio: '16:9' }] }] as unknown as SceneOutline[];
function scenes(): Scene[] {
  return [{ id: 's1', order: 0, type: 'slide', actions: [{ id: 'a1', type: 'speech', text: 'Short narration.' }], timingPlan: buildTtsTimingPlan({ targetDurationSec: 10, providerId: 'qwen-tts', modelId: 'locked-model', voiceId: 'locked-voice', language: 'en-US' }) }] as unknown as Scene[];
}

function chineseCourseWithEnglishNarration(): Scene[] {
  return [{
    id: 's1',
    title: '能量流动',
    order: 0,
    type: 'slide',
    actions: [{
      id: 'a1',
      type: 'speech',
      text: 'Today we will explain how energy moves through every level of this ecosystem.',
    }],
    timingPlan: buildTtsTimingPlan({
      targetDurationSec: 10,
      providerId: 'qwen-tts',
      modelId: 'locked-model',
      voiceId: 'locked-voice',
      language: 'zh-CN',
    }),
  }] as unknown as Scene[];
}

describe('first-pass media request boundaries', () => {
  it('synthesizes the exact duration and provider persisted before narration budgeting', async () => {
    const prepared = prepareVideoTimingRequests({
      id: 'video-page', mediaGenerations: [{ type: 'video', elementId: 'v1', prompt: '实验过程', duration: 10 }],
    } as SceneOutline, 'seedance');
    mocks.generateVideo.mockResolvedValue({ url: 'https://cdn.example.test/video.mp4', duration: 10 });
    mocks.download.mockResolvedValue(new Response('video bytes'));
    const result = await generateMediaForClassroom([prepared.outline], 'test', '', { image: false, video: true });
    expect(result.failures).toHaveLength(0);
    expect(mocks.generateVideo).toHaveBeenCalledOnce();
    expect(mocks.generateVideo.mock.calls[0][0]).toMatchObject({ providerId: 'seedance' });
    expect(mocks.generateVideo.mock.calls[0][1]).toMatchObject({ duration: prepared.videoSec });
  });

  it('fails a persisted duration incompatible with the selected provider without synthesizing a replacement', async () => {
    const result = await generateMediaForClassroom([{ mediaGenerations: [{
      type: 'video', elementId: 'v1', prompt: '实验过程', duration: 10, videoProviderId: 'veo',
    }] }] as SceneOutline[], 'test', '', { image: false, video: true });
    expect(result.failures[0].error).toContain('已锁定的视频时长');
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });

  it('does not redraw an image when the URL fails, including a resumed job', async () => {
    const result = { url: 'https://cdn.example.test/image.png' };
    mocks.generateImage.mockResolvedValue(result);
    mocks.download.mockResolvedValue(new Response('', { status: 403 }));
    expect((await generateMediaForClassroom(outlines, 'test', '', { image: true, video: false })).failures).toHaveLength(1);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(result));
    expect((await generateMediaForClassroom(outlines, 'test', '', { image: true, video: false })).failures).toHaveLength(1);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
  });

  it('does not add orchestration retries to the provider HTTP boundary or invalid files', async () => {
    mocks.generateImage.mockRejectedValue(Object.assign(new Error('unavailable'), { statusCode: 503 }));
    await generateMediaForClassroom(outlines, 'test', '', { image: true, video: false });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    mocks.generateImage.mockReset().mockResolvedValue({ base64: Buffer.from('not an image').toString('base64') });
    const result = await generateMediaForClassroom(outlines, 'test', '', { image: true, video: false });
    expect(result.failures).toHaveLength(1);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
  });

  it('downloads the same URL with bounded retries without another generation call', async () => {
    const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#fff' } }).png().toBuffer();
    mocks.generateImage.mockResolvedValue({ url: 'https://cdn.example.test/image.png' });
    mocks.download.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response(new Uint8Array(png)));
    const result = await generateMediaForClassroom(outlines, 'test', '', { image: true, video: false });
    expect(result.failures).toHaveLength(0);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it('uses the persisted page voice and never falls back on non-transient TTS failure', async () => {
    mocks.generateTTS.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    await expect(generateTTSForClassroom(scenes(), 'test', '', undefined, { providerId: 'openai-tts', voiceId: 'new-voice' }))
      .rejects.toMatchObject({ name: 'ClassroomTtsIncompleteError', isRetryable: false });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(1);
    expect(mocks.generateTTS.mock.calls[0][0]).toMatchObject({ providerId: 'qwen-tts', modelId: 'locked-model', voice: 'locked-voice', language: 'en-US', speed: 1 });
  });

  it('clears the invalidation marker after replacement audio is ready', async () => {
    const classroomScenes = scenes();
    const speech = classroomScenes[0].actions?.[0];
    if (speech?.type === 'speech') speech.audioInvalidated = true;
    mocks.generateTTS.mockResolvedValue({ audio: Buffer.from('RIFF replacement audio'), format: 'wav' });

    await generateTTSForClassroom(classroomScenes, 'test', '');

    expect(classroomScenes[0].actions?.[0]).toMatchObject({
      audioId: 'tts_s0_a1',
      audioUrl: '/api/openmaic/classroom-media/test/audio/tts_s0_a1.wav',
      speechAlignment: {
        version: 'test-align-v1',
        status: 'aligned',
        textHash: 'text-hash',
        audioHash: 'audio-hash',
      },
    });
    expect(classroomScenes[0].actions?.[0]).not.toHaveProperty('audioInvalidated');
  });

  it('stops wrong-language Chinese-course narration before sending any TTS request', async () => {
    await expect(generateTTSForClassroom(chineseCourseWithEnglishNarration(), 'test', ''))
      .rejects.toMatchObject({ name: 'ClassroomNarrationLanguageError', isRetryable: false });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it('retries transient TTS failures at most twice with the same configuration', async () => {
    mocks.generateTTS.mockRejectedValue(Object.assign(new Error('unavailable'), { statusCode: 503 }));
    await expect(generateTTSForClassroom(scenes(), 'test', '')).rejects.toThrow();
    expect(mocks.generateTTS).toHaveBeenCalledTimes(3);
    for (const [config] of mocks.generateTTS.mock.calls) expect(config).toMatchObject({ providerId: 'qwen-tts', modelId: 'locked-model', voice: 'locked-voice' });
  });
});
