import { IMAGE_PROVIDERS } from '@openmaic/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@openmaic/lib/media/video-providers';
import type { ImageProviderId, VideoProviderId } from '@openmaic/lib/media/types';
import {
  getServerImageProviders,
  getServerVideoProviders,
  resolveImageApiKey,
  resolveVideoApiKey,
} from '@openmaic/lib/server/provider-config';

export const IMAGE_PROVIDER_NOT_CONFIGURED = 'IMAGE_PROVIDER_NOT_CONFIGURED';
export const VIDEO_PROVIDER_NOT_CONFIGURED = 'VIDEO_PROVIDER_NOT_CONFIGURED';

export function hasUsableServerImageProvider(): boolean {
  return Object.entries(getServerImageProviders()).some(([id, metadata]) => {
    const providerId = id as ImageProviderId;
    const provider = IMAGE_PROVIDERS[providerId];
    return Boolean(
      provider
      && !metadata.disabled
      && (!provider.requiresApiKey || resolveImageApiKey(providerId)),
    );
  });
}

export function hasUsableServerVideoProvider(): boolean {
  return Object.entries(getServerVideoProviders()).some(([id, metadata]) => {
    const providerId = id as VideoProviderId;
    const provider = VIDEO_PROVIDERS[providerId];
    return Boolean(
      provider
      && !metadata.disabled
      && (!provider.requiresApiKey || resolveVideoApiKey(providerId)),
    );
  });
}

function configurationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, isRetryable: false });
}

export function classroomMediaConfigurationErrorResponse(error: unknown): {
  code: string;
  message: string;
} | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (code !== IMAGE_PROVIDER_NOT_CONFIGURED && code !== VIDEO_PROVIDER_NOT_CONFIGURED) return null;
  return {
    code,
    message: error instanceof Error ? error.message : '课程媒体生成服务尚未配置。',
  };
}

/** Fail before page generation instead of silently producing a lower-quality course. */
export function assertRequestedClassroomMediaProviders(input: {
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
}): void {
  if (input.enableImageGeneration && !hasUsableServerImageProvider()) {
    throw configurationError(
      IMAGE_PROVIDER_NOT_CONFIGURED,
      '课程已开启图片生成，但服务器没有可用的图片生成服务。请先在教师设置的“图像生成”中保存并测试一个提供方，然后继续生成。',
    );
  }
  if (input.enableVideoGeneration && !hasUsableServerVideoProvider()) {
    throw configurationError(
      VIDEO_PROVIDER_NOT_CONFIGURED,
      '课程已开启视频生成，但服务器没有可用的视频生成服务。请先在教师设置的“视频生成”中保存并测试一个提供方，然后继续生成。',
    );
  }
}
