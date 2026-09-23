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

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  ascii(0, 'RIFF'); view.setUint32(4, 40, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true); view.setUint32(28, 8_000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true); ascii(36, 'data');
  view.setUint32(40, 4, true); bytes.set([128, 128, 128, 128], 44);
  return bytes;
}

describe('classroom TTS recovery planning', () => {
  it('clears only a missing generated clip and keeps existing or external audio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-tts-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'lesson-1', 'audio'), { recursive: true });
    await writeFile(path.join(root, 'lesson-1', 'audio', 'present:clip.wav'), wavBytes());
    const data = classroom([
      { id: 'missing', type: 'speech', text: '需要恢复', audioId: 'old', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/missing.wav' },
      { id: 'present', type: 'speech', text: '已经存在', audioId: 'present', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/present:clip.wav' },
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

  it('clears a corrupt managed WAV so it can be regenerated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-tts-recovery-'));
    roots.push(root);
    await mkdir(path.join(root, 'lesson-1', 'audio'), { recursive: true });
    await writeFile(path.join(root, 'lesson-1', 'audio', 'broken.wav'), 'not a wav');
    const plan = await planClassroomTtsRecovery(classroom([
      { id: 'broken', type: 'speech', text: '需要重新生成', audioId: 'broken', audioUrl: '/api/openmaic/classroom-media/lesson-1/audio/broken.wav' },
    ]), root);

    expect(plan.missingActionIds).toEqual(['broken']);
    expect(plan.classroom.scenes[0]?.actions?.[0]).not.toHaveProperty('audioUrl');
  });

  it('rejects traversal paths and restores timing metadata from the script', () => {
    expect(classroomAudioStoragePath('/data/classrooms', '/api/openmaic/classroom-media/lesson-1/audio/..')).toBeNull();
    expect(classroomTtsTimingOptions(classroom([]).scenes)).toMatchObject({
      providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Ethan', language: 'zh-CN',
    });
  });
});
