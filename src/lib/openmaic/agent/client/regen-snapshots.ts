'use client';

/**
 * Snapshot store for `regenerate_scene` "restore previous" support.
 *
 * Whole-slide regeneration applies directly to the canvas (snappy), but it
 * overwrites whatever the user had — including hand-edits. Before applying, the
 * runtime snapshots the pre-regenerate scene here, keyed by toolCallId, so the
 * tool card can offer a "还原到重生成前 / Restore previous" button that does not
 * rely on the user remembering Ctrl+Z.
 */
import { create } from 'zustand';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneContent } from '@openmaic/lib/types/stage';
import { isEqual } from 'lodash';
import type { WhiteboardPatch } from '@openmaic/lib/edit/whiteboard-patch';
import { whiteboardBlocks, replaceWhiteboardSteps } from '@openmaic/lib/edit/whiteboard-blocks';

export interface RegenSnapshot {
  sceneId: string;
  content: SceneContent;
  actions: Action[];
  /**
   * Narration-only regen (`regenerate_scene_actions`): the slide content was NOT
   * changed, so Restore must revert ONLY the actions — re-applying the snapshot
   * content would clobber any canvas edits the user made since, and needlessly
   * reseed the slide edit session.
   */
  actionsOnly?: boolean;
  whiteboardPatch?: WhiteboardPatch;
  restored: boolean;
  /**
   * Post-edit state (the patch the tool applied), kept so an undo can be RESUMED
   * (redo). Absent for cards restored from storage after a refresh, where resume
   * isn't possible (the in-memory state is gone).
   */
  redo?: { content?: SceneContent; actions?: Action[] };
}

/** Re-applies the snapshot to the stage store (injected so the store stays testable).
 *  `actions` is optional: omitting it preserves the scene's current actions
 *  (updateScene shallow-merges), whereas `actions: []` would wipe them. */
export type RestoreApplyFn = (
  sceneId: string,
  patch: { content?: SceneContent; actions?: Action[] },
) => void;

interface RegenSnapshotsState {
  snapshots: Record<string, RegenSnapshot>;
  setSnapshot: (toolCallId: string, snap: Omit<RegenSnapshot, 'restored'>) => void;
  /**
   * Toggle: when not yet restored, applies the pre-edit snapshot (undo) and marks
   * it restored; when already restored, RE-applies the post-edit state (resume /
   * redo) and toggles back. A no-op if there's no snapshot, or when resuming but
   * no `redo` state was captured.
   */
  restore: (
    toolCallId: string,
    apply: RestoreApplyFn,
    readActions?: (sceneId: string) => Action[] | null | undefined,
  ) => string | undefined;
  /** Drop all snapshots (e.g. on "新对话") so stale entries don't accumulate. */
  clearAll: () => void;
}

export const useRegenSnapshots = create<RegenSnapshotsState>((set, get) => ({
  snapshots: {},
  setSnapshot: (toolCallId, snap) =>
    set((s) => ({
      snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: false } },
    })),
  restore: (toolCallId, apply, readActions) => {
    const snap = get().snapshots[toolCallId];
    if (!snap) return;
    if (snap.whiteboardPatch) {
      if (snap.restored && !snap.redo) return;
      const actions = readActions?.(snap.sceneId);
      if (!actions) return '未找到当前页面，白板修改无法恢复。';
      const board = whiteboardBlocks(actions).find((item) => item.id === snap.whiteboardPatch!.boardId);
      if (!board) return '这块白板已被删除或替换，恢复没有应用。';
      const expected = snap.restored ? snap.whiteboardPatch.before : snap.whiteboardPatch.steps;
      if (!isEqual(board.steps, expected)) return '这块白板已有后续修改，已保留你的最新内容，无法直接撤销或重做 AI 修改。';
      const target = snap.restored ? snap.whiteboardPatch.steps : snap.whiteboardPatch.before;
      apply(snap.sceneId, { actions: replaceWhiteboardSteps(actions, board.id, target) });
      set((s) => ({ snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: !snap.restored } } }));
      return;
    }
    if (!snap.restored) {
      // Undo → pre-edit state.
      apply(
        snap.sceneId,
        snap.actionsOnly
          ? { actions: snap.actions }
          : { content: snap.content, actions: snap.actions },
      );
      set((s) => ({
        snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: true } },
      }));
      return;
    }
    // Resume (redo) → re-apply EXACTLY the post-edit patch the tool applied,
    // including only the keys it actually carried. Injecting `actions: []` (or
    // `content: undefined`) for a key the patch never had would clobber the
    // scene's existing narration/content on resume.
    const redo = snap.redo;
    if (!redo) return;
    const patch: { content?: SceneContent; actions?: Action[] } = {};
    if (redo.content !== undefined) patch.content = redo.content;
    if (redo.actions !== undefined) patch.actions = redo.actions;
    apply(snap.sceneId, patch);
    set((s) => ({
      snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: false } },
    }));
  },
  clearAll: () => set({ snapshots: {} }),
}));
