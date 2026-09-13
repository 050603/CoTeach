import { describe, expect, it } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import { reconcileClassroomSave, type ClassroomEditorDocument } from './classroom-editor-save';

function document(): ClassroomEditorDocument {
  return {
    stage: { id: 'c1', name: '课堂', createdAt: 1, updatedAt: 1 },
    scenes: [{
      id: 's1', stageId: 'c1', order: 0, title: '第一页', type: 'slide',
      content: { type: 'slide', canvas: {
        id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
      } },
      actions: [{ id: 'speech', type: 'speech', text: '提交的讲稿', audioUrl: '/old.wav' }],
    } as Scene],
  };
}

describe('classroom save reconciliation', () => {
  it('preserves edits made during save while adopting invalidated speech audio', () => {
    const sent = document();
    const live = structuredClone(sent);
    live.scenes[0].title = '保存期间修改的标题';
    const saved = structuredClone(sent);
    saved.stage.updatedAt = 2;
    saved.scenes[0].actions = [{ id: 'speech', type: 'speech', text: '提交的讲稿' }];
    const result = reconcileClassroomSave(sent, live, saved);
    expect(result.stage.updatedAt).toBe(2);
    expect(result.scenes[0].title).toBe('保存期间修改的标题');
    expect(result.scenes[0].actions).toEqual(saved.scenes[0].actions);
  });

  it('preserves concurrent narration, insertions, deletions and ordering across a fork', () => {
    const sent = document();
    sent.scenes.push({ ...sent.scenes[0], id: 's2', order: 1 });
    const live = structuredClone(sent);
    live.scenes[0].actions = [{ id: 'speech', type: 'speech', text: '继续修改的讲稿' }];
    live.scenes = [
      { ...live.scenes[0], id: 'new', title: '/api/openmaic/classroom-media/c1/media/new.png' },
      live.scenes[0],
    ];
    const saved = structuredClone(sent);
    saved.stage.id = 'c1-draft';
    const result = reconcileClassroomSave(sent, live, saved);
    expect(result.scenes.map((scene) => scene.id)).toEqual(['new', 's1']);
    expect(result.scenes.map((scene) => scene.order)).toEqual([0, 1]);
    expect(result.scenes.every((scene) => scene.stageId === 'c1-draft')).toBe(true);
    expect(result.scenes[0].title).toBe('/api/openmaic/classroom-media/c1-draft/media/new.png');
    expect(result.scenes[1].actions).toEqual(live.scenes[1].actions);
  });

  it('does not attach an uploaded clip to narration edited during the save', () => {
    const sent = document();
    sent.scenes[0].actions = [{ id: 'speech', type: 'speech', text: '已提交讲稿', audioId: 'local-1' }];
    const live = structuredClone(sent);
    live.scenes[0].actions = [{ id: 'speech', type: 'speech', text: '保存期间的新讲稿' }];
    const saved = structuredClone(sent);
    saved.scenes[0].actions = [{ id: 'speech', type: 'speech', text: '已提交讲稿', audioId: 'server-1', audioUrl: '/new.wav' }];
    expect(reconcileClassroomSave(sent, live, saved).scenes[0].actions).toEqual(live.scenes[0].actions);
  });
});
