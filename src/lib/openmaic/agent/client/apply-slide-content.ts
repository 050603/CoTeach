'use client';

/**
 * Apply a scene patch to the stage store while keeping the OPEN slide edit
 * session in lockstep. Shared by both the `regenerate_scene` apply path and the
 * "restore previous" button — without reseeding the open session, the canvas
 * keeps rendering its stale `history.present` and the next edit clobbers the
 * applied change.
 */
import { useStageStore } from '@openmaic/lib/store/stage';
import { useSlideEditSession } from '@openmaic/components/edit/surfaces/slide/slide-edit-session';
import type { ScenePatch, SlideContent } from '@openmaic/lib/types/stage';
import { isEqual } from 'lodash';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { toast } from 'sonner';
import { planSceneRangeReplacement, type SceneRangeDirection, type SceneRangeTransaction } from './scene-range-transaction';

/** Apply a scene patch to the stage store and keep the OPEN slide edit session
 *  in lockstep (else the canvas renders stale history and clobbers the change). */
export function applyScenePatchInSync(sceneId: string, patch: ScenePatch): void {
  useStageStore.getState().updateScene(sceneId, patch);
  const es = useSlideEditSession.getState();
  if (patch.content && es.sceneId === sceneId) {
    es.seed(sceneId, patch.content as SlideContent);
  }
}

let rangeSaveQueue: Promise<void> = Promise.resolve();

/** Scene data and the adopted outlines must survive refresh together. */
export function persistRegenerateSceneRange(stageId: string): Promise<void> {
  const save = rangeSaveQueue.catch(() => undefined).then(async () => {
    const [{ db }, { saveStageData }] = await Promise.all([
      import('@openmaic/lib/utils/database'), import('@openmaic/lib/utils/stage-storage'),
    ]);
    // Read after lazy loading/earlier writes: a late save must not write an older
    // captured deck over a newer teacher edit or the next open classroom.
    const state = useStageStore.getState();
    if (state.stage?.id !== stageId) return;
    const { stage, scenes, currentSceneId, chats, outlines, generationComplete } = state;
    await db.transaction('rw', [db.stages, db.scenes, db.chatSessions, db.stageOutlines], async () => {
      await saveStageData(stageId, { stage, scenes, currentSceneId, chats });
      await db.stageOutlines.put({
        stageId, outlines, generationComplete, createdAt: stage.createdAt || Date.now(), updatedAt: Date.now(),
      });
    });
  });
  rangeSaveQueue = save;
  return save;
}

/** Apply/undo/redo a local split with a guard and a single reactive update. */
export function applySceneRangeInSync(
  transaction: SceneRangeTransaction,
  direction: SceneRangeDirection = 'apply',
): string | undefined {
  const state = useStageStore.getState();
  if (state.stage?.id !== transaction.stageId) return '当前课程已切换，重设计没有应用。';
  const session = useSlideEditSession.getState();
  const expected = direction === 'undo' ? transaction.after : transaction.before;
  const expectedIds = new Set(expected.scenes.map((scene) => scene.id));
  if (session.sceneId && expectedIds.has(session.sceneId) && session.history &&
      !isEqual(session.history.present, state.getSceneById(session.sceneId)?.content)) {
    return '当前页面仍有未同步的编辑，已保留你的内容，请稍后再试。';
  }
  const next = planSceneRangeReplacement(state, transaction, direction);
  if (next.error) return next.error;
  useStageStore.setState({ scenes: next.scenes, outlines: next.outlines, currentSceneId: next.currentSceneId });
  if (next.currentSceneId !== state.currentSceneId) useCanvasStore.getState().setWhiteboardOpen(false);
  if (session.sceneId && expectedIds.has(session.sceneId)) {
    const live = next.scenes.find((scene) => scene.id === session.sceneId) ??
      next.scenes.find((scene) => scene.id === next.currentSceneId);
    if (live?.content.type === 'slide') session.seed(live.id, live.content);
    else session.end();
  }
  void persistRegenerateSceneRange(transaction.stageId).catch(() => {
    toast.error('图解重设计已应用，但本地保存失败。请保留当前页面并重试保存。');
  });
}
