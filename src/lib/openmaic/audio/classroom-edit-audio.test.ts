// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';

const mocks = vi.hoisted(() => ({ getAudio: vi.fn() }));
vi.mock('@openmaic/lib/utils/database', () => ({ db: { audioFiles: { get: mocks.getAudio } } }));

import { collectClassroomAudioUploads } from './classroom-edit-audio';

const scene: Scene = {
  id: 's1', stageId: 'c1', type: 'slide', title: '页面', order: 0,
  content: { type: 'slide', canvas: {
    id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625,
    theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
  } },
  actions: [{ id: 'speech', type: 'speech', text: '新讲稿', audioId: 'local-1' }],
};

beforeEach(() => vi.clearAllMocks());

describe('collect classroom narration uploads', () => {
  it('uploads the audio bytes with the narration they were synthesized from', async () => {
    mocks.getAudio.mockResolvedValue({ id: 'local-1', text: '新讲稿', format: 'wav', blob: new Blob(['RIFF-audio']) });
    expect(await collectClassroomAudioUploads([scene])).toEqual([{
      sceneId: 's1', actionId: 'speech', text: '新讲稿', audioId: 'local-1', format: 'wav',
      base64: Buffer.from('RIFF-audio').toString('base64'),
    }]);
  });

  it('skips cached audio for older text after a synthesis/edit race', async () => {
    mocks.getAudio.mockResolvedValue({ id: 'local-1', text: '旧讲稿', format: 'wav', blob: new Blob(['old-audio']) });
    expect(await collectClassroomAudioUploads([scene])).toEqual([]);
  });
});
