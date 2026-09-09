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
import { persistGeneratedClassroomImage } from "@openmaic/lib/server/classroom-media-generation";
import { withGenerationRetry } from "@openmaic/lib/generation/generation-retry";

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
  throw new Error("没有可用的服务端图片生成提供方");
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
  const prompt = buildCourseCoverPrompt(course);
  return withGenerationRetry(async () => {
    const result = await generateImage(config, {
      prompt,
      ...COURSE_COVER_GENERATION_SPEC,
    });
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return persistGeneratedClassroomImage({
      result,
      classroomId,
      elementId,
      aspectRatio: COURSE_COVER_GENERATION_SPEC.aspectRatio,
      baseUrl: "",
      signal,
      qualityReview: {
        providerId: config.providerId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        requirement: prompt,
      },
    });
  }, {
    label: `course cover ${classroomId}`,
    signal,
    maxRetries: 2,
    baseDelayMs: 5_000,
    maxDelayMs: 20_000,
  });
}
