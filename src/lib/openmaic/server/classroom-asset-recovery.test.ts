// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistedClassroomData } from './classroom-storage';
import {
  classroomAudioStoragePath,
  classroomTtsTimingOptions,
  planClassroomTtsRecovery,
} from './classroom-asset-recovery';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function classroom(actions: Array<Record<string, unknown>>): PersistedClassroomData {
  return {
    id: 'lesson-1',
    createdAt: '2026-09-11T00:00:00.000Z',
    stage: { id: 'lesson-1', name: '恢复课', createdAt: 1, updatedAt: 1 },
    scenes: [{
      id: 'scene-1', stageId: 'lesson-1', title: '讲解', type: 'slide', order: 0,
      content: { type: 'slide', elements: [] },
      actions,
      timingPlan: { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Ethan', language: 'zh-CN' },
    } as never],
  };
}

describe('classroom TTS recovery planning', () => {
  it('clears only a missing generated clip and keeps existing or external audio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-tts-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'lesson-1', 'audio'), { recursive: true });
    await writeFile(path.join(root, 'lesson-1', 'audio', 'present.wav'), 'audio');
    const data = classroom([
      { id: 'missing', type: 'speech', text: '需要恢复', audioId: 'old', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/missing.wav' },
      { id: 'present', type: 'speech', text: '已经存在', audioId: 'present', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/present.wav' },
      { id: 'external', type: 'speech', text: '外部音频', audioUrl: 'https://cdn.example/narration.mp3' },
    ]);

    const plan = await planClassroomTtsRecovery(data, root);
    expect(plan.missingActionIds).toEqual(['missing']);
    expect(plan.unrecoverableActionIds).toEqual([]);
    expect(plan.classroom.scenes[0]?.actions?.[0]).toMatchObject({ id: 'missing', text: '需要恢复' });
    expect(plan.classroom.scenes[0]?.actions?.[0]).not.toHaveProperty('audioUrl');
    expect(plan.classroom.scenes[0]?.actions?.[1]).toHaveProperty('audioUrl');
    expect(plan.classroom.scenes[0]?.actions?.[2]).toHaveProperty('audioUrl');
    expect(data.scenes[0]?.actions?.[0]).toHaveProperty('audioUrl');
  });

  it('reports a missing local clip without source text as unrecoverable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-tts-recovery-'));
    roots.push(root);
    const plan = await planClassroomTtsRecovery(classroom([
      { id: 'no-script', type: 'speech', text: '', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/no-script.wav' },
    ]), root);
    expect(plan.missingActionIds).toEqual([]);
    expect(plan.unrecoverableActionIds).toEqual(['no-script']);
  });

  it('rejects traversal paths and restores timing metadata from the script', () => {
    expect(classroomAudioStoragePath('/data/classrooms', '/api/openmaic/classroom-media/lesson-1/audio/..')).toBeNull();
    expect(classroomTtsTimingOptions(classroom([]).scenes)).toMatchObject({
      providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Ethan', language: 'zh-CN',
    });
  });
});
