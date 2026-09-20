import { describe, expect, it } from 'vitest';
import type { PersistedClassroomData } from './classroom-storage';
import type { Scene, Stage } from '../types/stage';
import {
  InvalidClassroomEditError,
  invalidateChangedSpeechAudio,
  prepareClassroomEdit,
  rewriteClassroomMediaReferences,
} from './classroom-edit';

const stage: Stage = {
  id: 'classroom-1',
  name: 'AI 课堂',
  createdAt: 1,
  updatedAt: 1,
};

function slide(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    stageId: stage.id,
    title: '第一页',
    type: 'slide',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        elements: [{
          id: 'image-1',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          src: '/api/openmaic/classroom-media/classroom-1/images/example.png',
        }],
      },
    },
    actions: [{
      id: 'speech-1',
      type: 'speech',
      text: '原讲稿',
      audioId: 'speech-1.mp3',
      audioUrl: '/api/openmaic/classroom-media/classroom-1/audio/speech-1.mp3',
    }],
    ...overrides,
  } as Scene;
}

function classroom(scene = slide()): PersistedClassroomData {
  return {
    id: stage.id,
    stage,
    scenes: [scene],
    createdAt: '2026-09-12T00:00:00.000Z',
    revision: 3,
  };
}

describe('classroom editing boundary', () => {
  it('invalidates narration audio only when its text changes', () => {
    const before = slide();
    const after = slide({
      actions: [{
        id: 'speech-1',
        type: 'speech',
        text: '修改后的讲稿',
        audioId: 'speech-1.mp3',
        audioUrl: '/api/openmaic/classroom-media/classroom-1/audio/speech-1.mp3',
      }],
    });
    expect(invalidateChangedSpeechAudio(before, after).actions).toEqual([{
      id: 'speech-1',
      type: 'speech',
      text: '修改后的讲稿',
      audioInvalidated: true,
    }]);
    expect(invalidateChangedSpeechAudio(before, before)).toBe(before);
  });

  it('never lets a newly inserted speech reuse submitted legacy audio metadata', () => {
    const before = slide();
    const after = slide({
      actions: [...(before.actions ?? []), {
        id: 'speech-new', type: 'speech', text: '新增解释',
        audioId: 'old.mp3', audioUrl: '/api/openmaic/classroom-media/classroom-1/audio/old.mp3',
      }],
    });
    expect(invalidateChangedSpeechAudio(before, after).actions?.at(-1)).toEqual({
      id: 'speech-new', type: 'speech', text: '新增解释', audioInvalidated: true,
    });
  });

  it('forks stage ids and media references while preserving valid content', () => {
    const prepared = prepareClassroomEdit({
      existing: classroom(),
      stage,
      scenes: [slide()],
      targetClassroomId: 'classroom-1-edit-draft',
    });
    expect(prepared.stage.id).toBe('classroom-1-edit-draft');
    expect(prepared.scenes[0]).toMatchObject({
      stageId: 'classroom-1-edit-draft',
      order: 0,
      content: {
        canvas: {
          elements: [{
            src: '/api/openmaic/classroom-media/classroom-1-edit-draft/images/example.png',
          }],
        },
      },
      actions: [{
        audioUrl: '/api/openmaic/classroom-media/classroom-1-edit-draft/audio/speech-1.mp3',
      }],
    });
    expect(prepared.narrationChanged).toBe(false);
  });

  it('rejects duplicate scene ids before persistence', () => {
    expect(() => prepareClassroomEdit({
      existing: classroom(),
      stage,
      scenes: [slide(), slide()],
      targetClassroomId: stage.id,
    })).toThrowError(InvalidClassroomEditError);
  });

  it('reports malformed narration as an invalid edit before audio reconciliation', () => {
    expect(() => prepareClassroomEdit({
      existing: classroom(), stage, targetClassroomId: stage.id,
      scenes: [{ ...slide(), actions: [null] } as unknown as Scene],
    })).toThrowError(InvalidClassroomEditError);
  });

  it('rewrites only classroom-media paths for the forked classroom', () => {
    expect(rewriteClassroomMediaReferences({
      classroom: '/api/openmaic/classroom-media/classroom-1/a.png',
      external: 'https://cdn.example/classroom-1/a.png',
    }, 'classroom-1', 'classroom-2')).toEqual({
      classroom: '/api/openmaic/classroom-media/classroom-2/a.png',
      external: 'https://cdn.example/classroom-1/a.png',
    });
  });
});
