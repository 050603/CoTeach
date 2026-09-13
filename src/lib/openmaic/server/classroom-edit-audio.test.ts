// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scene } from '@openmaic/lib/types/stage';
import { CLASSROOMS_DIR } from './classroom-storage';
import { prepareClassroomEdit } from './classroom-edit';
import { persistClassroomAudioUploads, prepareClassroomAudioUploads } from './classroom-edit-audio';

const stage = { id: 'c1', name: '课堂', createdAt: 1, updatedAt: 1 };
const before = {
  id: 's1', stageId: 'c1', order: 0, title: '页面', type: 'slide',
  content: { type: 'slide', canvas: {
    id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625,
    theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
  } },
  actions: [{ id: 'a1', type: 'speech', text: '旧讲稿', audioId: 'old', audioUrl: '/old.wav' }],
} as Scene;
const edited = {
  ...before,
  actions: [{ id: 'a1', type: 'speech', text: '新讲稿', audioId: 'local-audio' }],
} as Scene;
const upload = {
  sceneId: 's1', actionId: 'a1', text: '新讲稿', audioId: 'local-audio', format: 'wav',
  base64: Buffer.from('RIFF-test-audio').toString('base64'),
};
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((id) => fs.rm(path.join(CLASSROOMS_DIR, id), { recursive: true, force: true })));
});

describe('classroom narration audio persistence', () => {
  it('persists regenerated speech after invalidating the old narration', async () => {
    const classroomId = `test-edit-audio-${randomUUID()}`;
    created.push(classroomId);
    const prepared = prepareClassroomEdit({
      existing: { id: 'c1', stage, scenes: [before], createdAt: '2026-09-12' },
      stage, scenes: [edited], targetClassroomId: classroomId,
    });
    const result = prepareClassroomAudioUploads({
      uploads: [upload], submittedScenes: [edited], scenes: prepared.scenes, classroomId,
    });
    await persistClassroomAudioUploads(classroomId, result.files);
    const speech = result.scenes[0].actions?.[0];
    expect(speech).toMatchObject({ type: 'speech', text: '新讲稿', audioUrl: expect.stringContaining(`/classroom-media/${classroomId}/audio/`) });
    expect(await fs.readFile(path.join(CLASSROOMS_DIR, classroomId, 'audio', result.files[0].filename))).toEqual(Buffer.from('RIFF-test-audio'));
  });

  it('rejects a late synthesis result for an earlier version of the text', () => {
    expect(() => prepareClassroomAudioUploads({
      uploads: [{ ...upload, text: '旧讲稿' }], submittedScenes: [edited], scenes: [edited], classroomId: 'c1',
    })).toThrow('语音与当前讲稿不匹配');
  });

  it('never saves an IndexedDB-only audio id as a shared classroom asset', () => {
    const result = prepareClassroomAudioUploads({ submittedScenes: [edited], scenes: [edited], classroomId: 'c1', uploads: [] });
    expect(result.scenes[0].actions?.[0]).not.toHaveProperty('audioId');
    expect(result.files).toEqual([]);
  });
});
