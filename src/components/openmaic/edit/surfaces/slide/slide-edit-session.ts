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
import { commitSlideEdit, deriveSlideEditOperations } from '@openmaic/lib/edit/scene-edit-bridge';
import { migrateSlideContent } from '@openmaic/lib/edit/slide-schema';
import {
  applySlideEditOperation,
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
} from '@openmaic/lib/edit/slide-ops';
import type { SlideEditHistory, SlideEditOperation } from '@openmaic/lib/edit/slide-ops';
import { useStageStore } from '@openmaic/lib/store/stage';
import type { SlideContent } from '@openmaic/lib/types/stage';

interface SlideEditSessionState {
  sceneId: string | null;
  history: SlideEditHistory | null;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: SlideContent) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: SlideEditOperation) => void;
  /**
   * Fold a renderer-committed snapshot in. `isUserEdit` is the causal
   * discriminator: a real gesture commits synchronously inside a pointer
   * interaction, whereas the renderer's ResizeObserver normalization (text
   * auto-height) commits with no pointer gesture in flight. Non-user
   * commits update `present` only — no new undo step, so `past` is left
   * untouched. Text height/width measurement also preserves redo: replaying
   * text content will measure its size again. Other non-user replacements
   * invalidate the redo branch as before.
   */
  commitContent: (next: SlideContent, isUserEdit: boolean) => void;
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
      if (!isUserEdit) {
        const changes = deriveSlideEditOperations(history.present, next);
        const textSizeOnly = changes.length > 0 && changes.every((operation) =>
          operation.type === 'element.update'
          && history.present.canvas.elements.some((element) => element.id === operation.elementId && element.type === 'text')
          && Object.keys(operation.patch).every((key) => key === 'height' || key === 'width'));
        writeThrough(next);
        set({ history: { ...history, present: next, future: textSizeOnly ? history.future : [] } });
        return;
      }
      replace(commitSlideEdit(history, next));
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
