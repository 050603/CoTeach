import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedTtsResult, ttsResultCacheKey } from './tts-result-cache';
import type { TTSModelConfig } from '../audio/types';
const config: TTSModelConfig = { providerId: 'qwen-tts', modelId: 'model', voice: 'voice', speed: 1, apiKey: 'secret' };
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'coteach-tts-')); vi.stubEnv('TTS_CACHE_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('shared speech results', () => {
  it('coalesces thirty listeners and reads the persisted audio on the next request', async () => {
    const generate = vi.fn(async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'wav' }));
    const results = await Promise.all(Array.from({ length: 30 }, () => cachedTtsResult(config, '同一道题', generate)));
    expect(results.every(item => item.audio.length === 3)).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await cachedTtsResult(config, '同一道题', generate)).audio).toEqual(Buffer.from([1, 2, 3]));
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });
  it('never caches provider failures or empty audio', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('provider')).mockResolvedValueOnce({ audio: new Uint8Array(), format: 'wav' })
      .mockResolvedValue({ audio: new Uint8Array([3]), format: 'wav' });
    await expect(cachedTtsResult(config, '内容', generate)).rejects.toThrow('provider');
    await expect(cachedTtsResult(config, '内容', generate)).rejects.toThrow('空音频');
    expect((await cachedTtsResult(config, '内容', generate)).audio.length).toBe(1);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it('invalidates by exact text and all speech settings without depending on option key order', () => {
    const base = ttsResultCacheKey(config, 'text');
    for (const change of [{ voice: 'other' }, { modelId: 'other' }, { speed: 1.1 }, { language: 'en' }, { apiKey: 'other' }]) {
      expect(ttsResultCacheKey({ ...config, ...change }, 'text')).not.toBe(base);
    }
    expect(ttsResultCacheKey(config, 'new text')).not.toBe(base);
    expect(ttsResultCacheKey({ ...config, providerOptions: { a: 1, b: 2 } }, 'text'))
      .toBe(ttsResultCacheKey({ ...config, providerOptions: { b: 2, a: 1 } }, 'text'));
  });
});
