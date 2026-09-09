/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
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
import { splitLongSpeechActions } from '@openmaic/lib/audio/tts-utils';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@openmaic/lib/audio/voxcpm';
import {
  getTtsTimingProfile,
} from '@openmaic/lib/audio/tts-timing';
import { throwIfAborted, withGenerationRetry } from '@openmaic/lib/generation/generation-retry';
import { mapWithConcurrency } from '@openmaic/lib/utils/concurrency';
import { runWithGlobalTtsProviderSlot } from '@openmaic/lib/server/tts-provider-limiter';
import { proxyFetch } from '@openmaic/lib/server/proxy-fetch';
import { parseJsonResponse } from '@openmaic/lib/generation/json-repair';
import {
  hasPblRoutingMetadata,
  isStudentAiLearningScene,
} from '@openmaic/lib/pbl/scene-routing';

const log = createLogger('ClassroomMedia');
const TTS_SEGMENT_RETRIES = 2;

class TtsSegmentGenerationError extends Error {
  readonly isRetryable = true;

  constructor(actionId: string) {
    super(`TTS generation failed for action ${actionId}: all configured providers failed`);
    this.name = 'TtsSegmentGenerationError';
  }
}

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
const DOWNLOAD_RETRIES = 3;

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
    throw Object.assign(
      new Error(`Generated resource download failed: ${resp.status} ${resp.statusText}`),
      {
        statusCode: resp.status,
        // Generated OSS URLs are short-lived. A fresh provider response is
        // required after expiry/not-found instead of retrying the same URL.
        isRetryable: resp.status === 403 || resp.status === 404 || resp.status >= 500,
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
      // Connection failures can reuse the same signed URL. HTTP failures are
      // returned immediately so the outer provider retry can obtain a fresh
      // short-lived URL instead.
      shouldRetryError: (error) => {
        if (!error || typeof error !== 'object') return true;
        return !(typeof (error as { statusCode?: unknown }).statusCode === 'number');
      },
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
  const includesStructuredText = /中文|文字|标签|标题|流程图|矩阵|表格|信息图/.test(request.prompt);
  return [
    '生成一张直接服务于课程讲解的高质量教学配图，不得使用无关的装饰性素材。',
    `教学内容与构图要求：${request.prompt}`,
    request.style ? `视觉形式：${request.style}。` : undefined,
    '内容必须准确、层级清楚、主体完整，严格遵守给定概念、关系、步骤和学习者年龄范围；不得擅自增加事实、标签或结论。',
    includesStructuredText
      ? '图片中的中文必须逐字准确、清晰可读；若空间不足，应减少装饰或次要说明，不得生成错别字、乱码或含义不明的标签。'
      : '除非教学内容明确要求，否则不要在图片中添加文字、字母、数字、标志或水印。',
    '画面应适合真实课堂投影，具有明确视觉焦点、充足留白和清晰对比。',
  ].filter(Boolean).join('\n');
}

export async function validateGeneratedCourseImage(
  buffer: Buffer,
  aspectRatio = '16:9',
): Promise<{ extension: 'png' | 'jpg' | 'webp'; width: number; height: number }> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (error) {
    throw Object.assign(new Error('图片生成结果不是可解析的有效图片', { cause: error }), {
      code: 'GENERATED_IMAGE_INVALID',
      isRetryable: true,
    });
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1 || Math.min(width, height) < 512) {
    throw Object.assign(new Error(`图片生成结果分辨率不足：${width}×${height}`), {
      code: 'GENERATED_IMAGE_TOO_SMALL',
      isRetryable: true,
    });
  }
  const expected = resolveCourseImageDimensions(aspectRatio);
  const expectedRatio = expected.width / expected.height;
  const actualRatio = width / height;
  if (Math.abs(actualRatio - expectedRatio) / expectedRatio > 0.08) {
    throw Object.assign(new Error(
      `图片生成结果比例不符合 ${aspectRatio} 要求：${width}×${height}`,
    ), {
      code: 'GENERATED_IMAGE_ASPECT_RATIO_MISMATCH',
      isRetryable: true,
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
      isRetryable: true,
    });
  }
  return { extension, width, height };
}

type GeneratedImageQualityReview = {
  pass?: boolean;
  issues?: unknown;
};

function qwenImageReviewEndpoint(baseUrl?: string): string {
  const normalized = !baseUrl || baseUrl.includes('/compatible-mode') || baseUrl.includes('maas.aliyuncs')
    ? 'https://dashscope.aliyuncs.com'
    : baseUrl.replace(/\/$/, '');
  return `${normalized}/compatible-mode/v1/chat/completions`;
}

/**
 * Qwen Image shares its credential with DashScope's vision model. Use that
 * model as a second, independent gate for Chinese text, factual relationships,
 * and instructional relevance before the generated file is accepted.
 */
export async function reviewGeneratedCourseImage(input: {
  buffer: Buffer;
  providerId: ImageProviderId;
  apiKey: string;
  baseUrl?: string;
  requirement: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.providerId !== 'qwen-image') return;
  const reviewImage = await sharp(input.buffer)
    .resize({ width: 960, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const timeoutSignal = AbortSignal.timeout(60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(qwenImageReviewEndpoint(input.baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENPBL_QWEN_IMAGE_REVIEW_MODEL || 'qwen3-vl-plus',
      messages: [
        {
          role: 'system',
          content: '你是严格但遵循给定教学意图的中文课程图片审校员。只根据明确要求检查，不自行添加未要求的对应关系。',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${reviewImage.toString('base64')}` },
            },
            {
              type: 'text',
              text: [
                `原始教学配图要求：${input.requirement}`,
                '请检查：一、所有可见文字是否有错别字、乱码或截断；若要求明确禁止文字，则出现任何可辨认字符、伪文字或标签都必须判定不通过；二、核心概念、步骤、顺序和关系是否与要求一致；三、是否出现要求之外且会误导学习者的事实；四、构图是否清晰并适合课堂投影。',
                '仅输出 JSON：{"pass":boolean,"issues":["具体问题"]}。只有全部合格时 pass 才能为 true。',
              ].join('\n'),
            },
          ],
        },
      ],
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw Object.assign(new Error(`教学图片质量审校服务失败（${response.status}）：${detail}`), {
      code: 'GENERATED_IMAGE_REVIEW_FAILED',
      statusCode: response.status,
      isRetryable: response.status === 429 || response.status >= 500,
    });
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  const review = content ? parseJsonResponse<GeneratedImageQualityReview>(content) : null;
  const issues = Array.isArray(review?.issues)
    ? review.issues.filter((issue): issue is string => typeof issue === 'string' && issue.trim().length > 0)
    : [];
  if (review?.pass !== true) {
    throw Object.assign(new Error(
      `教学图片质量审校未通过${issues.length > 0 ? `：${issues.join('；')}` : ''}`,
    ), {
      code: 'GENERATED_IMAGE_QUALITY_REJECTED',
      isRetryable: true,
    });
  }
}

export async function persistGeneratedClassroomImage(input: {
  result: ImageGenerationResult;
  classroomId: string;
  elementId: string;
  aspectRatio?: string;
  baseUrl: string;
  signal?: AbortSignal;
  qualityReview?: {
    providerId: ImageProviderId;
    apiKey: string;
    baseUrl?: string;
    requirement: string;
  };
}): Promise<string> {
  throwIfAborted(input.signal);
  const buffer = input.result.base64
    ? Buffer.from(input.result.base64, 'base64')
    : input.result.url
      ? await downloadToBuffer(input.result.url, input.signal)
      : null;
  if (!buffer?.length) {
    throw Object.assign(new Error('图片生成服务未返回可用的图片文件'), {
      code: 'GENERATED_IMAGE_EMPTY',
      isRetryable: true,
    });
  }
  const validated = await validateGeneratedCourseImage(buffer, input.aspectRatio);
  if (input.qualityReview) {
    await reviewGeneratedCourseImage({
      buffer,
      signal: input.signal,
      ...input.qualityReview,
    });
  }
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

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  capabilities: { image: boolean; video: boolean },
  signal?: AbortSignal,
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

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        throwIfAborted(signal);
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
        await withGenerationRetry(async () => {
          const result = await waitForProviderSlot(providerId, signal, () => generateImage(
            { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
            {
              prompt: buildInstructionalImagePrompt(req),
              aspectRatio,
              ...dimensions,
              style: req.style,
              negativePrompt: 'watermark, logo, irrelevant decoration, illegible text, garbled Chinese characters, factual errors, cropped content, cluttered layout',
            },
          ));
          throwIfAborted(signal);
          mediaMap[req.elementId] = await persistGeneratedClassroomImage({
            result,
            classroomId,
            elementId: req.elementId,
            aspectRatio,
            baseUrl,
            signal,
            qualityReview: {
              providerId,
              apiKey,
              baseUrl: resolveImageBaseUrl(providerId),
              requirement: req.prompt,
            },
          });
          log.info(`Generated and validated image: ${req.elementId}`);
        }, {
          label: `image ${req.elementId}`,
          signal,
          // Network retries for the same generated URL happen inside
          // downloadToBuffer. Provider retries regenerate only after that URL
          // is genuinely unusable or expired.
          maxRetries: providerId === 'qwen-image' ? 2 : 2,
          baseDelayMs: providerId === 'qwen-image' ? 10_000 : 1_000,
          maxDelayMs: providerId === 'qwen-image' ? 60_000 : 16_000,
          onRetry: ({ attempt, maxAttempts, nextDelayMs, reason }) => {
            log.warn(
              `Retrying image ${req.elementId} [provider=${providerId}, attempt=${attempt + 1}/${maxAttempts}, waitMs=${nextDelayMs}, reason=${reason}]`,
            );
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn(`Image generation failed for ${req.elementId}:`, err);
        failures.push({ elementId: req.elementId, type: 'image', error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        throwIfAborted(signal);
        const providerId = videoProviderIds[0] as VideoProviderId;
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
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        await withGenerationRetry(async () => {
          const result = await generateVideo(
            { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
            normalized,
          );
          throwIfAborted(signal);
          const buf = await downloadToBuffer(result.url, signal);
          throwIfAborted(signal);
          const filename = `${req.elementId}.mp4`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
          log.info(`Generated video: ${filename}`);
        }, { label: `video ${req.elementId}`, signal, maxRetries: 1 });
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn(`Video generation failed for ${req.elementId}:`, err);
        failures.push({ elementId: req.elementId, type: 'video', error: err instanceof Error ? err.message : String(err) });
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
        (!el.src || isMediaPlaceholder(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src)
      ) {
        const exactUrl = mediaMap[el.src];
        if (exactUrl) {
          el.src = exactUrl;
          continue;
        }

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
          return !element.src || isMediaPlaceholder(element.src);
        }
        if (typeof element.src !== 'string' || !isMediaPlaceholder(element.src)) return false;
        return element.src === request.elementId || sameTypeRequests.length === 1;
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

function resolveServerTTSRuntimes(providerIds: string[]): ServerTTSRuntime[] {
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
        modelId: resolveTTSModel(providerId, defaultModel) || defaultModel,
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
  const requestedModelIsForSelectedProvider = Boolean(
    options.modelId && (!options.providerId || options.providerId === providerId),
  );
  const requestedVoiceIsForSelectedProvider = Boolean(
    options.voiceId && (!options.providerId || options.providerId === providerId),
  );
  const modelId = runtime?.modelId ?? options.modelId ?? '';
  const voiceId = requestedVoiceIsForSelectedProvider
    ? options.voiceId!
    : runtime?.voice ?? options.voiceId ?? 'default';
  resolveTTSTimingCalibration(providerId, modelId, voiceId);
  const profile = getTtsTimingProfile(
    providerId,
    requestedModelIsForSelectedProvider ? options.modelId : modelId,
    voiceId,
  );
  return {
    providerId: profile.providerId,
    modelId: profile.modelId,
    voiceId,
    speed: 1,
    language: options.language || 'zh-CN',
  };
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

  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Resolve TTS provider (exclude browser-native-tts and operator force-disabled
  // providers — server precedence, #665).
  const ttsProviderIds = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
  if (ttsProviderIds.length === 0) {
    log.warn('No server TTS provider configured, skipping TTS generation');
    return;
  }

  const runtimes = resolveServerTTSRuntimes(ttsProviderIds);
  if (runtimes.length === 0) {
    log.warn('No usable server TTS provider configured, skipping TTS generation');
    return;
  }
  const preferredRuntimeIndex = timingOptions.providerId
    ? runtimes.findIndex((runtime) => runtime.providerId === timingOptions.providerId)
    : 0;
  if (preferredRuntimeIndex > 0) {
    const [preferred] = runtimes.splice(preferredRuntimeIndex, 1);
    if (preferred) runtimes.unshift(preferred);
  }
  const selectedRuntime = runtimes[0];
  const splitProviderId = selectedRuntime.providerId;
  const speechTasks: Array<{
    speechAction: SpeechAction;
    actionId: string;
    audioId: string;
  }> = [];

  // Prepare all scene actions before starting requests. This keeps action
  // splitting and duration allocation deterministic, while the actual TTS
  // calls below can run concurrently without mutating the same action twice.
  for (const scene of eligibleScenes) {
    throwIfAborted(signal);
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    scene.actions = splitLongSpeechActions(scene.actions, splitProviderId);
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
      speechTasks.push({ speechAction, actionId: action.id, audioId });
    }
  }

  if (speechTasks.length === 0) return;

  // A fallback provider may have a lower quota than the preferred provider.
  // Use the strictest configured limit so a provider switch never creates a
  // burst larger than one of the possible runtimes can handle.
  const concurrency = Math.min(
    speechTasks.length,
    ...runtimes.map((runtime) => getTtsConcurrencyLimit(runtime.providerId)),
  );
  log.info(
    `Generating TTS with bounded concurrency [classroomId=${classroomId}, segments=${speechTasks.length}, concurrency=${concurrency}]`,
  );

  const outcomes = await mapWithConcurrency(speechTasks, concurrency, async (task) => {
    try {
      await withGenerationRetry(async () => {
        throwIfAborted(signal);
        for (const runtime of runtimes) {
          try {
            const result = await runWithGlobalTtsProviderSlot(
              runtime.providerId,
              getTtsConcurrencyLimit(runtime.providerId),
              () => generateTTS(
                {
                  providerId: runtime.providerId,
                  modelId:
                    runtime.providerId === selectedRuntime.providerId && timingOptions.modelId
                      ? timingOptions.modelId
                      : runtime.modelId,
                  apiKey: runtime.apiKey,
                  baseUrl: runtime.baseUrl,
                  voice:
                    runtime.providerId === selectedRuntime.providerId
                      ? timingOptions.voiceId || runtime.voice
                      : runtime.voice,
                  speed: 1,
                },
                task.speechAction.text,
              ),
              signal,
            );
            throwIfAborted(signal);
            const filename = `${task.audioId}.${result.format || runtime.format}`;
            await fs.writeFile(path.join(audioDir, filename), result.audio);
            task.speechAction.audioId = task.audioId;
            task.speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
            log.info(
              `Generated TTS via ${runtime.providerId}: ${filename} (${result.audio.length} bytes)`,
            );
            return;
          } catch (err) {
            if (signal?.aborted) throw err;
            log.warn(`TTS provider "${runtime.providerId}" failed for action ${task.actionId}:`, err);
          }
        }
        throw new TtsSegmentGenerationError(task.actionId);
      }, {
        label: `tts action ${task.actionId}`,
        maxRetries: TTS_SEGMENT_RETRIES,
        signal,
      });
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      log.warn(`TTS generation remained incomplete for action ${task.actionId}`, error);
      return false;
    }
  });

  const failedActionIds = speechTasks.flatMap((task, index) => outcomes[index] ? [] : [task.actionId]);
  if (failedActionIds.length > 0) {
    const error = new Error(
      `课堂语音仍有 ${failedActionIds.length} 段未生成：${failedActionIds.join(', ')}`,
    ) as Error & { isRetryable: boolean };
    error.name = 'ClassroomTtsIncompleteError';
    error.isRetryable = true;
    throw error;
  }
}
