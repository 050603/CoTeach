import { isEqual } from 'lodash';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';

/** Only the pages owned by this edit are captured; unrelated pages stay live. */
export interface SceneRangeTransaction {
  sceneId: string;
  stageId: string;
  before: { scenes: Scene[]; outlines: SceneOutline[] };
  after: { scenes: Scene[]; outlines: SceneOutline[] };
}

export type SceneRangeDirection = 'apply' | 'undo' | 'redo';

interface SceneRangeState {
  scenes: Scene[];
  outlines: SceneOutline[];
  currentSceneId: string | null;
}

/** An insertion outside the edited range can change order without editing it. */
export function sameSceneExceptOrder(current: Scene, expected: Scene): boolean {
  return isEqual(current, { ...expected, order: current.order });
}

/**
 * Build a single store update after checking every affected page and outline.
 * Undo/redo refuses later edits, deletions, moves inside the range and ID reuse.
 */
export function planSceneRangeReplacement(
  state: SceneRangeState,
  transaction: SceneRangeTransaction,
  direction: SceneRangeDirection,
): SceneRangeState & { error?: string } {
  const expected = direction === 'undo' ? transaction.after : transaction.before;
  const target = direction === 'undo' ? transaction.before : transaction.after;
  const fail = (error: string) => ({ ...state, error });
  if (!expected.scenes.length || !target.scenes.length ||
      expected.scenes[0].id !== transaction.sceneId || target.scenes[0].id !== transaction.sceneId ||
      [...expected.scenes, ...target.scenes].some((scene) => scene.stageId !== transaction.stageId)) {
    return fail('页面恢复记录不完整，已保留当前课程。');
  }
  const index = state.scenes.findIndex((scene) => scene.id === transaction.sceneId);
  const current = state.scenes.slice(index, index + expected.scenes.length);
  if (index < 0 || current.length !== expected.scenes.length || current.some((scene, offset) =>
    !sameSceneExceptOrder(scene, expected.scenes[offset]))) {
    return fail('这些页面已有后续修改、删除或调整顺序，已保留你的最新内容，无法直接应用、撤销或重做图解重设计。');
  }
  const affectedSceneIds = new Set(expected.scenes.map((scene) => scene.id));
  const targetSceneIds = new Set(target.scenes.map((scene) => scene.id));
  if (targetSceneIds.size !== target.scenes.length || state.scenes.some((scene) =>
    !affectedSceneIds.has(scene.id) && targetSceneIds.has(scene.id))) {
    return fail('拆分页的身份已被其他页面使用，已保留当前课程。');
  }
  for (const outline of expected.outlines) {
    const live = state.outlines.find((item) => item.id === outline.id);
    if (!live || !isEqual(live, { ...outline, order: live.order })) {
      return fail('这些页面的教学计划已有后续修改，已保留你的最新内容。');
    }
  }
  const expectedOutlineIds = new Set(expected.outlines.map((outline) => outline.id));
  const targetOutlineIds = new Set(target.outlines.map((outline) => outline.id));
  if (targetOutlineIds.size !== target.outlines.length || state.outlines.some((outline) =>
    !expectedOutlineIds.has(outline.id) && targetOutlineIds.has(outline.id))) {
    return fail('拆分页的教学计划已被其他页面使用，已保留当前课程。');
  }
  if (state.scenes.some((scene) => !affectedSceneIds.has(scene.id) &&
    scene.outlineId && expectedOutlineIds.has(scene.outlineId))) {
    return fail('其他页面也在使用这份教学计划，无法安全替换指定页。');
  }

  const scenes = [
    ...state.scenes.slice(0, index), ...target.scenes,
    ...state.scenes.slice(index + expected.scenes.length),
  ].map((scene, order) => scene.order === order ? scene : { ...scene, order });
  const outlineIndex = state.outlines.findIndex((outline) => expectedOutlineIds.has(outline.id));
  const remainingOutlines = state.outlines.filter((outline) => !expectedOutlineIds.has(outline.id));
  const insertionIndex = outlineIndex < 0
    ? remainingOutlines.findIndex((outline) => outline.order >= index)
    : outlineIndex;
  remainingOutlines.splice(insertionIndex < 0 ? remainingOutlines.length : insertionIndex, 0,
    ...target.outlines);
  const sceneOrderByOutline = new Map(scenes.filter((scene) => scene.outlineId)
    .map((scene) => [scene.outlineId!, scene.order]));
  const outlines = remainingOutlines.map((outline) => {
    const order = sceneOrderByOutline.get(outline.id);
    return order === undefined || order === outline.order ? outline : { ...outline, order };
  });
  const currentSceneId = state.currentSceneId && scenes.some((scene) => scene.id === state.currentSceneId)
    ? state.currentSceneId
    : transaction.sceneId;
  return { scenes, outlines, currentSceneId };
}
