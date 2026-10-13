import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TTSModelConfig } from '../audio/types';
import type { TTSGenerationResult } from '../audio/tts-providers';
import { recordAiCacheEvent } from '@/lib/observability/classroom-ai';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const pending = new Map<string, Promise<TTSGenerationResult>>();
let sweeping: Promise<void> | undefined;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
export function ttsResultCacheKey(config: TTSModelConfig, text: string): string {
  // Include credential identity without ever writing it or the input text to disk.
  return createHash('sha256').update(JSON.stringify(canonical({ version: 1, config, text }))).digest('hex');
}

/** Persistent result reuse for the single application process; failures never become cache entries. */
export async function cachedTtsResult(config: TTSModelConfig, text: string,
  generate: () => Promise<TTSGenerationResult>): Promise<TTSGenerationResult> {
  const directory = process.env.TTS_CACHE_DIR || (process.env.CLASSROOM_DATA_DIR
    ? path.join(path.dirname(process.env.CLASSROOM_DATA_DIR), 'tts-cache')
    : path.resolve('.openpbl-data/tts-cache'));
  const key = ttsResultCacheKey(config, text);
  const filename = path.join(directory, `${key}.json`);
  const inFlight = pending.get(filename);
  if (inFlight) { recordAiCacheEvent('tts', 'joined'); return inFlight; }
  const operation = (async () => {
    try {
      const info = await stat(filename);
      if (Date.now() - info.mtimeMs < TTL_MS && info.size <= MAX_ENTRY_BYTES) {
        const stored = JSON.parse(await readFile(filename, 'utf8')) as { base64?: unknown; format?: unknown };
        if (typeof stored.base64 === 'string' && stored.base64.length && typeof stored.format === 'string') {
          const audio = Buffer.from(stored.base64, 'base64');
          if (audio.length && audio.toString('base64') === stored.base64) {
            recordAiCacheEvent('tts', 'hit'); return { audio, format: stored.format };
          }
        }
      }
    } catch { /* An unavailable cache cannot disable speech. */ }
    recordAiCacheEvent('tts', 'miss');
    const result = await generate();
    if (!result.audio.length || !result.format) throw new Error('语音服务返回空音频');
    const serialized = JSON.stringify({ base64: Buffer.from(result.audio).toString('base64'), format: result.format });
    if (Buffer.byteLength(serialized) <= MAX_ENTRY_BYTES) {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
        await rename(temporary, filename);
      } catch { await unlink(temporary).catch(() => undefined); }
      // Sweep after writes, keeping one bounded disk cache rather than unbounded audio growth.
      if (!sweeping) sweeping = trimCache(directory).catch(() => undefined).finally(() => { sweeping = undefined; });
    }
    return result;
  })();
  pending.set(filename, operation);
  try { return await operation; } finally { pending.delete(filename); }
}

async function trimCache(directory: string): Promise<void> {
  const entries = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const filename = path.join(directory, name);
    const info = await stat(filename).catch(() => undefined);
    if (info) entries.push({ filename, size: info.size, mtime: info.mtimeMs });
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (Date.now() - entry.mtime < TTL_MS && bytes <= MAX_CACHE_BYTES) break;
    await unlink(entry.filename).catch(() => undefined);
    bytes -= entry.size;
  }
}
