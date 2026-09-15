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
import { isRetryableGenerationError } from '@openmaic/lib/generation/generation-retry';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('MediaOrchestrator');

/** Fetch timeout for a single image/video API call (ms). */
const IMAGE_API_TIMEOUT_MS = 90_000;
const VIDEO_API_TIMEOUT_MS = 180_000;

/** Max automatic retries before marking a task as permanently failed. */
const MAX_AUTO_RETRIES = 2;

/** Base delay between retries (ms), multiplied by attempt number. */
const RETRY_BASE_DELAY_MS = 2_000;
const generatedResources = new Map<string, { url: string; poster?: string }>();

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  statusCode?: number;
  retryAfterMs?: number;
  isRetryable?: boolean;
  constructor(message: string, errorCode?: string, response?: Response) {
    super(message);
    this.errorCode = errorCode;
    this.statusCode = response?.status;
    if (response?.headers.get('x-generation-retryable') === 'false') this.isRetryable = false;
    const hint = response?.headers.get('retry-after');
    this.retryAfterMs = hint ? (Number.isFinite(Number(hint)) ? Number(hint) * 1000 : Math.max(0, Date.parse(hint) - Date.now())) : undefined;
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
  return isRetryableGenerationError(err);
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
      duration: task.params.duration,
      videoProviderId: task.params.videoProviderId,
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
  const resourceKey = `${stageId}:${req.elementId}:${req.prompt}`;
  let resource = generatedResources.get(resourceKey);

  for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
    if (abortSignal?.aborted) return;

    try {
      if (!resource) {
        resource = await (req.type === 'image' ? callImageApi(req, abortSignal) : callVideoApi(req, abortSignal));
        generatedResources.set(resourceKey, resource);
      }
      const resultUrl = resource.url;
      const posterUrl = resource.poster;
      const mimeType = req.type === 'image' ? 'image/png' : 'video/mp4';

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
          duration: req.duration,
          videoProviderId: req.videoProviderId,
        }),
        createdAt: Date.now(),
      });

      // Update store with object URL
      const objectUrl = URL.createObjectURL(blob);
      const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
      generatedResources.delete(resourceKey);
      return; // success — exit retry loop
    } catch (err) {
      if (abortSignal?.aborted) return;
      lastError = err;
      lastErrorCode = err instanceof MediaApiError ? err.errorCode : undefined;

      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
      log.warn(`Failed ${req.elementId} (attempt ${attempt + 1}/${MAX_AUTO_RETRIES + 1}): ${message}${isTimeout ? ' [TIMEOUT]' : ''}`);

      // Don't retry non-retryable errors or if the caller aborted.
      if (!resource || !isRetryableError(err) || attempt >= MAX_AUTO_RETRIES) break;

      // Exponential backoff before retry.
      await new Promise((resolve) => setTimeout(resolve, Math.max(RETRY_BASE_DELAY_MS * (attempt + 1), err instanceof MediaApiError ? err.retryAfterMs ?? 0 : 0)));
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
          duration: req.duration,
          videoProviderId: req.videoProviderId,
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
      throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode, response);
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
  const providerId = req.videoProviderId ?? settings.videoProviderId;
  const providerConfig = settings.videoProvidersConfig?.[providerId];

  const { signal: timeoutSignal, cleanup } = withTimeoutSignal(abortSignal, VIDEO_API_TIMEOUT_MS);

  try {
    const response = await fetch('/api/openmaic/generate/video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-video-provider': providerId || '',
        'x-video-model': settings.videoModelId || '',
        'x-api-key': providerConfig?.apiKey || '',
        'x-base-url': providerConfig?.baseUrl || '',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspectRatio: req.aspectRatio,
        duration: req.duration,
      }),
      signal: timeoutSignal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode, response);
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
    const res = await fetch('/api/openmaic/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new MediaApiError(data.error || `Proxy fetch failed: ${res.status}`, undefined, res);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new MediaApiError(`Failed to fetch blob: ${res.status}`, undefined, res);
  return res.blob();
}
