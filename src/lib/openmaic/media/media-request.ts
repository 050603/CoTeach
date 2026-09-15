import { generationRetryAfterMs, withGenerationRetry } from '../generation/generation-retry';

/** A completed media operation must never be retried by its enclosing page/job. */
export function mediaGenerationFailure(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { isRetryable: false });
}

/** Only the failed HTTP request retries. A failed poll never restarts task submission. */
export async function fetchMediaRequest(
  input: string | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; rateLimitFallbackMs?: number } = {},
): Promise<Response> {
  try {
    return await withGenerationRetry(async () => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try { response = await fetch(input, { ...init, signal }); }
      catch (error) {
        if (!init.signal?.aborted && timeout.aborted) throw new DOMException('Media HTTP request timed out', 'TimeoutError');
        throw error;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => response.statusText);
        const error = Object.assign(new Error(`Media provider request failed (${response.status}): ${body}`), {
          statusCode: response.status, responseHeaders: response.headers,
          ...([408, 429, 500, 502, 503, 504].includes(response.status) ? {} : { isRetryable: false }),
        });
        const retryAfterMs = generationRetryAfterMs(error)
          ?? (response.status === 429 ? options.rateLimitFallbackMs : undefined);
        throw Object.assign(error, retryAfterMs === undefined ? {} : { retryAfterMs });
      }
      return response;
    }, { label: 'media HTTP request', signal: init.signal ?? undefined, maxRetries: 2 });
  } catch (error) {
    // Preserve transport evidence for logs/API headers, but signal that this
    // request has exhausted its own budget. No caller may repeat the whole job.
    if (error instanceof Error) throw Object.assign(error, { isRetryable: false });
    throw mediaGenerationFailure(String(error), error);
  }
}
