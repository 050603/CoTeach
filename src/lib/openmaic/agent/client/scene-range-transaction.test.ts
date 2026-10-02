import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regenerateSplitFixture } from './regenerate-split-fixture';
import { planRegenerateApply } from './apply-regenerate';
import { planSceneRangeReplacement, type SceneRangeTransaction } from './scene-range-transaction';
import { useRegenSnapshots } from './regen-snapshots';

function fixture() {
  const data = regenerateSplitFixture();
  const plan = planRegenerateApply(data.details, data.scene, 'regenerate_scene', data.context);
  const transaction = plan.sceneRange!;
  return { ...data, plan, transaction, state: { scenes: data.context.scenes, outlines: data.context.outlines, currentSceneId: 'next' } };
}

beforeEach(() => useRegenSnapshots.getState().clearAll());

describe('atomic local page replacement', () => {
  it('keeps other pages, their latest narration, timing and selection while inserting siblings', () => {
    const { state, transaction } = fixture();
    state.scenes[2].targetDurationSec = 120;
    state.scenes[2].actions = [{ id: 'next-speech', type: 'speech', text: '另一页最新讲稿', audioUrl: '/latest.wav' }];
    const result = planSceneRangeReplacement(state, transaction, 'apply');
    expect(result.error).toBeUndefined();
    expect(result.scenes.map((scene) => scene.id)).toEqual(['previous', 'original', transaction.after.scenes[1].id, 'next']);
    expect(result.scenes.map((scene) => scene.order)).toEqual([0, 1, 2, 3]);
    expect(result.scenes[0]).toBe(state.scenes[0]);
    expect(result.scenes[3]).toEqual({ ...state.scenes[2], order: 3 });
    expect(result.scenes[3].actions).toBe(state.scenes[2].actions);
    expect(result.currentSceneId).toBe('next');
    expect(result.outlines).toEqual(transaction.after.outlines);
  });

  it('undoes and redoes all siblings without reverting unrelated edits or their audio', () => {
    const { state, transaction } = fixture();
    const applied = planSceneRangeReplacement(state, transaction, 'apply');
    applied.scenes[3] = { ...applied.scenes[3], title: '另外一页的新标题' };
    const undone = planSceneRangeReplacement({ ...applied, currentSceneId: applied.scenes[2].id }, transaction, 'undo');
    expect(undone.error).toBeUndefined();
    expect(undone.scenes.map((scene) => scene.id)).toEqual(['previous', 'original', 'next']);
    expect(undone.scenes[1]).toEqual(transaction.before.scenes[0]);
    expect(undone.scenes[1].actions?.[0]).toHaveProperty('audioUrl', '/ready.wav');
    expect(undone.scenes[2].title).toBe('另外一页的新标题');
    expect(undone.scenes[2].actions?.[0]).toHaveProperty('audioUrl', '/next.wav');
    expect(undone.currentSceneId).toBe('original');
    const redone = planSceneRangeReplacement(undone, transaction, 'redo');
    expect(redone.error).toBeUndefined();
    expect(redone.scenes[2].id).toBe(transaction.after.scenes[1].id);
    expect(redone.scenes[3].title).toBe('另外一页的新标题');
    expect(redone.scenes[1].actions?.[0]).toHaveProperty('audioInvalidated', true);
  });

  it.each(['label', 'lock', 'narration', 'duration', 'reorder', 'deletion', 'outline'])('refuses undo over a later %s edit', (change) => {
    const { state, transaction } = fixture();
    const applied = planSceneRangeReplacement(state, transaction, 'apply');
    applied.scenes = applied.scenes.map((scene) => structuredClone(scene));
    if (change === 'label') applied.scenes[2].title = '教师的新标题';
    if (change === 'lock' && applied.scenes[2].content.type === 'slide') applied.scenes[2].content.canvas.teachingVisual!.components[0].locked = true;
    if (change === 'narration') applied.scenes[2].actions = [{ id: 'manual', type: 'speech', text: '教师新讲稿' }];
    if (change === 'duration') applied.scenes[2].targetDurationSec = 54;
    if (change === 'reorder') [applied.scenes[2], applied.scenes[3]] = [applied.scenes[3], applied.scenes[2]];
    if (change === 'deletion') applied.scenes.splice(2, 1);
    if (change === 'outline') applied.outlines = applied.outlines.map((outline, index) => index === 1 ? { ...outline, keyPoints: ['新增条件'] } : outline);
    const refused = planSceneRangeReplacement(applied, transaction, 'undo');
    expect(refused.error).toContain('已保留');
    expect(refused.scenes).toBe(applied.scenes);
    expect(refused.outlines).toBe(applied.outlines);
  });

  it('guards the original page and inserted IDs before redo', () => {
    const { state, transaction } = fixture();
    const undone = planSceneRangeReplacement(planSceneRangeReplacement(state, transaction, 'apply'), transaction, 'undo');
    const edited = { ...undone, scenes: undone.scenes.map((scene) => scene.id === 'original' ? { ...scene, title: '教师已编辑原页' } : scene) };
    expect(planSceneRangeReplacement(edited, transaction, 'redo').error).toContain('已保留');
    const collision = { ...undone, scenes: [...undone.scenes, { ...undone.scenes[0], id: transaction.after.scenes[1].id, order: 3 }] };
    expect(planSceneRangeReplacement(collision, transaction, 'redo').error).toContain('身份已被其他页面使用');
  });

  it('permits insertions outside the range while preserving their own order and identity', () => {
    const { state, transaction } = fixture();
    const applied = planSceneRangeReplacement(state, transaction, 'apply');
    const inserted = { ...state.scenes[0], id: 'outside-insertion', title: '其他位置新页' };
    applied.scenes = [inserted, ...applied.scenes].map((scene, order) => ({ ...scene, order }));
    const undone = planSceneRangeReplacement(applied, transaction, 'undo');
    expect(undone.error).toBeUndefined();
    expect(undone.scenes.map((scene) => scene.id)).toEqual(['outside-insertion', 'previous', 'original', 'next']);
    expect(undone.outlines[0].order).toBe(2);
    expect(planSceneRangeReplacement(undone, transaction, 'redo').error).toBeUndefined();
  });

  it('does not overwrite another scene sharing an outline', () => {
    const { state, transaction } = fixture();
    state.scenes[2].outlineId = state.outlines[0].id;
    expect(planSceneRangeReplacement(state, transaction, 'apply').error).toContain('其他页面也在使用');
  });

  it('removes newly adopted outlines on undo for a page without a persisted original outline', () => {
    const { state, transaction } = fixture();
    transaction.before.outlines = [];
    transaction.before.scenes[0].outlineId = undefined;
    state.outlines = [];
    const undone = planSceneRangeReplacement(planSceneRangeReplacement(state, transaction, 'apply'), transaction, 'undo');
    expect(undone.error).toBeUndefined();
    expect(undone.outlines).toEqual([]);
    expect(undone.scenes[1].outlineId).toBeUndefined();
  });
});

describe('regenerate restore snapshots with local splits', () => {
  it('keeps the before/after records separate from mutable live action objects', () => {
    const { state, transaction, plan } = fixture();
    const live = planSceneRangeReplacement(state, transaction, 'apply');
    useRegenSnapshots.getState().setSnapshot('split-tool', plan.snapshot!);
    const speech = live.scenes[2].actions![0];
    if (speech.type === 'speech') speech.text = '运行后被修改的讲稿';
    const captured = useRegenSnapshots.getState().snapshots['split-tool'].sceneRange!;
    expect(captured.after.scenes[1].actions![0]).toHaveProperty('text', '依据原资料解释完整教学过程及评价内容。');
    expect(planSceneRangeReplacement(live, captured, 'undo').error).toContain('已有后续修改');
  });

  it('toggles an atomic split through undo/redo and refuses to toggle when it conflicts', () => {
    const { state, transaction, plan } = fixture();
    let live = planSceneRangeReplacement(state, transaction, 'apply');
    useRegenSnapshots.getState().setSnapshot('split-tool', plan.snapshot!);
    const patch = vi.fn();
    const applyRange = vi.fn((range: SceneRangeTransaction, direction: 'apply' | 'undo' | 'redo') => {
      const next = planSceneRangeReplacement(live, range, direction);
      if (next.error) return next.error;
      live = next;
    });
    expect(useRegenSnapshots.getState().restore('split-tool', patch, undefined, applyRange)).toBeUndefined();
    expect(applyRange).toHaveBeenLastCalledWith(transaction, 'undo');
    expect(useRegenSnapshots.getState().snapshots['split-tool'].restored).toBe(true);
    expect(useRegenSnapshots.getState().restore('split-tool', patch, undefined, applyRange)).toBeUndefined();
    expect(applyRange).toHaveBeenLastCalledWith(transaction, 'redo');
    live.scenes[2] = { ...live.scenes[2], title: '教师后续修改' };
    expect(useRegenSnapshots.getState().restore('split-tool', patch, undefined, applyRange)).toContain('已有后续修改');
    expect(useRegenSnapshots.getState().snapshots['split-tool'].restored).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
