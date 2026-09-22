import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPEECH_ALIGNMENT_MODEL,
  SPEECH_ALIGNMENT_MODEL_REVISION,
  SPEECH_ALIGNMENT_VERSION,
  SpeechAlignmentError,
  alignSpeechFile,
  createSpeechAlignmentInputHash,
  normalizeSpeechAlignmentLanguage,
  resolveSpeechAlignmentCacheDir,
} from './speech-alignment';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'speech-alignment-'));
  directories.push(directory);
  const audioPath = path.join(directory, 'narration.wav');
  await writeFile(audioPath, Buffer.from('audio one'));
  return { directory, audioPath, cacheDir: path.join(directory, 'cache') };
}

function serviceResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: SPEECH_ALIGNMENT_MODEL,
    revision: SPEECH_ALIGNMENT_MODEL_REVISION,
    version: SPEECH_ALIGNMENT_VERSION,
    device: 'cuda:0',
    durationMs: 1_200,
    spans: [
      { text: '人', startChar: 0, endChar: 1, startMs: 80, endMs: 220 },
      { text: '工', startChar: 1, endChar: 2, startMs: 230, endMs: 380 },
      { text: 'AI', startChar: 3, endChar: 5, startMs: 450, endMs: 800 },
    ],
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('alignSpeechFile', () => {
  it('calls the loopback service and returns content fingerprints with UTF-16 spans', async () => {
    const { audioPath, cacheDir } = await fixture();
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:3004/align');
      expect(JSON.parse(String(init?.body))).toEqual({
        audioPath,
        text: '人工 AI',
        language: 'Chinese',
      });
      return new Response(JSON.stringify(serviceResponse()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await alignSpeechFile({ audioPath, text: '人工 AI', language: 'zh-CN', cacheDir, fetchImpl });

    expect(result).toMatchObject({
      version: SPEECH_ALIGNMENT_VERSION,
      language: 'Chinese',
      durationMs: 1_200,
      spans: serviceResponse().spans,
    });
    expect(result.audioHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reuses a disk cache and invalidates it when audio, text, or language changes', async () => {
    const { audioPath, cacheDir } = await fixture();
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      return new Response(JSON.stringify(serviceResponse({
        spans: [{ text, startChar: 0, endChar: text.length, startMs: 80, endMs: 800 }],
      })));
    }) as typeof fetch;
    const base = { audioPath, text: '人工 AI', cacheDir, fetchImpl };

    const first = await alignSpeechFile(base);
    expect(await alignSpeechFile(base)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await alignSpeechFile({ ...base, text: '人工智能 AI' });
    await alignSpeechFile({ ...base, language: 'English' });
    await writeFile(audioPath, Buffer.from('audio two'));
    await alignSpeechFile(base);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent requests for the same immutable input', async () => {
    const { audioPath } = await fixture();
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })) as typeof fetch;
    const input = { audioPath, text: '人工 AI', cacheDir: false as const, fetchImpl };

    const first = alignSpeechFile(input);
    const second = alignSpeechFile(input);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    resolveResponse(new Response(JSON.stringify(serviceResponse())));
    expect(await first).toEqual(await second);
  });

  it('rejects malformed spans instead of caching inaccurate timing', async () => {
    const { audioPath, cacheDir } = await fixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(serviceResponse({
      spans: [{ text: '人工', startChar: 0, endChar: 2, startMs: 900, endMs: 2_201 }],
    })))) as typeof fetch;

    await expect(alignSpeechFile({ audioPath, text: '人工 AI', cacheDir, fetchImpl }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
    expect(await readFile(path.join(cacheDir, 'missing'), 'utf8').catch(() => null)).toBeNull();
  });

  it('rejects spans that disagree with the source text or overlap in time', async () => {
    const { audioPath } = await fixture();
    const input = { audioPath, text: '人工 AI', cacheDir: false as const };

    await expect(alignSpeechFile({
      ...input,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(serviceResponse({
        spans: [{ text: '智', startChar: 0, endChar: 1, startMs: 80, endMs: 220 }],
      })))) as typeof fetch,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    await expect(alignSpeechFile({
      ...input,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(serviceResponse({
        spans: [
          { text: '人', startChar: 0, endChar: 1, startMs: 80, endMs: 300 },
          { text: '工', startChar: 1, endChar: 2, startMs: 250, endMs: 380 },
        ],
      })))) as typeof fetch,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('classifies busy, rejected, and unreachable service errors', async () => {
    const { audioPath } = await fixture();
    const input = { audioPath, text: '人工 AI', cacheDir: false as const };
    await expect(alignSpeechFile({
      ...input,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'SERVICE_BUSY' }), { status: 503 })) as typeof fetch,
    })).rejects.toMatchObject({ code: 'SERVICE_BUSY', retryable: true });
    await expect(alignSpeechFile({
      ...input,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'INVALID_TIMESTAMPS' }), { status: 422 })) as typeof fetch,
    })).rejects.toMatchObject({ code: 'ALIGNMENT_REJECTED', retryable: false });
    await expect(alignSpeechFile({
      ...input,
      fetchImpl: vi.fn(async () => { throw new TypeError('connection refused'); }) as typeof fetch,
    })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  });

  it('rejects non-loopback service origins before making a request', async () => {
    const { audioPath } = await fixture();
    const fetchImpl = vi.fn();
    await expect(alignSpeechFile({
      audioPath,
      text: '讲稿',
      serviceUrl: 'https://alignment.example',
      cacheDir: false,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('speech alignment fingerprints and configuration', () => {
  it('normalizes supported language aliases', () => {
    expect(normalizeSpeechAlignmentLanguage()).toBe('Chinese');
    expect(normalizeSpeechAlignmentLanguage('en')).toBe('English');
    expect(() => normalizeSpeechAlignmentLanguage('Thai')).toThrow(SpeechAlignmentError);
  });

  it('fingerprints every cache identity field', () => {
    const base = { audioHash: 'audio', textHash: 'text', language: 'Chinese' };
    const hash = createSpeechAlignmentInputHash(base);
    expect(createSpeechAlignmentInputHash({ ...base, audioHash: 'changed' })).not.toBe(hash);
    expect(createSpeechAlignmentInputHash({ ...base, textHash: 'changed' })).not.toBe(hash);
    expect(createSpeechAlignmentInputHash({ ...base, language: 'English' })).not.toBe(hash);
    expect(createSpeechAlignmentInputHash({ ...base, version: 'next' })).not.toBe(hash);
  });

  it('resolves a configurable durable cache directory', () => {
    expect(resolveSpeechAlignmentCacheDir({}, '/app')).toBe('/app/.openpbl-data/speech-alignment-cache');
    expect(resolveSpeechAlignmentCacheDir({ OPENPBL_SPEECH_ALIGNMENT_CACHE_DIR: './cache' }, '/app'))
      .toBe(path.resolve('./cache'));
  });
});
