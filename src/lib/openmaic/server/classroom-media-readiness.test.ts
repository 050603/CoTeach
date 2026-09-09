import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  images: vi.fn(),
  videos: vi.fn(),
  imageKey: vi.fn(),
  videoKey: vi.fn(),
}));

vi.mock('@openmaic/lib/server/provider-config', () => ({
  getServerImageProviders: mocks.images,
  getServerVideoProviders: mocks.videos,
  resolveImageApiKey: mocks.imageKey,
  resolveVideoApiKey: mocks.videoKey,
}));

import {
  assertRequestedClassroomMediaProviders,
  classroomMediaConfigurationErrorResponse,
  hasUsableServerImageProvider,
} from './classroom-media-readiness';

describe('classroom media provider readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.images.mockReturnValue({});
    mocks.videos.mockReturnValue({});
    mocks.imageKey.mockReturnValue('');
    mocks.videoKey.mockReturnValue('');
  });

  it('rejects an enabled image option when no image provider is configured', () => {
    let thrown: unknown;
    try {
      assertRequestedClassroomMediaProviders({ enableImageGeneration: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'IMAGE_PROVIDER_NOT_CONFIGURED' });
    expect(classroomMediaConfigurationErrorResponse(thrown)).toMatchObject({
      code: 'IMAGE_PROVIDER_NOT_CONFIGURED',
      message: expect.stringContaining('课程已开启图片生成'),
    });
  });

  it('accepts a configured image provider with a server credential', () => {
    mocks.images.mockReturnValue({ 'qwen-image': { defaultModel: 'qwen-image-2.0-pro' } });
    mocks.imageKey.mockReturnValue('server-key');

    expect(hasUsableServerImageProvider()).toBe(true);
    expect(() => assertRequestedClassroomMediaProviders({
      enableImageGeneration: true,
    })).not.toThrow();
  });

  it('does not treat an unknown provider record as usable', () => {
    mocks.images.mockReturnValue({ unknown: { defaultModel: 'unknown' } });
    mocks.imageKey.mockReturnValue('server-key');

    expect(hasUsableServerImageProvider()).toBe(false);
  });
});
