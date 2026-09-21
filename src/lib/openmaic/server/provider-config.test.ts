import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearServerProviderConfigCache,
  getClassroomSceneConcurrency,
  getServerTTSProviders,
  getTtsConcurrencyLimit,
  initializeServerProviderConfig,
  resolveASRModel,
  resolveServerEmbeddingProvider,
  resolveProxy,
} from '@openmaic/lib/server/provider-config';

describe('server generation concurrency configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearServerProviderConfigCache();
  });

  it('makes startup initialization visible to production provider reads', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    await initializeServerProviderConfig();

    expect(() => getServerTTSProviders()).not.toThrow();
  });

  it('defaults the teacher scene pipeline to two workers', () => {
    vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '');
    expect(getClassroomSceneConcurrency()).toBe(2);
  });

  it('clamps the classroom scene override to one through five', () => {
    vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '1');
    expect(getClassroomSceneConcurrency()).toBe(1);

    vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '9');
    expect(getClassroomSceneConcurrency()).toBe(5);
  });

  it('uses provider metadata and supports global/provider-specific TTS overrides', () => {
    vi.stubEnv('TTS_CONCURRENCY', '3');
    expect(getTtsConcurrencyLimit('glm-tts')).toBe(3);

    vi.stubEnv('TTS_GLM_TTS_CONCURRENCY', '4');
    expect(getTtsConcurrencyLimit('glm-tts')).toBe(4);

    vi.stubEnv('TTS_GLM_TTS_CONCURRENCY', '20');
    expect(getTtsConcurrencyLimit('glm-tts')).toBe(4);
  });

  it('falls back to the provider default for invalid TTS overrides', () => {
    vi.stubEnv('TTS_GLM_TTS_CONCURRENCY', 'not-a-number');
    expect(getTtsConcurrencyLimit('glm-tts')).toBe(2);
  });

  it('keeps the deployment proxy fallback scoped to DeepSeek', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('OPENPBL_DEEPSEEK_PROXY', 'http://127.0.0.1:9999');
    await initializeServerProviderConfig();

    expect(resolveProxy('deepseek')).toBe('http://127.0.0.1:9999');
    expect(resolveProxy('qwen')).toBeUndefined();
  });

  it('uses the teacher-managed ASR model instead of a stale client model', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('ASR_QWEN_API_KEY', 'test-key');
    vi.stubEnv(
      'ASR_QWEN_MODELS',
      'qwen-audio-3.0-asr-flash,qwen3-asr-flash',
    );
    await initializeServerProviderConfig();

    expect(resolveASRModel('qwen-asr', 'stale-browser-model')).toBe(
      'qwen-audio-3.0-asr-flash',
    );
    expect(resolveASRModel('unmanaged-asr', 'client-model')).toBe('client-model');
  });

  it('supports a keyless local Ollama embedding provider', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('EMBEDDING_OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1');
    vi.stubEnv('EMBEDDING_OLLAMA_MODELS', 'qwen3-embedding:0.6b');
    await initializeServerProviderConfig();

    expect(resolveServerEmbeddingProvider()).toMatchObject({
      providerId: 'ollama-embedding',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-embedding:0.6b',
      dimensions: 1024,
    });
  });
});
