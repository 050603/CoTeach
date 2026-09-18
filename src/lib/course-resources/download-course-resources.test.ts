// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildClassroomScript } from './download-course-resources';

describe('course resource scripts', () => {
  it('exports every scene in order and preserves all speech segments', () => {
    const markdown = buildClassroomScript({
      id: 'classroom-1',
      stage: { id: 'stage-1', name: '课堂', createdAt: 1, updatedAt: 1 },
      createdAt: '2026-09-18T00:00:00.000Z',
      scenes: [
        {
          id: 'scene-1', stageId: 'stage-1', title: '概念导入', type: 'slide', order: 0,
          content: { type: 'slide', canvas: { id: 'canvas-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [] } },
          actions: [
            { id: 'speech-1', type: 'speech', text: '第一段讲稿。' },
            { id: 'speech-2', type: 'speech', text: '第二段讲稿。' },
          ],
          createdAt: 1, updatedAt: 1,
        },
        {
          id: 'scene-2', stageId: 'stage-1', title: '学生实践', type: 'pbl', order: 1,
          content: { type: 'pbl', projectConfig: {} as never }, actions: [], createdAt: 1, updatedAt: 1,
        },
      ],
    }, '学生 AI 课堂');

    expect(markdown).toContain('# 学生 AI 课堂讲稿');
    expect(markdown).toContain('## 1. 概念导入');
    expect(markdown).toContain('1. 第一段讲稿。\n\n2. 第二段讲稿。');
    expect(markdown).toContain('## 2. 学生实践\n\n（本页无讲稿）');
  });
});
