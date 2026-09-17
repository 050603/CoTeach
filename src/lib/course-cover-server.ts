import { randomInt } from "node:crypto";
import {
  generateImage,
  IMAGE_PROVIDERS,
} from "@openmaic/lib/media/image-providers";
import type { ImageProviderId } from "@openmaic/lib/media/types";
import {
  getServerImageProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
} from "@openmaic/lib/server/provider-config";
import {
  buildCourseCoverPrompt,
  COURSE_COVER_GENERATION_SPEC,
  type CourseCoverContext,
} from "@/lib/course-cover";
import {
  normalizeCourseImageToAspectRatio,
  persistGeneratedClassroomImage,
} from "@openmaic/lib/server/classroom-media-generation";
import { planCourseCoverImageOnServer } from "./course-cover-planner-server";

export const MAX_COURSE_COVER_UPLOAD_BYTES = 10 * 1024 * 1024;

export class CourseCoverProviderUnavailableError extends Error {
  readonly code = "COURSE_COVER_PROVIDER_UNAVAILABLE";

  constructor() {
    super("尚未配置可用的图片生成服务");
    this.name = "CourseCoverProviderUnavailableError";
  }
}

export class CourseCoverUploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CourseCoverUploadError";
  }
}

export class CourseCoverGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "CourseCoverGenerationError";
  }
}

function isImageProviderId(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, value);
}

export function resolveServerCourseCoverProvider(): {
  providerId: ImageProviderId;
  apiKey: string;
  baseUrl?: string;
  model?: string;
} {
  const configured = getServerImageProviders();
  for (const [providerId, metadata] of Object.entries(configured)) {
    if (!isImageProviderId(providerId) || metadata.disabled) continue;
    const apiKey = resolveImageApiKey(providerId);
    if (IMAGE_PROVIDERS[providerId].requiresApiKey && !apiKey) continue;
    return {
      providerId,
      apiKey,
      baseUrl: resolveImageBaseUrl(providerId),
      model: metadata.defaultModel || IMAGE_PROVIDERS[providerId].models[0]?.id,
    };
  }
  throw new CourseCoverProviderUnavailableError();
}

function generationSpecForProvider(config: { providerId: ImageProviderId; model?: string }) {
  if (config.providerId === "openai-image") {
    return { ...COURSE_COVER_GENERATION_SPEC, width: 1536, height: 1024 };
  }
  if (
    config.providerId === "qwen-image"
    && /^qwen-image-3\.0(?:-|$)/.test(config.model ?? "")
  ) {
    return { ...COURSE_COVER_GENERATION_SPEC, width: 2688, height: 1536 };
  }
  return COURSE_COVER_GENERATION_SPEC;
}

function courseCoverGenerationError(error: unknown): CourseCoverGenerationError {
  const message = error instanceof Error ? error.message : String(error);
  const code = coverErrorCode(error);
  const stageErrors: Record<string, [string, number]> = {
    COURSE_COVER_PLAN_UNAVAILABLE: ["封面内容策划需要文本模型，请先在教师设置中配置可用的文本模型", 503],
    COURSE_COVER_PLAN_FAILED: ["封面内容策划未完成，请重试；本次尚未生成图片", 502],
    COURSE_COVER_PLAN_INVALID: ["封面画面方案未通过校验，请重新生成", 502],
  };
  if (code && stageErrors[code]) {
    const [userMessage, status] = stageErrors[code];
    return new CourseCoverGenerationError(code, userMessage, status, error);
  }
  if (/generated resource download failed/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_DOWNLOAD_FAILED",
      "图片已经生成，但服务器无法下载生成结果；请检查部署网络或媒体代理配置后重试",
      502,
      error,
    );
  }
  if (/generated image.*(?:invalid|empty|too small|aspect ratio|format)|图片生成结果/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_RESULT_INVALID",
      "图片服务返回的文件无效，请重新生成或上传本地图片",
      502,
      error,
    );
  }
  if (/\b429\b|rate.?limit|too many requests|Throttling/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_RATE_LIMITED",
      "图片服务当前请求较多，请稍后再试；也可以直接上传本地图片",
      429,
      error,
    );
  }
  if (/\b401\b|unauthorized|invalid api.?key|authentication/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_CREDENTIAL_INVALID",
      "图片服务凭据无效，请在教师设置中检查图片模型配置",
      503,
      error,
    );
  }
  if (/\b403\b|forbidden|permission/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_PERMISSION_DENIED",
      "图片服务拒绝了当前请求，请检查模型权限或地区配置",
      503,
      error,
    );
  }
  if (/\b400\b|\b404\b|invalid.*(?:size|model)|model.*not found|not.*support/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_MODEL_INCOMPATIBLE",
      "当前图片模型配置不兼容，请在教师设置中重新选择可用的图片模型",
      503,
      error,
    );
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return new CourseCoverGenerationError(
      "COURSE_COVER_TIMEOUT",
      "图片生成超时，请重试或改用本地图片",
      504,
      error,
    );
  }
  return new CourseCoverGenerationError(
    "COURSE_COVER_GENERATION_FAILED",
    "图片生成失败，请重试或上传本地图片",
    502,
    error,
  );
}

function coverErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function persistUploadedCourseCover(
  file: File,
  classroomId: string,
  elementId: string,
): Promise<string> {
  if (!file.size) {
    throw new CourseCoverUploadError("EMPTY_FILE", "请选择非空的封面图片", 400);
  }
  if (file.size > MAX_COURSE_COVER_UPLOAD_BYTES) {
    throw new CourseCoverUploadError("FILE_TOO_LARGE", "封面图片不能超过 10 MB", 413);
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new CourseCoverUploadError(
      "UNSUPPORTED_IMAGE_TYPE",
      "封面仅支持 PNG、JPG 或 WebP 图片",
      415,
    );
  }

  const source = Buffer.from(await file.arrayBuffer());
  let normalized: Buffer;
  try {
    normalized = await normalizeCourseImageToAspectRatio(
      source,
      COURSE_COVER_GENERATION_SPEC.aspectRatio,
    );
  } catch {
    throw new CourseCoverUploadError(
      "INVALID_COVER_IMAGE",
      "图片无法读取，请重新选择有效的 PNG、JPG 或 WebP 文件",
      422,
    );
  }
  return persistGeneratedClassroomImage({
    result: {
      base64: normalized.toString("base64"),
      width: COURSE_COVER_GENERATION_SPEC.width,
      height: COURSE_COVER_GENERATION_SPEC.height,
    },
    classroomId,
    elementId,
    aspectRatio: COURSE_COVER_GENERATION_SPEC.aspectRatio,
    baseUrl: "",
  });
}

/**
 * Background workers have no teacher browser cookie. Calling the protected
 * Next API over HTTP therefore returns 401 when auth is enabled. Generate via
 * the same server-managed provider directly instead.
 */
export async function generateCourseCoverImageOnServer(
  course: CourseCoverContext,
  classroomId: string,
  signal?: AbortSignal,
  elementId = "course-cover",
): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const config = resolveServerCourseCoverProvider();
  const pipelineSignal = AbortSignal.any([AbortSignal.timeout(270_000), ...(signal ? [signal] : [])]);
  try {
    const plan = await planCourseCoverImageOnServer(course, pipelineSignal);
    const prompt = buildCourseCoverPrompt(plan);
    pipelineSignal.throwIfAborted();
    const result = await generateImage(config, {
      prompt,
      ...generationSpecForProvider(config),
      seed: randomInt(0, 2_147_483_648),
      signal: pipelineSignal,
    });
    return await persistGeneratedClassroomImage({
      result, classroomId, elementId,
      aspectRatio: COURSE_COVER_GENERATION_SPEC.aspectRatio,
      baseUrl: "", signal: pipelineSignal, normalizeToAspectRatio: true,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (pipelineSignal.aborted) throw courseCoverGenerationError(pipelineSignal.reason);
    throw courseCoverGenerationError(error);
  }
}
