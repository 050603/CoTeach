import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { VideoProviderId } from '@openmaic/lib/media/types';
import { normalizeVideoOptions, VIDEO_PROVIDERS } from '@openmaic/lib/media/video-providers';

function timingFailure(message: string): Error {
  return Object.assign(new Error(message), { isRetryable: false });
}

/** Resolve once, before narration: rendering and synthesis share this persisted request. */
export function prepareVideoTimingRequests(outline: SceneOutline, providerId?: VideoProviderId): {
  outline: SceneOutline;
  videoSec: number;
} {
  let videoSec = 0;
  const mediaGenerations = outline.mediaGenerations?.map((request) => {
    if (request.type !== 'video') return request;
    const selectedProvider = request.videoProviderId ?? providerId;
    if (!selectedProvider || !VIDEO_PROVIDERS[selectedProvider]) {
      throw timingFailure(`视频前置时长计算失败：${outline.id}/${request.elementId} 未配置可用的视频供应商`);
    }
    if (request.duration !== undefined && (!Number.isFinite(request.duration) || request.duration <= 0)) {
      throw timingFailure(`视频前置时长计算失败：${request.elementId} 的时长必须为正数`);
    }
    const normalized = normalizeVideoOptions(selectedProvider, {
      prompt: request.prompt, aspectRatio: request.aspectRatio, duration: request.duration,
    });
    const duration = normalized.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      throw timingFailure(`视频前置时长计算失败：${selectedProvider} 没有可计算的默认视频时长`);
    }
    videoSec += duration;
    return {
      ...request, duration, videoProviderId: selectedProvider,
      durationSource: request.durationSource ?? (duration === request.duration ? 'requested' as const : 'provider-default' as const),
    };
  });
  return { outline: mediaGenerations ? { ...outline, mediaGenerations } : outline, videoSec };
}
