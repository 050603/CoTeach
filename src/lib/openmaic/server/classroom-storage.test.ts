import { describe, expect, it } from 'vitest';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';
import {
  normalizeClassroomAssetUrls,
  normalizePersistedClassroom,
  removeLegacySyntheticWhiteboardActions,
  resolveClassroomsDir,
} from './classroom-storage';

describe('resolveClassroomsDir', () => {
  it('keeps configured classroom storage outside replaceable build output', () => {
    expect(resolveClassroomsDir(
      { CLASSROOM_DATA_DIR: '/srv/openpbl/classrooms' },
      '/app/.next/standalone',
    )).toBe('/srv/openpbl/classrooms');
  });

  it('retains the container-compatible cwd fallback', () => {
    expect(resolveClassroomsDir({}, '/app')).toBe('/app/data/classrooms');
  });
});

describe('normalizeClassroomAssetUrls', () => {
  it('migrates legacy media origins without changing unrelated external URLs', () => {
    expect(normalizeClassroomAssetUrls({
      audioUrl: 'http://172.16.185.157/api/openmaic/classroom-media/c1/audio/a.wav',
      image: 'https://old.example/api/openmaic/classroom-media/c1/media/a.png?rev=1',
      external: 'https://cdn.example/reference.png',
    })).toEqual({
      audioUrl: '/api/openmaic/classroom-media/c1/audio/a.wav',
      image: '/api/openmaic/classroom-media/c1/media/a.png?rev=1',
      external: 'https://cdn.example/reference.png',
    });
  });
});

describe('removeLegacySyntheticWhiteboardActions', () => {
  it('preserves an untitled board cleared by its author beside a removed legacy shell', () => {
    const retained: Action[] = [
      { id: 'board', type: 'wb_open' },
      { id: 'explain', type: 'speech', text: '请先思考这个问题。' },
      { id: 'close', type: 'wb_close' },
    ];
    expect(removeLegacySyntheticWhiteboardActions([
      { id: 'legacy', type: 'wb_open' },
      { id: 'legacy-note', type: 'wb_draw_text', elementId: 'planned-note-1', content: '旧回退', x: 0, y: 0 },
      { id: 'legacy-close', type: 'wb_close' },
      ...retained,
    ])).toEqual(retained);
    expect(removeLegacySyntheticWhiteboardActions([retained[0], retained[2]])).toEqual([retained[0], retained[2]]);
  });
  it('retains an explicitly authored empty board so the teacher can finish it after reloading', () => {
    const actions: Action[] = [
      { id: 'board', type: 'wb_open', title: '白板讲授' },
      { id: 'explain', type: 'speech', text: '请先思考这个问题。' },
      { id: 'close', type: 'wb_close' },
    ];
    expect(removeLegacySyntheticWhiteboardActions(actions)).toEqual(actions);
  });
  it('removes old generated key-point notes and their empty open/close shell', () => {
    expect(removeLegacySyntheticWhiteboardActions([
      { id: 'open', type: 'wb_open' },
      { id: 'note-1', type: 'wb_draw_text', elementId: 'planned-note-1', content: '页面标题', x: 70, y: 48 },
      { id: 'speech', type: 'speech', text: '真实讲解' },
      { id: 'close', type: 'wb_close' },
    ])).toEqual([{ id: 'speech', type: 'speech', text: '真实讲解' }]);
  });

  it('preserves a board lifecycle containing real model-authored drawings', () => {
    const actions: Action[] = [
      { id: 'open', type: 'wb_open' },
      { id: 'real', type: 'wb_draw_text', elementId: 'reasoning-step', content: '输入 → 输出', x: 70, y: 48 },
      { id: 'close', type: 'wb_close' },
    ];
    expect(removeLegacySyntheticWhiteboardActions(actions)).toEqual(actions);
  });
});

describe('normalizePersistedClassroom', () => {
  it('preserves an image-only whiteboard and makes its persisted media URL portable', () => {
    const classroom = normalizePersistedClassroom({
      id: 'c1', createdAt: '2026-09-12T00:00:00.000Z',
      stage: { id: 'c1', name: '课堂', createdAt: 1, updatedAt: 1 },
      scenes: [{
        id: 's1', stageId: 'c1', type: 'slide', title: '图片讲解', order: 0,
        content: { type: 'slide', canvas: { id: 'canvas', elements: [] } },
        actions: [
          { id: 'open', type: 'wb_open' },
          { id: 'image', type: 'wb_draw_image', src: 'https://old.example/api/openmaic/classroom-media/c1/media/diagram.png', x: 60, y: 80, width: 500, height: 300 },
          { id: 'speech', type: 'speech', text: '观察这张图。' },
          { id: 'close', type: 'wb_close' },
        ],
      } as unknown as Scene],
    });
    expect(classroom.scenes[0].actions?.map((action) => action.type)).toEqual([
      'wb_open', 'wb_draw_image', 'speech', 'wb_close',
    ]);
    expect(classroom.scenes[0].actions?.[1]).toHaveProperty('src', '/api/openmaic/classroom-media/c1/media/diagram.png');
  });

  it('repairs the legacy silent policy on explicit student AI-learning scenes', () => {
    const classroom = normalizePersistedClassroom({
      id: 'c1',
      createdAt: '2026-08-21T00:00:00.000Z',
      stage: {
        id: 'c1',
        name: '课程',
        createdAt: 1,
        updatedAt: 1,
      } as Stage,
      scenes: [{
        id: 's1',
        stageId: 'c1',
        title: '核心讲解',
        type: 'slide',
        order: 0,
        content: { type: 'slide', elements: [] },
        actions: [],
        audience: 'student',
        stageKey: 'ai-learning',
        generationPurpose: 'knowledge-teaching',
        ttsPolicy: 'none',
      } as unknown as Scene],
    });
    expect(classroom.scenes[0]?.ttsPolicy).toBe('target-duration');
  });
});
