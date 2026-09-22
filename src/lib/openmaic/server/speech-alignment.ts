import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SPEECH_ALIGNMENT_MODEL = 'Qwen/Qwen3-ForcedAligner-0.6B';
export const SPEECH_ALIGNMENT_MODEL_REVISION = 'c7cbfc2048c462b0d63a45797104fc9db3ad62b7';
export const SPEECH_ALIGNMENT_VERSION = `qwen3-forced-aligner-0.6b:${SPEECH_ALIGNMENT_MODEL_REVISION}:fp32:v1`;
export const DEFAULT_SPEECH_ALIGNMENT_URL = 'http://127.0.0.1:3004';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CACHE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_LANGUAGES = new Set([
  'Chinese', 'Cantonese', 'English', 'German', 'Spanish', 'French',
  'Italian', 'Portuguese', 'Russian', 'Korean', 'Japanese',
]);
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  zh: 'Chinese',
  'zh-cn': 'Chinese',
  'zh-hans': 'Chinese',
  chinese: 'Chinese',
  yue: 'Cantonese',
  cantonese: 'Cantonese',
  en: 'English',
  english: 'English',
  de: 'German',
  german: 'German',
  es: 'Spanish',
  spanish: 'Spanish',
  fr: 'French',
  french: 'French',
  it: 'Italian',
  italian: 'Italian',
  pt: 'Portuguese',
  portuguese: 'Portuguese',
  ru: 'Russian',
  russian: 'Russian',
  ko: 'Korean',
  korean: 'Korean',
  ja: 'Japanese',
  japanese: 'Japanese',
};

export type SpeechAlignmentSpan = {
  text: string;
  /** Inclusive UTF-16 offset in the original narration text. */
  startChar: number;
  /** Exclusive UTF-16 offset in the original narration text. */
  endChar: number;
  startMs: number;
  endMs: number;
};

export type SpeechAlignmentResult = {
  version: string;
  textHash: string;
  audioHash: string;
  inputHash: string;
  language: string;
  durationMs: number;
  spans: SpeechAlignmentSpan[];
};

export type AlignSpeechFileInput = {
  audioPath: string;
  text: string;
  language?: string;
  signal?: AbortSignal;
  cacheDir?: string | false;
  serviceUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type SpeechAlignmentErrorCode =
  | 'INVALID_INPUT'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_BUSY'
  | 'ALIGNMENT_REJECTED'
  | 'INVALID_RESPONSE';

export class SpeechAlignmentError extends Error {
  constructor(
    public readonly code: SpeechAlignmentErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SpeechAlignmentError';
  }
}

const inFlight = new Map<string, Promise<SpeechAlignmentResult>>();

export function normalizeSpeechAlignmentLanguage(language = 'Chinese'): string {
  const trimmed = language.trim();
  if (SUPPORTED_LANGUAGES.has(trimmed)) return trimmed;
  const normalized = LANGUAGE_ALIASES[trimmed.toLowerCase()];
  if (!normalized) {
    throw new SpeechAlignmentError('INVALID_INPUT', `Unsupported alignment language: ${language}`, false);
  }
  return normalized;
}

export function resolveSpeechAlignmentCacheDir(
  environment: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configured = environment.OPENPBL_SPEECH_ALIGNMENT_CACHE_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(cwd, '.openpbl-data', 'speech-alignment-cache');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } catch (error) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Unable to read narration audio.', false, { cause: error });
  }
  return hash.digest('hex');
}

export function createSpeechAlignmentInputHash(input: {
  textHash: string;
  audioHash: string;
  language: string;
  version?: string;
}): string {
  return sha256Text(JSON.stringify({
    version: input.version ?? SPEECH_ALIGNMENT_VERSION,
    audioHash: input.audioHash,
    textHash: input.textHash,
    language: input.language,
  }));
}

function validatedServiceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Invalid speech alignment service URL.', false, { cause: error });
  }
  if (url.protocol !== 'http:' || url.username || url.password
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Speech alignment service must be a loopback HTTP origin.', false);
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateResult(
  value: unknown,
  expected: { text: string; textHash: string; audioHash: string; inputHash: string; language: string },
): SpeechAlignmentResult {
  if (!isRecord(value)
      || value.model !== SPEECH_ALIGNMENT_MODEL
      || value.revision !== SPEECH_ALIGNMENT_MODEL_REVISION
      || value.version !== SPEECH_ALIGNMENT_VERSION
      || typeof value.device !== 'string'
      || !isNonNegativeInteger(value.durationMs)
      || value.durationMs <= 0
      || !Array.isArray(value.spans)
      || value.spans.length === 0
      || value.spans.length > expected.text.length) {
    throw new SpeechAlignmentError('INVALID_RESPONSE', 'Speech alignment service returned an invalid envelope.', true);
  }

  const durationMs = value.durationMs;
  let previousChar = 0;
  let previousEndMs = 0;
  const spans = value.spans.map((candidate): SpeechAlignmentSpan => {
    if (!isRecord(candidate)
        || typeof candidate.text !== 'string' || !candidate.text
        || !isNonNegativeInteger(candidate.startChar)
        || !isNonNegativeInteger(candidate.endChar)
        || candidate.startChar < previousChar
        || candidate.endChar <= candidate.startChar
        || candidate.endChar > expected.text.length
        || candidate.text !== expected.text.slice(candidate.startChar, candidate.endChar)
        || !isNonNegativeInteger(candidate.startMs)
        || !isNonNegativeInteger(candidate.endMs)
        || candidate.startMs < previousEndMs
        || candidate.endMs < candidate.startMs
        || candidate.endMs > durationMs + 1_000) {
      throw new SpeechAlignmentError('INVALID_RESPONSE', 'Speech alignment service returned invalid token spans.', true);
    }
    previousChar = candidate.endChar;
    previousEndMs = candidate.endMs;
    return {
      text: candidate.text,
      startChar: candidate.startChar,
      endChar: candidate.endChar,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
    };
  });

  return {
    version: SPEECH_ALIGNMENT_VERSION,
    textHash: expected.textHash,
    audioHash: expected.audioHash,
    inputHash: expected.inputHash,
    language: expected.language,
    durationMs,
    spans,
  };
}

function validateCachedResult(
  value: unknown,
  expected: { text: string; textHash: string; audioHash: string; inputHash: string; language: string },
): SpeechAlignmentResult | null {
  if (!isRecord(value)
      || value.version !== SPEECH_ALIGNMENT_VERSION
      || value.textHash !== expected.textHash
      || value.audioHash !== expected.audioHash
      || value.inputHash !== expected.inputHash
      || value.language !== expected.language
      || !isNonNegativeInteger(value.durationMs) || value.durationMs <= 0
      || !Array.isArray(value.spans)) return null;
  const spans: SpeechAlignmentSpan[] = [];
  let previousChar = 0;
  let previousEndMs = 0;
  for (const candidate of value.spans) {
    if (!isRecord(candidate)
        || typeof candidate.text !== 'string' || !candidate.text
        || !isNonNegativeInteger(candidate.startChar)
        || !isNonNegativeInteger(candidate.endChar)
        || candidate.startChar < previousChar || candidate.endChar <= candidate.startChar
        || candidate.endChar > expected.text.length
        || candidate.text !== expected.text.slice(candidate.startChar, candidate.endChar)
        || !isNonNegativeInteger(candidate.startMs) || !isNonNegativeInteger(candidate.endMs)
        || candidate.startMs < previousEndMs || candidate.endMs < candidate.startMs
        || candidate.endMs > value.durationMs + 1_000) return null;
    previousChar = candidate.endChar;
    previousEndMs = candidate.endMs;
    spans.push(candidate as SpeechAlignmentSpan);
  }
  return spans.length ? value as SpeechAlignmentResult : null;
}

async function readCache(
  cachePath: string,
  expected: { text: string; textHash: string; audioHash: string; inputHash: string; language: string },
): Promise<SpeechAlignmentResult | null> {
  const info = await stat(cachePath).catch(() => null);
  if (!info?.isFile() || info.size <= 0 || info.size > MAX_CACHE_BYTES) return null;
  try {
    return validateCachedResult(JSON.parse(await readFile(cachePath, 'utf8')) as unknown, expected);
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, result: SpeechAlignmentResult): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, cachePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function requestAlignment(
  input: AlignSpeechFileInput,
  fingerprints: { textHash: string; audioHash: string; inputHash: string; language: string },
): Promise<SpeechAlignmentResult> {
  const serviceUrl = validatedServiceUrl(
    input.serviceUrl ?? process.env.OPENPBL_SPEECH_ALIGNMENT_URL ?? DEFAULT_SPEECH_ALIGNMENT_URL,
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Invalid speech alignment timeout.', false);
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(new URL('/align', serviceUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioPath: path.resolve(input.audioPath),
        text: input.text,
        language: fingerprints.language,
      }),
      signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    throw new SpeechAlignmentError(
      'SERVICE_UNAVAILABLE',
      'Speech alignment service is unavailable.',
      true,
      { cause: error },
    );
  }

  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const serviceCode = isRecord(body) && typeof body.error === 'string' ? body.error : '';
    if (response.status === 503 || serviceCode === 'SERVICE_BUSY') {
      throw new SpeechAlignmentError('SERVICE_BUSY', 'Speech alignment service is busy.', true);
    }
    throw new SpeechAlignmentError(
      'ALIGNMENT_REJECTED',
      `Speech alignment failed${serviceCode ? `: ${serviceCode}` : '.'}`,
      response.status >= 500,
    );
  }
  return validateResult(body, { text: input.text, ...fingerprints });
}

/**
 * Align one immutable narration audio file with its exact script.
 * Results are cached by audio bytes, script, language, and engine version.
 */
export async function alignSpeechFile(input: AlignSpeechFileInput): Promise<SpeechAlignmentResult> {
  input.signal?.throwIfAborted();
  if (!input.audioPath.trim() || !input.text.trim()) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Narration audio and text are required.', false);
  }
  const audioInfo = await stat(input.audioPath).catch(() => null);
  if (!audioInfo?.isFile() || audioInfo.size <= 0) {
    throw new SpeechAlignmentError('INVALID_INPUT', 'Narration audio must be a non-empty file.', false);
  }

  const language = normalizeSpeechAlignmentLanguage(input.language);
  const [audioHash, textHash] = await Promise.all([
    sha256File(input.audioPath),
    Promise.resolve(sha256Text(input.text)),
  ]);
  input.signal?.throwIfAborted();
  const inputHash = createSpeechAlignmentInputHash({ audioHash, textHash, language });
  const fingerprints = { audioHash, textHash, inputHash, language, text: input.text };
  const cacheDir = input.cacheDir === false ? null : path.resolve(input.cacheDir ?? resolveSpeechAlignmentCacheDir());
  const cachePath = cacheDir && path.join(cacheDir, `${inputHash}.json`);

  if (cachePath) {
    const cached = await readCache(cachePath, fingerprints);
    if (cached) return cached;
  }

  const existing = inFlight.get(inputHash);
  if (existing) return existing;
  const operation = requestAlignment(input, fingerprints)
    .then(async (result) => {
      if (cachePath) await writeCache(cachePath, result).catch(() => undefined);
      return result;
    })
    .finally(() => {
      if (inFlight.get(inputHash) === operation) inFlight.delete(inputHash);
    });
  inFlight.set(inputHash, operation);
  return operation;
}
