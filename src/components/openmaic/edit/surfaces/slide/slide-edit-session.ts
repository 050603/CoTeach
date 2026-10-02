/**
 * Module-level slide-edit session — pure in-memory undo/redo for the editor
 * canvas.
 *
 * EditShell invokes a surface's `useSurfaceState()` and renders its
 * `SurfaceComponent` as siblings (state hook on the shell, canvas as a child
 * of the frame). They must share one `SlideEditHistory`, so it lives in a
 * store rather than component state — the same idiom the rest of the
 * renderer uses (useCanvasStore / useStageStore).
 *
 * Edits are written through to the canonical stage store by the canvas
 * controller (`useSlideCanvasController` in `use-slide-surface.ts`); this
 * store only tracks the undo/redo timeline of an in-progress editing
 * session. It deliberately does NOT persist to localStorage: the canonical
 * stage store is the source of truth and already auto-persists via Dexie,
 * so there is nothing "unsaved" to recover on reload — no "restore unsaved
 * changes" UX, by design.
 */

import { create } from 'zustand';
import { isEqual } from 'lodash';
import { commitSlideEdit } from '@openmaic/lib/edit/scene-edit-bridge';
import { migrateSlideContent } from '@openmaic/lib/edit/slide-schema';
import {
  applySlideEditOperation,
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
  MAX_HISTORY,
} from '@openmaic/lib/edit/slide-ops';
import type { SlideEditHistory, SlideEditOperation } from '@openmaic/lib/edit/slide-ops';
import { useStageStore } from '@openmaic/lib/store/stage';
import type { SlideContent } from '@openmaic/lib/types/stage';
import { isRendererUserEdit, preserveTeachingVisualEdits } from '@openmaic/lib/edit/teaching-visual-edits';

interface SlideEditSessionState {
  sceneId: string | null;
  history: SlideEditHistory | null;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: SlideContent) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: SlideEditOperation) => void;
  /**
   * Fold a renderer-committed snapshot in. `isUserEdit` is the causal
   * gesture hint: a real geometry gesture commits synchronously inside a pointer
   * interaction, whereas the renderer's ResizeObserver normalization (text
   * auto-height) commits with no pointer gesture in flight. Non-user
   * commits update `present` only. Debounced rich text changes are also user
   * edits even without a pointer gesture. No new normalization undo step, so `past` is left
   * untouched (the reflow can chase a user resize and wiping the undo
   * stack would silently break undo). `future` IS cleared, though: once
   * `present` is replaced by the normalized content it has diverged from
   * whatever the redo branch pointed at, so those stale entries are no
   * longer valid continuations.
   */
  commitContent: (next: SlideContent, isUserEdit: boolean) => void;
  /** Apply a measured composition only if the teacher has not edited meanwhile. */
  commitComposition: (expected: SlideContent, next: SlideContent) => boolean;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useSlideEditSession = create<SlideEditSessionState>((set, get) => {
  /**
   * Write the new canonical content through to the stage store (auto-save).
   * Single point of write-through so undo, redo, applyOp, user
   * commitContent, and ResizeObserver normalization all stay in lockstep
   * with `useStageStore`. Stage updates fire first so renderer subscribers
   * (SceneProvider reads via `currentSlideContent`) see the new content as
   * soon as React processes the next batch.
   */
  const writeThrough = (next: SlideContent) => {
    const { sceneId } = get();
    if (!sceneId) return;
    useStageStore.getState().updateScene(sceneId, { content: next });
  };

  const replace = (history: SlideEditHistory) => {
    const { history: prev } = get();
    if (history === prev) return;
    writeThrough(history.present);
    set({ history });
  };

  return {
    sceneId: null,
    history: null,

    seed: (sceneId, content) => {
      // Adopt the live scene content as the in-memory baseline. We do NOT
      // write-through here: if the user makes no edits, the stage store
      // shouldn't receive a redundant write. Any schema migration the
      // first user edit triggers will naturally flow back through
      // commitContent's writeThrough.
      set({
        sceneId,
        history: createSlideEditHistory(migrateSlideContent(content)),
      });
    },

    applyOp: (op) => {
      const { history } = get();
      if (!history) return;
      replace(applySlideEditOperation(history, op));
    },

    commitContent: (next, isUserEdit) => {
      const { history } = get();
      if (!history) return;
      if (history.present === next) return;
      if (!isRendererUserEdit(history.present, next, isUserEdit)) {
        // ResizeObserver / auto-height normalization: don't push an undo
        // step (the reflow can chase a user resize and wiping `past` would
        // silently break undo), but DO write through — the auto-fit height
        // IS the new canonical state. Clear `future`, though: `present` now
        // holds the normalized content, which has diverged from whatever
        // the redo branch pointed at, so replaying those stale entries
        // would discard this normalization. Leaving them would let a later
        // redo silently revert to pre-undo content (canvas/store divergence).
        writeThrough(next);
        set({ history: { ...history, present: next, future: [] } });
        return;
      }
      replace(commitSlideEdit(history, next));
    },

    commitComposition: (expected, next) => {
      const { history } = get();
      if (!history || history.present !== expected) return false;
      next = preserveTeachingVisualEdits(expected, next);
      if (!isEqual(expected, next)) {
        // Composition changes geometry, not authorship. Do not feed it through
        // commitSlideEdit, which correctly marks direct teacher gestures.
        replace({
          past: [...history.past, expected].slice(-MAX_HISTORY),
          present: createSlideEditHistory(next).present,
          future: [],
        });
      }
      return true;
    },

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoSlideEditOperation(history));
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoSlideEditOperation(history));
    },

    end: () => {
      set({ sceneId: null, history: null });
    },
  };
});
