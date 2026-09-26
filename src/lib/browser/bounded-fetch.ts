/** A bounded request for JSON/text APIs, including response body delivery. */
export async function boundedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort(init.signal?.reason);
    rejectAbort(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  const timer = setTimeout(() => {
    controller.abort();
    // Transport failures are safe to retry only at callers with idempotency.
    rejectAbort(new TypeError('服务器响应超时，请检查网络后重试。'));
  }, timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(input, { ...init, signal: controller.signal });
        const body = await response.arrayBuffer();
        return new Response(response.status === 204 || response.status === 304 ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })(),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
