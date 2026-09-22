/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createLogger } from '@openmaic/lib/logger';
import { CLASSROOMS_DIR } from '@openmaic/lib/server/classroom-storage';
import { generateImage } from '@openmaic/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@openmaic/lib/media/video-providers';
import { generateTTS } from '@openmaic/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@openmaic/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@openmaic/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@openmaic/lib/media/video-providers';
import { isMediaPlaceholder } from '@openmaic/lib/store/media-generation';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  resolveTTSVoice,
  resolveTTSTimingCalibration,
  getTtsConcurrencyLimit,
} from '@openmaic/lib/server/provider-config';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SpeechAction } from '@openmaic/lib/types/action';
import type {
  ImageGenerationResult,
  ImageProviderId,
  MediaGenerationRequest,
} from '@openmaic/lib/media/types';
import type { VideoProviderId } from '@openmaic/lib/media/types';
import type { TTSProviderId } from '@openmaic/lib/audio/types';
import type { TtsScenarioId } from '@openmaic/lib/audio/tts-scenarios';
import { splitLongSpeechActions } from '@openmaic/lib/audio/tts-utils';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@openmaic/lib/audio/voxcpm';
import { throwIfAborted, withGenerationRetry } from '@openmaic/lib/generation/generation-retry';
import { auditNarrationLanguage } from '@openmaic/lib/generation/course-language';
import { mapWithConcurrency } from '@openmaic/lib/utils/concurrency';
import { runWithGlobalTtsProviderSlot } from '@openmaic/lib/server/tts-provider-limiter';
import { audioDurationSec } from '@openmaic/lib/audio/audio-duration';
import {
  alignSpeechFile,
  SPEECH_ALIGNMENT_VERSION,
} from '@openmaic/lib/server/speech-alignment';
import { proxyFetch } from '@openmaic/lib/server/proxy-fetch';
import {
  hasPblRoutingMetadata,
  isStudentAiLearningScene,
} from '@openmaic/lib/pbl/scene-routing';

const log = createLogger('ClassroomMedia');
const TTS_SEGMENT_RETRIES = 2;

const imageProviderQueue = new Map<ImageProviderId, Promise<void>>();
const imageProviderLastStartedAt = new Map<ImageProviderId, number>();

export function isStudentNarratedScene(scene: Scene): boolean {
  if (scene.ttsPolicy === 'none') return false;
  if (isStudentAiLearningScene(scene)) return true;
  return (
    scene.audience === 'student'
    && scene.generationPurpose === 'knowledge-teaching'
    && (scene.stageKey === 'proposal' || scene.stageKey === 'make')
  );
}

function imageRequestSpacingMs(providerId: ImageProviderId): number {
  if (providerId !== 'qwen-image') return 0;
  const configured = Number(process.env.OPENMAIC_QWEN_IMAGE_MIN_INTERVAL_MS ?? 5_000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 5_000;
}

async function waitForProviderSlot(
  providerId: ImageProviderId,
  signal: AbortSignal | undefined,
  operation: () => Promise<Awaited<ReturnType<typeof generateImage>>>,
) {
  const prior = imageProviderQueue.get(providerId) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async () => {
    throwIfAborted(signal);
    const spacingMs = imageRequestSpacingMs(providerId);
    const remainingMs = spacingMs - (Date.now() - (imageProviderLastStartedAt.get(providerId) ?? 0));
    if (remainingMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const timer = setTimeout(finish, remainingMs);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    throwIfAborted(signal);
    imageProviderLastStartedAt.set(providerId, Date.now());
    return operation();
  });
  imageProviderQueue.set(providerId, run.then(() => undefined, () => undefined));
  return run;
}

type ServerTTSRuntime = {
  providerId: TTSProviderId;
  apiKey: string;
  baseUrl?: string;
  modelId: string;
  voice: string;
  format: string;
};

export type ServerTtsTimingSelection = {
  providerId: string;
  modelId: string;
  voiceId: string;
  speed: number;
  language: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_RETRIES = 2;

async function downloadToBufferOnce(url: string, signal?: AbortSignal): Promise<Buffer> {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let resp: Response;
  try {
    // Generated files may live on an OSS acceleration host that requires the
    // deployment's media-scoped outbound proxy. LLM/API calls remain direct.
    resp = await proxyFetch(url, { signal: downloadSignal });
  } catch (error) {
    const cause = error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    const causeCode = cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? '')
      : '';
    const reason = error instanceof Error ? error.message : String(error);
    const hostname = new URL(url).hostname;
    throw new Error(
      `Generated resource download failed [host=${hostname}]: ${reason}${causeCode ? ` (${causeCode})` : ''}`,
      { cause: error },
    );
  }
  if (!resp.ok) {
    const retryAfter = resp.headers.get('retry-after') || '0';
    const retryAfterSeconds = Number(retryAfter);
    throw Object.assign(
      new Error(`Generated resource download failed: ${resp.status} ${resp.statusText}`),
      {
        statusCode: resp.status,
        isRetryable: resp.status === 429 || resp.status >= 500,
        retryAfterMs: Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1_000) : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0,
      },
    );
  }
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function downloadToBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  return withGenerationRetry(
    () => downloadToBufferOnce(url, signal),
    {
      label: `generated resource download ${new URL(url).hostname}`,
      signal,
      maxRetries: DOWNLOAD_RETRIES,
      baseDelayMs: 2_000,
      maxDelayMs: 15_000,
      onRetry: ({ attempt, maxAttempts, nextDelayMs, reason }) => {
        log.warn(
          `Retrying generated resource download [host=${new URL(url).hostname}, attempt=${attempt + 1}/${maxAttempts}, waitMs=${nextDelayMs}, reason=${reason}]`,
        );
      },
    },
  );
}

export function mediaServingUrl(_baseUrl: string, classroomId: string, subPath: string): string {
  // Classroom assets are served by this application and must remain
  // same-origin. Persisting the generation request's origin makes an otherwise
  // healthy course lose audio/images after a hostname, port, reverse-proxy or
  // HTTP -> HTTPS migration (and can also drop the session cookie/CSP access).
  return `/api/openmaic/classroom-media/${classroomId}/${subPath}`;
}

const COURSE_IMAGE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 1024, height: 768 },
  '1:1': { width: 1024, height: 1024 },
  '9:16': { width: 720, height: 1280 },
};

export function resolveCourseImageDimensions(aspectRatio = '16:9'): {
  width: number;
  height: number;
} {
  return COURSE_IMAGE_DIMENSIONS[aspectRatio] ?? COURSE_IMAGE_DIMENSIONS['16:9']!;
}

export function buildInstructionalImagePrompt(request: MediaGenerationRequest): string {
  return [
    '生成一张直接服务于课程讲解的高质量教学配图，呈现一个明确的情境或视觉示例。',
    `教学内容与构图要求：${request.prompt}`,
    request.style ? `视觉形式：${request.style}。` : undefined,
    `画幅：${request.aspectRatio || '16:9'}。主体、关键动作和对象关系必须位于画面中央 80% 安全区域，四周保留裁切余量。`,
    '严格遵守给定概念、关系、步骤和学习者年龄范围；不增加未经要求的事实或结论。',
    '画面不要文字、字母、数字、公式、标签、标题、标志或水印。精确文字、数值、公式和关系标签由页面原生可编辑元素呈现，图片只表达主体及空间关系。',
    '适合课堂投影，具有明确视觉焦点、充足留白和清晰对比；不以细小细节承载必须理解的知识点。',
  ].filter(Boolean).join('\n');
}

export async function validateGeneratedCourseImage(
  buffer: Buffer,
  _aspectRatio = '16:9',
): Promise<{ extension: 'png' | 'jpg' | 'webp'; width: number; height: number }> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw Object.assign(new Error('图片生成结果不是可解析的有效图片', { cause: error }), {
      code: 'GENERATED_IMAGE_INVALID',
      isRetryable: false,
    });
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) {
    throw Object.assign(new Error('图片生成结果缺少有效尺寸'), {
      code: 'GENERATED_IMAGE_INVALID', isRetryable: false,
    });
  }
  const extension = metadata.format === 'jpeg'
    ? 'jpg'
    : metadata.format === 'webp'
      ? 'webp'
      : metadata.format === 'png'
        ? 'png'
        : undefined;
  if (!extension) {
    throw Object.assign(new Error(`图片生成结果格式不受支持：${metadata.format || 'unknown'}`), {
      code: 'GENERATED_IMAGE_FORMAT_UNSUPPORTED',
      isRetryable: false,
    });
  }
  return { extension, width, height };
}

export async function normalizeCourseImageToAspectRatio(
  buffer: Buffer,
  aspectRatio = '16:9',
): Promise<Buffer> {
  const expected = resolveCourseImageDimensions(aspectRatio);
  return sharp(buffer)
    .rotate()
    .resize(expected.width, expected.height, { fit: 'cover', position: 'attention' })
    .webp({ quality: 90 })
    .toBuffer();
}

export async function persistGeneratedClassroomImage(input: {
  result: ImageGenerationResult;
  classroomId: string;
  elementId: string;
  aspectRatio?: string;
  baseUrl: string;
  signal?: AbortSignal;
  normalizeToAspectRatio?: boolean;
}): Promise<string> {
  throwIfAborted(input.signal);
  const sourceBuffer = input.result.base64
    ? Buffer.from(input.result.base64, 'base64')
    : input.result.url
      ? await downloadToBuffer(input.result.url, input.signal)
      : null;
  if (!sourceBuffer?.length) {
    throw Object.assign(new Error('图片生成服务未返回可用的图片文件'), {
      code: 'GENERATED_IMAGE_EMPTY',
      isRetryable: false,
    });
  }
  const buffer = input.normalizeToAspectRatio
    ? await normalizeCourseImageToAspectRatio(sourceBuffer, input.aspectRatio)
    : sourceBuffer;
  const validated = await validateGeneratedCourseImage(buffer, input.aspectRatio);
  throwIfAborted(input.signal);
  const mediaDir = path.join(CLASSROOMS_DIR, input.classroomId, 'media');
  await ensureDir(mediaDir);
  const filename = `${input.elementId}.${validated.extension}`;
  await fs.writeFile(path.join(mediaDir, filename), buffer);
  return mediaServingUrl(input.baseUrl, input.classroomId, `media/${filename}`);
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export type ClassroomMediaItemProgress = {
  type: 'image' | 'video';
  elementId: string;
  status: 'generating' | 'retrying' | 'completed' | 'failed';
  completed: number;
  total: number;
  attempt?: number;
  maxAttempts?: number;
  nextDelayMs?: number;
};

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  capabilities: { image: boolean; video: boolean },
  signal?: AbortSignal,
  onProgress?: (progress: ClassroomMediaItemProgress) => Promise<void> | void,
): Promise<{
  mediaMap: Record<string, string>;
  failures: Array<{ elementId: string; type: 'image' | 'video'; error: string }>;
}> {
  throwIfAborted(signal);
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = Array.from(
    new Map(
      outlines
        .flatMap((o) => o.mediaGenerations ?? [])
        .map((request) => [`${request.type}:${request.elementId}`, request] as const),
    ).values(),
  ) as MediaGenerationRequest[];
  if (requests.length === 0) return { mediaMap: {}, failures: [] };

  // Resolve providers
  const imageProviders = getServerImageProviders();
  const videoProviders = getServerVideoProviders();
  const imageProviderIds = Object.keys(imageProviders);
  const videoProviderIds = Object.keys(videoProviders);

  const mediaMap: Record<string, string> = {};
  const failures: Array<{ elementId: string; type: 'image' | 'video'; error: string }> = [];

  if (capabilities.image && imageProviderIds.length === 0) {
    for (const request of requests.filter((item) => item.type === 'image')) {
      failures.push({ elementId: request.elementId, type: 'image', error: '未配置可用的图像生成服务' });
    }
  }
  if (capabilities.video && videoProviderIds.length === 0) {
    for (const request of requests.filter((item) => item.type === 'video')) {
      failures.push({ elementId: request.elementId, type: 'video', error: '未配置可用的视频生成服务' });
    }
  }

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => capabilities.image && r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => capabilities.video && r.type === 'video' && videoProviderIds.length > 0);
  const totalRequests = imageRequests.length + videoRequests.length;
  let completedRequests = 0;

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        throwIfAborted(signal);
        await onProgress?.({
          type: 'image', elementId: req.elementId, status: 'generating',
          completed: completedRequests, total: totalRequests,
        });
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          failures.push({ elementId: req.elementId, type: 'image', error: '图像生成服务缺少 API 密钥' });
          continue;
        }
        const model = imageProviders[providerId]?.defaultModel || providerConfig?.models?.[0]?.id;

        const aspectRatio = req.aspectRatio || '16:9';
        const dimensions = resolveCourseImageDimensions(aspectRatio);
        const pendingKey = createHash('sha256').update(JSON.stringify({ req, providerId, model })).digest('hex');
        const pendingPath = path.join(mediaDir, `.pending-image-${pendingKey}.json`);
        let pendingResult: ImageGenerationResult | undefined;
        try {
          pendingResult = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ImageGenerationResult;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const result = pendingResult ?? await waitForProviderSlot(providerId, signal, () => generateImage(
            { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
            {
              prompt: buildInstructionalImagePrompt(req),
              aspectRatio,
              ...dimensions,
              style: req.style,
              signal,
              negativePrompt: 'text, numbers, formula, label, watermark, logo, irrelevant decoration, cropped subject, cluttered layout',
            },
          ));
        // Keep the provider result before downloading so interrupted jobs also
        // reuse the same image. A changed prompt has a different pending key.
        if (!pendingResult) await fs.writeFile(pendingPath, JSON.stringify(result));
        // Download and persist the same result; neither operation may redraw it.
        mediaMap[req.elementId] = await persistGeneratedClassroomImage({
          result, classroomId, elementId: req.elementId, aspectRatio, baseUrl, signal,
        });
        await fs.unlink(pendingPath).catch((error) => log.warn('Could not clean completed image checkpoint', error));
        log.info(`Generated image: ${req.elementId}`);
        completedRequests += 1;
        await onProgress?.({
          type: 'image', elementId: req.elementId, status: 'completed',
          completed: completedRequests, total: totalRequests,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn(`Image generation failed for ${req.elementId}:`, err);
        failures.push({ elementId: req.elementId, type: 'image', error: err instanceof Error ? err.message : String(err) });
        completedRequests += 1;
        await onProgress?.({
          type: 'image', elementId: req.elementId, status: 'failed',
          completed: completedRequests, total: totalRequests,
        });
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        throwIfAborted(signal);
        await onProgress?.({
          type: 'video', elementId: req.elementId, status: 'generating',
          completed: completedRequests, total: totalRequests,
        });
        const providerId = req.videoProviderId ?? videoProviderIds[0] as VideoProviderId;
        if (!videoProviders[providerId]) throw Object.assign(new Error(`已锁定的视频供应商 ${providerId} 当前不可用`), { isRetryable: false });
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          failures.push({ elementId: req.elementId, type: 'video', error: '视频生成服务缺少 API 密钥' });
          continue;
        }
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = videoProviders[providerId]?.defaultModel || providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          duration: req.duration,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });
        if (req.videoProviderId && normalized.duration !== req.duration) {
          throw Object.assign(new Error(`已锁定的视频时长 ${req.duration} 秒与供应商能力不一致`), { isRetryable: false });
        }

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          { ...normalized, signal },
        );
        const buf = await downloadToBuffer(result.url, signal);
        throwIfAborted(signal);
        if (!buf.length) throw new Error('视频生成服务返回了空文件');
        const filename = `${req.elementId}.mp4`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        completedRequests += 1;
        await onProgress?.({
          type: 'video', elementId: req.elementId, status: 'completed',
          completed: completedRequests, total: totalRequests,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn(`Video generation failed for ${req.elementId}:`, err);
        failures.push({ elementId: req.elementId, type: 'video', error: err instanceof Error ? err.message : String(err) });
        completedRequests += 1;
        await onProgress?.({
          type: 'video', elementId: req.elementId, status: 'failed',
          completed: completedRequests, total: totalRequests,
        });
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);
  throwIfAborted(signal);

  return { mediaMap, failures };
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(
  scenes: Scene[],
  mediaMap: Record<string, string>,
  outlines: ReadonlyArray<SceneOutline> = [],
): void {
  if (Object.keys(mediaMap).length === 0) return;

  const mediaByOutline = new Map(
    outlines.map((outline) => [
      outline.id,
      (outline.mediaGenerations ?? []).filter((request) => Boolean(mediaMap[request.elementId])),
    ]),
  );

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;
    const plannedMedia = scene.outlineId ? (mediaByOutline.get(scene.outlineId) ?? []) : [];

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || el.src === el.mediaRef || isMediaPlaceholder(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if ((el.type === 'image' || el.type === 'video') && typeof el.src === 'string') {
        // Resolve an exact request key first. New teaching blueprints use
        // stable `<outline-id>:media-<n>` keys, while older courses use
        // `gen_img_*` / `gen_vid_*`. Requiring the legacy shape before this
        // lookup left successfully generated files disconnected from slides.
        const exactUrl = mediaMap[el.src];
        if (exactUrl) {
          el.src = exactUrl;
          continue;
        }

        if (!isMediaPlaceholder(el.src)) continue;

        // Some providers occasionally normalize the placeholder back to a
        // sequential gen_img_1/gen_vid_1 ID instead of echoing the randomized
        // ID from the confirmed outline. Media planning allows at most one
        // generated asset per outline, so matching by outline and media type is
        // deterministic and avoids leaving an empty image in the final page.
        const matchedPlan = plannedMedia.filter((request) => request.type === el.type);
        if (matchedPlan.length === 1) el.src = mediaMap[matchedPlan[0]!.elementId]!;
      }
    }
  }
}

export function findUnresolvedClassroomMedia(
  outlines: ReadonlyArray<{ id: string; mediaGenerations?: unknown }>,
  scenes: ReadonlyArray<Scene>,
): Array<{ elementId: string; type: 'image' | 'video'; error: string }> {
  const requestsByOutlineId = new Map(outlines.map((outline) => [
    outline.id,
    Array.isArray(outline.mediaGenerations)
      ? outline.mediaGenerations.filter((value): value is MediaGenerationRequest => {
          if (!value || typeof value !== 'object') return false;
          const request = value as Partial<MediaGenerationRequest>;
          return (request.type === 'image' || request.type === 'video')
            && typeof request.elementId === 'string'
            && request.elementId.length > 0;
        })
      : [],
  ]));
  const unresolved = new Map<string, { elementId: string; type: 'image' | 'video'; error: string }>();

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const requests = scene.outlineId ? (requestsByOutlineId.get(scene.outlineId) ?? []) : [];
    const elements = (
      scene.content as {
        canvas?: { elements?: Array<{ src?: string; mediaRef?: string; type?: string }> };
      }
    )?.canvas?.elements ?? [];

    for (const request of requests) {
      const sameTypeRequests = requests.filter((candidate) => candidate.type === request.type);
      const hasUnresolvedElement = elements.some((element) => {
        if (element.type !== request.type) return false;
        if (request.type === 'video' && element.mediaRef === request.elementId) {
          return !element.src || element.src === request.elementId || isMediaPlaceholder(element.src);
        }
        if (typeof element.src !== 'string') return false;
        return element.src === request.elementId
          || (isMediaPlaceholder(element.src) && sameTypeRequests.length === 1);
      });
      if (!hasUnresolvedElement) continue;
      unresolved.set(`${request.type}:${request.elementId}`, {
        elementId: request.elementId,
        type: request.type,
        error: '页面仍包含未解析的媒体占位符',
      });
    }

    // A raw generation placeholder is itself an integrity failure even when
    // an older course record lost its media plan. Reporting it prevents an
    // empty plan from being mistaken for a successfully completed batch.
    for (const element of elements) {
      if (element.type !== 'image' && element.type !== 'video') continue;
      const placeholder = typeof element.src === 'string' && isMediaPlaceholder(element.src)
        ? element.src
        : element.type === 'video'
          && typeof element.mediaRef === 'string'
          && isMediaPlaceholder(element.mediaRef)
            ? element.mediaRef
            : undefined;
      if (!placeholder) continue;
      const sameTypeRequests = requests.filter((request) => request.type === element.type);
      const matchingRequest = sameTypeRequests.find((request) => request.elementId === placeholder)
        ?? (sameTypeRequests.length === 1 ? sameTypeRequests[0] : undefined);
      const key = `${element.type}:${matchingRequest?.elementId ?? placeholder}`;
      if (unresolved.has(key)) continue;
      unresolved.set(key, {
        elementId: matchingRequest?.elementId ?? placeholder,
        type: element.type,
        error: matchingRequest
          ? '页面仍包含未解析的媒体占位符'
          : '媒体生成计划缺失，无法生成真实资源',
      });
    }
  }

  return Array.from(unresolved.values());
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

function resolveServerTTSRuntimes(
  providerIds: string[],
  scenario: TtsScenarioId = 'course-generation',
): ServerTTSRuntime[] {
  return providerIds.flatMap((id) => {
    const providerId = id as TTSProviderId;
    const apiKey = resolveTTSApiKey(providerId);
    const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
    if (ttsProvider?.requiresApiKey && !apiKey) {
      log.warn(`No API key for TTS provider "${providerId}", skipping provider`);
      return [];
    }

    const voice = resolveTTSVoice(
      providerId,
      DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default',
      scenario,
    ) || 'default';
    if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID) {
      log.warn('VoxCPM Auto Voice requires agent context; skipping server-side provider');
      return [];
    }

    const defaultModel = DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '';
    return [
      {
        providerId,
        apiKey,
        baseUrl: resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl,
        modelId: resolveTTSModel(providerId, defaultModel, scenario) || defaultModel,
        voice,
        format: ttsProvider?.supportedFormats?.[0] || 'mp3',
      },
    ];
  });
}

function getConfiguredTtsProviderIds(): string[] {
  return Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
}

/** Resolve the same provider/model that server-side audio generation will use. */
export function resolveServerTtsTimingSelection(options: {
  providerId?: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  language?: string;
} = {}): ServerTtsTimingSelection {
  const configuredIds = getConfiguredTtsProviderIds();
  const runtimes = resolveServerTTSRuntimes(
    options.providerId && configuredIds.includes(options.providerId)
      ? [options.providerId, ...configuredIds.filter((id) => id !== options.providerId)]
      : configuredIds,
  );
  const runtime = runtimes[0];
  const providerId = runtime?.providerId ?? options.providerId ?? 'default';
  const modelId = runtime?.modelId ?? options.modelId ?? '';
  const voiceId = options.voiceId && (!options.providerId || options.providerId === providerId)
    ? options.voiceId
    : runtime?.voice ?? options.voiceId ?? 'default';
  const language = options.language || 'zh-CN';
  const speed = 1;
  resolveTTSTimingCalibration(providerId, modelId, voiceId, language, speed);
  return { providerId, modelId, voiceId, speed, language };
}

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  signal?: AbortSignal,
  timingOptions: Partial<ServerTtsTimingSelection> = {},
): Promise<void> {
  throwIfAborted(signal);
  // Defensive second gate: if the caller passes a routed PBL scene set, only
  // the explicit student AI-learning route may receive audio. This keeps
  // future callers from accidentally reintroducing TTS on teacher resources.
  const hasRoutedScenes = scenes.some(hasPblRoutingMetadata);
  const eligibleScenes = hasRoutedScenes
    ? scenes.filter(isStudentNarratedScene)
    : scenes;

  if (eligibleScenes.length === 0) return;
  const narrationLanguageIssues = eligibleScenes.flatMap((scene) =>
    auditNarrationLanguage(
      scene.actions,
      scene.timingPlan?.language ?? timingOptions.language,
    ).map((issue) => ({ ...issue, sceneTitle: scene.title, sceneOrder: scene.order })),
  );
  if (narrationLanguageIssues.length > 0) {
    const examples = narrationLanguageIssues
      .slice(0, 3)
      .map((issue) => `${issue.sceneOrder + 1}. ${issue.sceneTitle} / ${issue.actionId}`)
      .join('；');
    const error = new Error(
      `检测到 ${narrationLanguageIssues.length} 段讲稿语言与中文课程不一致，已在 TTS 合成前停止：${examples}`,
    ) as Error & { isRetryable: boolean };
    error.name = 'ClassroomNarrationLanguageError';
    error.isRetryable = false;
    throw error;
  }
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Resolve TTS provider (exclude browser-native-tts and operator force-disabled
  // providers — server precedence, #665).
  const ttsProviderIds = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
  if (ttsProviderIds.length === 0) {
    if (timingOptions.providerId && timingOptions.providerId !== 'default') throw new Error('已锁定的 TTS 供应商不可用，请恢复原配置');
    log.warn('No server TTS provider configured, skipping TTS generation');
    return;
  }

  const runtimes = resolveServerTTSRuntimes(ttsProviderIds);
  if (runtimes.length === 0) {
    log.warn('No usable server TTS provider configured, skipping TTS generation');
    return;
  }
  const speechTasks: Array<{
    speechAction: SpeechAction;
    actionId: string;
    audioId: string;
    runtime: ServerTTSRuntime;
    timing: Partial<ServerTtsTimingSelection>;
  }> = [];

  // Prepare all scene actions before starting requests. This keeps action
  // splitting and duration allocation deterministic, while the actual TTS
  // calls below can run concurrently without mutating the same action twice.
  for (const scene of eligibleScenes) {
    throwIfAborted(signal);
    if (!scene.actions) continue;

    const timing = scene.timingPlan ?? timingOptions;
    const runtime = timing.providerId && timing.providerId !== 'default'
      ? runtimes.find((candidate) => candidate.providerId === timing.providerId)
      : runtimes[0];
    if (!runtime) throw new Error('页面已锁定的 TTS 供应商不可用，请恢复原配置');
    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, runtime.providerId);
    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (
        action.type !== 'speech'
        || !(action as SpeechAction).text
        || (action as SpeechAction).audioUrl
      ) continue;
      const speechAction = action as SpeechAction;
      // Include scene order in audioId to prevent collision across scenes
      const audioId = `tts_s${sceneOrder}_${action.id}`;
      speechTasks.push({ speechAction, actionId: action.id, audioId, runtime, timing });
    }
  }

  if (speechTasks.length === 0) return;

  const concurrency = Math.min(
    speechTasks.length,
    ...speechTasks.map((task) => getTtsConcurrencyLimit(task.runtime.providerId)),
  );
  log.info(
    `Generating TTS with bounded concurrency [classroomId=${classroomId}, segments=${speechTasks.length}, concurrency=${concurrency}]`,
  );

  const outcomes = await mapWithConcurrency(speechTasks, concurrency, async (task) => {
    try {
      const { runtime, timing } = task;
      const result = await withGenerationRetry(
        () => runWithGlobalTtsProviderSlot(
          runtime.providerId,
          getTtsConcurrencyLimit(runtime.providerId),
          () => generateTTS({
            providerId: runtime.providerId,
            modelId: timing.modelId || runtime.modelId,
            apiKey: runtime.apiKey,
            baseUrl: runtime.baseUrl,
            voice: timing.voiceId || runtime.voice,
            speed: timing.speed ?? 1,
            language: timing.language,
            signal,
          }, task.speechAction.text),
          signal,
        ),
        { label: `tts action ${task.actionId}`, maxRetries: TTS_SEGMENT_RETRIES, signal },
      );
      throwIfAborted(signal);
      if (!result.audio.length) throw new Error('TTS 返回了空音频文件');
      const filename = `${task.audioId}.${result.format || runtime.format}`;
      await fs.writeFile(path.join(audioDir, filename), result.audio);
      task.speechAction.audioId = task.audioId;
      task.speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
      task.speechAction.audioDurationSec = audioDurationSec(result.audio, result.format || runtime.format);
      delete task.speechAction.audioInvalidated;
      log.info(`Generated TTS via ${runtime.providerId}: ${filename} (${result.audio.length} bytes)`);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn(`TTS generation remained incomplete for action ${task.actionId}`, error);
      return false;
    }
  });

  const failedActionIds = speechTasks.flatMap((task, index) => outcomes[index] ? [] : [task.actionId]);
  await alignClassroomSpeechActions({
    scenes: eligibleScenes,
    classroomId,
    signal,
    language: timingOptions.language,
  });
  if (failedActionIds.length > 0) {
    const error = new Error(
      `课堂语音仍有 ${failedActionIds.length} 段未生成：${failedActionIds.join(', ')}`,
    ) as Error & { isRetryable: boolean };
    error.name = 'ClassroomTtsIncompleteError';
    error.isRetryable = false;
    throw error;
  }
}

export type SpeechAlignmentProgress = {
  completed: number;
  total: number;
  actionId: string;
  status: 'aligned' | 'failed';
};

function classroomSpeechAudioPath(classroomId: string, audioUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(audioUrl, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
  const marker = `/api/openmaic/classroom-media/${encodeURIComponent(classroomId)}/audio/`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const filename = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!filename || filename !== path.basename(filename)) return undefined;
  return path.join(CLASSROOMS_DIR, classroomId, 'audio', filename);
}

/** Align persisted narration without regenerating either its audio or wording. */
export async function alignClassroomSpeechActions(input: {
  scenes: Scene[];
  classroomId: string;
  language?: string;
  /** Restrict work to newly generated clips; keys are JSON `[sceneId, actionId]` tuples. */
  actionKeys?: ReadonlySet<string>;
  signal?: AbortSignal;
  onProgress?: (progress: SpeechAlignmentProgress) => void | Promise<void>;
}): Promise<{ aligned: number; failed: number; total: number }> {
  const tasks = input.scenes.flatMap((scene) => (scene.actions ?? []).flatMap((action) => {
    if (action.type !== 'speech' || !action.text.trim() || !action.audioUrl) return [];
    if (input.actionKeys && !input.actionKeys.has(JSON.stringify([scene.id, action.id]))) return [];
    const audioPath = classroomSpeechAudioPath(input.classroomId, action.audioUrl);
    return audioPath ? [{ action, audioPath, language: scene.timingPlan?.language ?? input.language }] : [];
  }));
  let aligned = 0;
  let failed = 0;
  for (const [index, task] of tasks.entries()) {
    throwIfAborted(input.signal);
    task.action.speechAlignment = {
      version: SPEECH_ALIGNMENT_VERSION,
      status: 'pending',
      textHash: '',
      audioHash: '',
      spans: [],
    };
    try {
      const result = await alignSpeechFile({
        audioPath: task.audioPath,
        text: task.action.text,
        language: task.language,
        signal: input.signal,
      });
      task.action.speechAlignment = {
        version: result.version,
        status: 'aligned',
        textHash: result.textHash,
        audioHash: result.audioHash,
        language: result.language,
        spans: result.spans,
      };
      aligned += 1;
      await input.onProgress?.({
        completed: index + 1,
        total: tasks.length,
        actionId: task.action.id,
        status: 'aligned',
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const previous = task.action.speechAlignment;
      task.action.speechAlignment = {
        ...previous,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      failed += 1;
      log.warn(`Speech alignment failed for ${task.action.id}; visual cues will be disabled`, error);
      await input.onProgress?.({
        completed: index + 1,
        total: tasks.length,
        actionId: task.action.id,
        status: 'failed',
      });
    }
  }
  return { aligned, failed, total: tasks.length };
}
