/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls the canonical CoTeach media APIs,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@openmaic/lib/store/media-generation';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import { db, mediaFileKey } from '@openmaic/lib/utils/database';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { MediaGenerationRequest } from '@openmaic/lib/media/types';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('MediaOrchestrator');

/** Fetch timeout for a single image/video API call (ms). */
const IMAGE_API_TIMEOUT_MS = 90_000;
const VIDEO_API_TIMEOUT_MS = 180_000;

/** Max automatic retries before marking a task as permanently failed. */
const MAX_AUTO_RETRIES = 2;

/** Base delay between retries (ms), multiplied by attempt number. */
const RETRY_BASE_DELAY_MS = 2_000;

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Combine the caller's abort signal with a timeout. Returns a new signal that
 * aborts when either source aborts. Falls back gracefully when `AbortSignal.any`
 * is unavailable (older runtimes) or when no caller signal is provided.
 */
function withTimeoutSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);

  if (!callerSignal) {
    return { signal: timeoutController.signal, cleanup: () => clearTimeout(timer) };
  }

  // If caller already aborted, propagate immediately.
  if (callerSignal.aborted) {
    clearTimeout(timer);
    timeoutController.abort(callerSignal.reason);
    return { signal: timeoutController.signal, cleanup: () => {} };
  }

  // Propagate caller abort to the combined controller.
  const onCallerAbort = (reason: unknown) => timeoutController.abort(reason);
  callerSignal.addEventListener('abort', () => onCallerAbort(callerSignal.reason), { once: true });

  // Prefer AbortSignal.any when available (Node 20+ / modern browsers).
  if (typeof AbortSignal.any === 'function') {
    const combined = AbortSignal.any([callerSignal, timeoutController.signal]);
    return { signal: combined, cleanup: () => { clearTimeout(timer); } };
  }

  // Fallback: just use the timeout controller; caller abort is propagated above.
  return { signal: timeoutController.signal, cleanup: () => { clearTimeout(timer); } };
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof MediaApiError) {
    // Content safety / disabled errors are not retryable.
    const nonRetryable = ['CONTENT_SENSITIVE', 'GENERATION_DISABLED'];
    if (err.errorCode && nonRetryable.includes(err.errorCode)) return false;
    return true;
  }
  // Network errors, timeouts, and generic failures are retryable.
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) return true;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // Skip already completed or permanently failed (restored from DB)
      const existing = store.getTask(mg.elementId);
      if (existing?.status === 'done' || existing?.status === 'failed') continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  // Process requests serially — image/video APIs have limited concurrency
  for (const req of allRequests) {
    if (abortSignal?.aborted) break;
    await generateSingleMedia(req, stageId, abortSignal);
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(elementId: string): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  // Remove persisted failure record from DB so a fresh result can be written
  const dbKey = mediaFileKey(task.stageId, elementId);
  await db.mediaFiles.delete(dbKey).catch(() => {});

  store.markPendingForRetry(elementId);
  await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
  );
}

// ==================== Internal ====================

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  let lastError: unknown;
  let lastErrorCode: string | undefined;

  for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
    if (abortSignal?.aborted) return;

    try {
      let resultUrl: string;
      let posterUrl: string | undefined;
      let mimeType: string;

      if (req.type === 'image') {
        const result = await callImageApi(req, abortSignal);
        resultUrl = result.url;
        mimeType = 'image/png';
      } else {
        const result = await callVideoApi(req, abortSignal);
        resultUrl = result.url;
        posterUrl = result.poster;
        mimeType = 'video/mp4';
      }

      if (abortSignal?.aborted) return;

      // Fetch blob from URL
      const blob = await fetchAsBlob(resultUrl);
      const posterBlob = posterUrl ? await fetchAsBlob(posterUrl).catch(() => undefined) : undefined;

      // Store in IndexedDB
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: req.type,
        blob,
        mimeType,
        size: blob.size,
        poster: posterBlob,
        prompt: req.prompt,
        params: JSON.stringify({
          aspectRatio: req.aspectRatio,
          style: req.style,
        }),
        createdAt: Date.now(),
      });

      // Update store with object URL
      const objectUrl = URL.createObjectURL(blob);
      const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
      return; // success — exit retry loop
    } catch (err) {
      if (abortSignal?.aborted) return;
      lastError = err;
      lastErrorCode = err instanceof MediaApiError ? err.errorCode : undefined;

      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      log.warn(`Failed ${req.elementId} (attempt ${attempt + 1}/${MAX_AUTO_RETRIES + 1}): ${message}${isTimeout ? ' [TIMEOUT]' : ''}`);

      // Don't retry non-retryable errors or if the caller aborted.
      if (!isRetryableError(err) || attempt >= MAX_AUTO_RETRIES) break;

      // Exponential backoff before retry.
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  // All retries exhausted — mark as permanently failed.
  if (abortSignal?.aborted) return;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const isTimeout = lastError instanceof DOMException && lastError.name === 'TimeoutError';
  const displayMessage = isTimeout
    ? `图片生成超时（已重试 ${MAX_AUTO_RETRIES} 次）`
    : message;
  log.error(`Permanently failed ${req.elementId}:`, displayMessage);
  useMediaGenerationStore.getState().markFailed(req.elementId, displayMessage, lastErrorCode);

  // Persist non-retryable failures to IndexedDB so they survive page refresh
  if (lastErrorCode) {
    await db.mediaFiles
      .put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: req.type,
        blob: new Blob(), // empty placeholder
        mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
        size: 0,
        prompt: req.prompt,
        params: JSON.stringify({
          aspectRatio: req.aspectRatio,
          style: req.style,
        }),
        error: displayMessage,
        errorCode: lastErrorCode,
        createdAt: Date.now(),
      })
      .catch(() => {}); // best-effort
  }
}

async function callImageApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{ url: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];

  const { signal: timeoutSignal, cleanup } = withTimeoutSignal(abortSignal, IMAGE_API_TIMEOUT_MS);

  try {
    const response = await fetch('/api/openmaic/generate/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-image-provider': settings.imageProviderId || '',
        'x-image-model': settings.imageModelId || '',
        'x-api-key': providerConfig?.apiKey || '',
        'x-base-url': providerConfig?.baseUrl || '',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        style: req.style,
      }),
      signal: timeoutSignal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode);
    }

    const data = await response.json();
    if (!data.success)
      throw new MediaApiError(data.error || 'Image generation failed', data.errorCode);

    // Result may have url or base64
    const url =
      data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
    if (!url) throw new Error('No image URL in response');
    return { url };
  } finally {
    cleanup();
  }
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{ url: string; poster?: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  const { signal: timeoutSignal, cleanup } = withTimeoutSignal(abortSignal, VIDEO_API_TIMEOUT_MS);

  try {
    const response = await fetch('/api/openmaic/generate/video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-video-provider': settings.videoProviderId || '',
        'x-video-model': settings.videoModelId || '',
        'x-api-key': providerConfig?.apiKey || '',
        'x-base-url': providerConfig?.baseUrl || '',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
      }),
      signal: timeoutSignal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
    }

    const data = await response.json();
    if (!data.success)
      throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

    const url = data.result?.url;
    if (!url) throw new Error('No video URL in response');
    return { url, poster: data.result?.poster };
  } finally {
    cleanup();
  }
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
