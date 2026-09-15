export interface GenerationRetryEvent {
  label: string;
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  reason: string;
}

export interface GenerationRetryOptions<T> {
  label: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** @deprecated Completed responses never schedule another generation. */
  shouldRetryResult?: (result: T) => boolean;
  shouldRetryError?: (error: unknown) => boolean;
  onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;
const RETRYABLE_STATUS_CODES = new Set([408, 429]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Detect cancellation consistently across browser, Node, and test runtimes.
 * Some runtimes expose AbortError as a DOMException, while others use a plain
 * Error-shaped value, so relying on one prototype is not sufficient.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;

  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return true;
  }

  return isRecord(error) && stringField(error, 'name') === 'AbortError';
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function statusCodeFrom(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of ['statusCode', 'status', 'status_code']) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function messageFrom(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (!isRecord(value)) return String(value);
  const message = stringField(value, 'message') ?? stringField(value, 'statusText');
  return message ?? '';
}

function retryableByMessage(value: unknown): boolean {
  const message = messageFrom(value);
  return /rate limit|too many requests|timeout|timed out|调用超时|请求超时|fetch failed|network|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up/i.test(
    message,
  );
}

function unwrapErrors(value: unknown): unknown[] {
  if (!isRecord(value)) return [];

  const nested: unknown[] = [];
  if ('lastError' in value) nested.push(value.lastError);
  if ('cause' in value) nested.push(value.cause);

  const errors = value.errors;
  if (Array.isArray(errors)) nested.push(...errors);

  return nested;
}

export function isRetryableGenerationError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  if (isAbortError(error)) return false;

  if (isRecord(error)) {
    const explicitRetryable = booleanField(error, 'isRetryable');
    if (explicitRetryable === false) return false;
  }

  const statusCode = statusCodeFrom(error);
  if (statusCode !== undefined) {
    if (RETRYABLE_STATUS_CODES.has(statusCode) || [500, 502, 503, 504].includes(statusCode)) return true;
    if (NON_RETRYABLE_STATUS_CODES.has(statusCode) || (statusCode >= 400 && statusCode < 500)) {
      return false;
    }
  }

  const nested = unwrapErrors(error);
  if (nested.length > 0) {
    return nested.some((nestedError) => isRetryableGenerationError(nestedError, seen));
  }

  const errorName = isRecord(error) ? stringField(error, 'name') : undefined;
  if (
    errorName === 'TimeoutError'
    || errorName === 'LlmTimeoutError'
    || errorName === 'LlmRateLimitError'
  ) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  return retryableByMessage(error);
}

/** Add pipeline context without dropping provider retry metadata. */
export function contextualizeGenerationError(error: unknown, context: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${context}: ${detail}`, { cause: error });
  const record = isRecord(error) ? error : null;
  if (record?.isRetryable === false) {
    Object.assign(wrapped, { isRetryable: false });
  } else if (isRetryableGenerationError(error)) {
    Object.assign(wrapped, { isRetryable: true });
  }
  for (const key of ['code', 'status', 'statusCode', 'status_code'] as const) {
    const value = record?.[key];
    if (typeof value === 'string' || typeof value === 'number') {
      Object.assign(wrapped, { [key]: value });
    }
  }
  return wrapped;
}

function retryReason(error: unknown): string {
  const statusCode = statusCodeFrom(error);
  if (statusCode !== undefined) return `HTTP ${statusCode}`;
  const message = messageFrom(error).trim();
  return message || 'retryable error';
}

export function generationRetryAfterMs(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!isRecord(error) || seen.has(error)) return undefined;
  seen.add(error);

  const direct = numberField(error, 'retryAfterMs') ?? numberField(error, 'retry_after_ms');
  if (direct !== undefined && direct >= 0) return direct;

  // AI SDK API errors expose responseHeaders; fetch adapters may keep Headers.
  for (const headers of [error.responseHeaders, error.headers, isRecord(error.response) ? error.response.headers : undefined]) {
    const raw = headers instanceof Headers ? headers.get('retry-after')
      : isRecord(headers) ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
      : undefined;
    if (typeof raw !== 'string') continue;
    const seconds = Number(raw);
    if (raw.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  for (const nested of unwrapErrors(error)) {
    const nestedDelay = generationRetryAfterMs(nested, seen);
    if (nestedDelay !== undefined) return nestedDelay;
  }
  return undefined;
}

function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exponentialDelay * Math.max(0, Math.min(random(), 1)) * 0.2);
  return Math.min(maxDelayMs, exponentialDelay + jitter);
}

export async function withGenerationRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: GenerationRetryOptions<T>,
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options.signal);

    try {
      const result = await operation(attempt);
      throwIfAborted(options.signal);

      return result;

    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throwIfAborted(options.signal);

      const retryable = isRetryableGenerationError(error) && (options.shouldRetryError?.(error) ?? true);
      if (attempt >= maxAttempts || !retryable) {
        throw error;
      }

      const nextDelayMs = Math.max(
        retryDelayMs(attempt, baseDelayMs, maxDelayMs, random),
        generationRetryAfterMs(error) ?? 0,
      );
      await options.onRetry?.({
        label: options.label,
        attempt,
        maxAttempts,
        nextDelayMs,
        reason: retryReason(error),
      });
      throwIfAborted(options.signal);
      await sleep(nextDelayMs, options.signal);
    }
  }

  throw new Error(`Generation retry loop exhausted for ${options.label}`);
}
