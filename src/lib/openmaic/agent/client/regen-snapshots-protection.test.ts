import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneContent } from '@openmaic/lib/types/stage';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import { useRegenSnapshots } from './regen-snapshots';

beforeEach(() => useRegenSnapshots.getState().clearAll());

describe('existing tool-card restore protects teacher changes', () => {
  it('refuses whole-page undo after a generated component has been locked or edited', () => {
    const before = teachingVisualEditFixture();
    const after = structuredClone(before);
    after.canvas.elements[0] = { ...after.canvas.elements[0], left: 100 };
    const latest = structuredClone(after);
    latest.canvas.teachingVisual!.components[0].modified = true;
    useRegenSnapshots.getState().setSnapshot('content', { sceneId: 's', content: before, actions: [], redo: { content: after } });
    const apply = vi.fn();
    expect(useRegenSnapshots.getState().restore('content', apply, undefined, undefined,
      () => ({ content: latest, actions: [] }))).toContain('已有后续修改');
    expect(apply).not.toHaveBeenCalled();
    expect(useRegenSnapshots.getState().snapshots.content.restored).toBe(false);
  });

  it('preserves later narration during content-only undo/redo', () => {
    const before: SceneContent = { type: 'interactive', url: '/widget', html: '<p>原题目</p>' };
    const after: SceneContent = { ...before, html: '<p>新题目</p>' };
    const original: Action[] = [{ id: 'speech', type: 'speech', text: '原讲稿', audioUrl: '/original.wav' }];
    let live: { content: SceneContent; actions: Action[] } = {
      content: after, actions: [{ id: 'speech', type: 'speech', text: '教师最新讲稿', audioUrl: '/latest.wav' }],
    };
    useRegenSnapshots.getState().setSnapshot('content', { sceneId: 's', content: before, actions: original, redo: { content: after } });
    const apply = vi.fn((_id, patch: { content?: SceneContent; actions?: Action[] }) => { live = { ...live, ...patch }; });
    expect(useRegenSnapshots.getState().restore('content', apply, undefined, undefined, () => live)).toBeUndefined();
    expect(apply).toHaveBeenLastCalledWith('s', { content: before });
    expect(live.actions[0]).toHaveProperty('audioUrl', '/latest.wav');
    expect(useRegenSnapshots.getState().restore('content', apply, undefined, undefined, () => live)).toBeUndefined();
    expect(live.content).toEqual(after);
    expect(live.actions[0]).toHaveProperty('text', '教师最新讲稿');
  });

  it('keeps later canvas edits during narration-only undo and redo', () => {
    const content = teachingVisualEditFixture();
    const original: Action[] = [{ id: 'speech', type: 'speech', text: '原讲稿', audioUrl: '/original.wav' }];
    const generated: Action[] = [{ id: 'speech', type: 'speech', text: '新讲稿', audioInvalidated: true }];
    const latest = structuredClone(content);
    latest.canvas.teachingVisual!.components[0].locked = true;
    let live = { content: latest as SceneContent, actions: generated };
    useRegenSnapshots.getState().setSnapshot('actions', { sceneId: 's', content, actions: original, actionsOnly: true, redo: { actions: generated } });
    const apply = vi.fn((_id, patch: { content?: SceneContent; actions?: Action[] }) => { live = { ...live, ...patch }; });
    expect(useRegenSnapshots.getState().restore('actions', apply, undefined, undefined, () => live)).toBeUndefined();
    expect(live.content).toBe(latest);
    expect(useRegenSnapshots.getState().restore('actions', apply, undefined, undefined, () => live)).toBeUndefined();
    expect(live.content).toBe(latest);
    expect(live.actions).toEqual(generated);
  });
});
