import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import type { ClassroomAssetGenerationInput } from './classroom-asset-generation';

const mocks = vi.hoisted(() => ({ media: vi.fn(), tts: vi.fn(), persist: vi.fn(), status: vi.fn() }));
vi.mock('./classroom-storage', async (original) => ({
  ...await original<typeof import('./classroom-storage')>(),
  updatePersistedClassroomScenes: mocks.persist,
  updatePersistedClassroomAssetStatus: mocks.status,
}));
vi.mock('./classroom-media-readiness', () => ({ assertRequestedClassroomMediaProviders: vi.fn() }));
vi.mock('./classroom-media-generation', async (original) => ({
  ...await original<typeof import('./classroom-media-generation')>(),
  generateMediaForClassroom: mocks.media,
  generateTTSForClassroom: mocks.tts,
}));
import { generateClassroomAssets } from './classroom-asset-generation';

function input(): ClassroomAssetGenerationInput {
  return {
    outlines: [{ id: 'page', type: 'slide', title: 'Page', description: '', keyPoints: [], order: 0,
      mediaGenerations: [{ type: 'image', elementId: 'gen_img_1', prompt: 'A concrete example' }] }],
    baseUrl: '', studentClassroomId: 'lesson',
    studentScenes: [{ id: 'scene', outlineId: 'page', type: 'slide', title: 'Page', order: 0,
      content: { type: 'slide', canvas: { elements: [{ id: 'image', type: 'image', src: 'gen_img_1' }] } },
      actions: [{ id: 'speech', type: 'speech', text: 'Observe the example.' }] } as Scene],
    enableImageGeneration: true, enableVideoGeneration: false, enableTTS: true,
    isPblCourse: false, ttsTimingSelection: { providerId: 'qwen-tts' } as ClassroomAssetGenerationInput['ttsTimingSelection'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue(undefined);
  mocks.media.mockResolvedValue({ mediaMap: { gen_img_1: '/image.png' }, failures: [] });
  mocks.tts.mockResolvedValue(undefined);
});

describe('durable classroom asset completion', () => {
  it('does not expose completed after images finish while speech is still running', async () => {
    let finishSpeech!: () => void;
    mocks.tts.mockImplementation(() => new Promise<void>((resolve) => { finishSpeech = resolve; }));
    const task = generateClassroomAssets(input());
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalled());
    expect(mocks.status.mock.calls.every(([, state]) => state.status !== 'completed')).toBe(true);
    finishSpeech();
    await task;
    expect(mocks.status.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'completed', requested: 2, completed: 2 });
  });

  it('persists a speech failure even when image generation succeeds', async () => {
    mocks.tts.mockRejectedValue(new Error('one audio segment failed'));
    await expect(generateClassroomAssets(input())).rejects.toThrow('incomplete');
    expect(mocks.persist).toHaveBeenCalled();
    expect(mocks.status.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'partial-failure', failures: [expect.objectContaining({ type: 'tts' })],
    });
    expect(mocks.status.mock.calls.some(([, state]) => state.status === 'completed')).toBe(false);
  });

  it('rejects unfinished required images instead of creating a completed asset checkpoint', async () => {
    mocks.media.mockResolvedValue({ mediaMap: {}, failures: [{ elementId: 'gen_img_1', type: 'image', error: 'download failed' }] });
    await expect(generateClassroomAssets(input())).rejects.toThrow('未完成');
    expect(mocks.status.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'partial-failure' });
  });
});
