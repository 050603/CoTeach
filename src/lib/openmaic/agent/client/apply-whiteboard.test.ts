import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneContent } from '@openmaic/lib/types/stage';
import { planRegenerateApply } from './apply-regenerate';
import { prepareWhiteboardPatch } from '@openmaic/lib/edit/whiteboard-patch';
import { useRegenSnapshots } from './regen-snapshots';

const actions: Action[] = [
  { id: 'intro', type: 'speech', text: '外部讲解' },
  { id: 'board', type: 'wb_open' },
  { id: 'note', type: 'wb_draw_text', content: '原内容', x: 60, y: 60 },
  { id: 'close', type: 'wb_close' },
  { id: 'after', type: 'speech', text: '下一步' },
];
const content = { type: 'interactive', html: '<button>保持内容</button>' } as SceneContent;
const whiteboardPatch = prepareWhiteboardPatch(actions, 'board', [{ ...actions[2], content: 'AI 修改' }]);

describe('apply scoped whiteboard changes', () => {
  it('preserves a concurrent edit outside the board and snapshots actions for undo', () => {
    const current = [{ ...actions[0], text: '教师刚刚改过外部讲解' } as Action, ...actions.slice(1)];
    const plan = planRegenerateApply({ sceneId: 'scene', whiteboardPatch, actions: [], content: { elements: [] } }, { content, actions: current }, 'edit_whiteboard');
    expect(plan.error).toBeUndefined();
    expect(plan.patch?.actions).toEqual([current[0], actions[1], whiteboardPatch.steps[0], actions[3], actions[4]]);
    expect(plan.patch).not.toHaveProperty('content');
    expect(plan.snapshot).toMatchObject({ actions: current, content, actionsOnly: true });
  });

  it('refuses stale edits to the same board without creating a restore snapshot', () => {
    const current = actions.map((action) => action.id === 'note' ? { ...action, content: '教师刚改过白板' } as Action : action);
    const plan = planRegenerateApply({ sceneId: 'scene', whiteboardPatch }, { content, actions: current }, 'edit_whiteboard');
    expect(plan).toMatchObject({ patch: null, snapshot: null, error: expect.stringContaining('已保留你的最新内容') });
  });

  it('supports clearing only this board and never falls back to whole-scene actions', () => {
    const empty = prepareWhiteboardPatch(actions, 'board', []);
    expect(planRegenerateApply({ sceneId: 'scene', whiteboardPatch: empty }, { content, actions }, 'edit_whiteboard').patch?.actions).toEqual([actions[0], actions[1], actions[3], actions[4]]);
    const failed = planRegenerateApply({ sceneId: 'scene', whiteboardPatch: null, actions: [{ id: 'forged', type: 'speech', text: 'oops' }] }, { content, actions }, 'edit_whiteboard');
    expect(failed.patch).toBeNull();
  });

  it('supports undo and redo without reverting slide content', () => {
    const plan = planRegenerateApply({ sceneId: 'scene', whiteboardPatch }, { content, actions }, 'edit_whiteboard');
    expect(plan.snapshot).not.toBeNull();
    useRegenSnapshots.getState().setSnapshot('board-edit', { ...plan.snapshot!, redo: plan.patch! });
    let currentActions = plan.patch!.actions!;
    const apply = vi.fn((_id, patch) => { currentActions = patch.actions; });
    useRegenSnapshots.getState().restore('board-edit', apply, () => currentActions);
    expect(apply).toHaveBeenLastCalledWith('scene', { actions });
    useRegenSnapshots.getState().restore('board-edit', apply, () => currentActions);
    expect(apply).toHaveBeenLastCalledWith('scene', { actions: plan.patch!.actions });
    useRegenSnapshots.getState().clearAll();
  });

  it('preserves narration edited after the AI result when undoing and redoing the whiteboard', () => {
    const plan = planRegenerateApply({ sceneId: 'scene', whiteboardPatch }, { content, actions }, 'edit_whiteboard');
    useRegenSnapshots.getState().setSnapshot('board-edit', { ...plan.snapshot!, redo: plan.patch! });
    let currentActions = plan.patch!.actions!.map((action) => action.id === 'intro' ? { ...action, text: 'AI 完成后手动改的讲稿' } as Action : action);
    const apply = vi.fn((_id, patch) => { currentActions = patch.actions; });
    expect(useRegenSnapshots.getState().restore('board-edit', apply, () => currentActions)).toBeUndefined();
    expect(currentActions[0]).toHaveProperty('text', 'AI 完成后手动改的讲稿');
    expect(currentActions[2]).toHaveProperty('content', '原内容');
    expect(useRegenSnapshots.getState().restore('board-edit', apply, () => currentActions)).toBeUndefined();
    expect(currentActions[0]).toHaveProperty('text', 'AI 完成后手动改的讲稿');
    expect(currentActions[2]).toHaveProperty('content', 'AI 修改');
    useRegenSnapshots.getState().clearAll();
  });

  it('refuses undo if the same whiteboard has been edited since the AI result', () => {
    const plan = planRegenerateApply({ sceneId: 'scene', whiteboardPatch }, { content, actions }, 'edit_whiteboard');
    useRegenSnapshots.getState().setSnapshot('board-edit', { ...plan.snapshot!, redo: plan.patch! });
    const currentActions = plan.patch!.actions!.map((action) => action.id === 'note' ? { ...action, content: '后续手动板书' } as Action : action);
    const apply = vi.fn();
    expect(useRegenSnapshots.getState().restore('board-edit', apply, () => currentActions)).toContain('已有后续修改');
    expect(apply).not.toHaveBeenCalled();
    expect(useRegenSnapshots.getState().snapshots['board-edit'].restored).toBe(false);
    useRegenSnapshots.getState().clearAll();
  });

  it.each(['read_scene_content', 'unknown_tool'])('does not apply mutating details from %s', (toolName) => {
    expect(planRegenerateApply({ sceneId: 'scene', actions: [{ id: 'forged', type: 'speech', text: 'oops' }] }, { content, actions }, toolName).patch).toBeNull();
  });

  it('refuses a deleted board and malformed or external action steps', () => {
    expect(planRegenerateApply({ sceneId: 'scene', whiteboardPatch }, { content, actions: [actions[0]] }, 'edit_whiteboard').error).toContain('已被删除');
    const forged = { ...whiteboardPatch, steps: [{ id: 'x', type: 'discussion', topic: 'oops' }] as Action[] };
    expect(planRegenerateApply({ sceneId: 'scene', whiteboardPatch: forged }, { content, actions }, 'edit_whiteboard').patch).toBeNull();
  });
});
