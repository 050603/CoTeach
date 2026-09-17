'use client';

import { useEffect, useRef } from 'react';
import Canvas from '@openmaic/components/slide-renderer/Editor/Canvas';
import { SpotlightOverlay } from '@openmaic/components/slide-renderer/Editor/SpotlightOverlay';
import { LaserPointerOverlay } from '@openmaic/components/slide-renderer/Editor/LaserPointerOverlay';
import { SceneProvider } from '@openmaic/lib/contexts/scene-context';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import {
  useEditingTextElementId,
  useSelectedNonTextElement,
  useSlideCanvasController,
  useSyncEditingElementId,
} from './use-slide-surface';
import { AnchoredTextBar } from './AnchoredTextBar';
import { AnchoredElementBar } from './AnchoredElementBar';
import { ElementPickLayer } from './ElementPickLayer';

/**
 * The slide surface's canvas. Reuses the unmodified slide renderer
 * (`components/slide-renderer/Editor/Canvas`) and wraps it in a
 * surface-controlled scene context so every renderer commit funnels
 * through the slide-edit-session which auto-saves it back to the
 * canonical stage store (no staging, no "restore unsaved" prompt).
 *
 * It also owns the selection-anchored chrome: it derives the selected element,
 * mirrors a selected text element into the canvas store's `editingElementId`
 * (which the renderer reads to draw a clean frame), and renders the anchored
 * bars — the format bar for text, a type-aware element bar (z-order + delete,
 * plus replace/crop/flip for images) for every other element type.
 * At most one bar is open at a time (single selection).
 */
export function SlideCanvas() {
  const slideRootRef = useRef<HTMLDivElement>(null);
  const { controller, gestureProps } = useSlideCanvasController();
  const editingElementId = useEditingTextElementId();
  const nonTextElement = useSelectedNonTextElement();
  useSyncEditingElementId(editingElementId);

  // Esc disarms in-flight insert mode. Read via getState so the listener mounts
  // once; checking inside the handler keeps us inert when nothing is armed.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const cs = useCanvasStore.getState();
      if (cs.creatingElement) cs.setCreatingElement(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    // gestureProps marks pointer-gesture windows so a renderer commit is
    // classified as a real user edit vs ResizeObserver text normalization
    // (which fires with no gesture in flight). The padded studio frame
    // around the canvas now lives in EditShell.Frame so non-slide scenes
    // (rendered via SceneRenderer in read-only mode) share the exact
    // same canvas bounding rect — switching scene type no longer
    // resizes / reflows the frame, which used to cause the slide↔
    // interactive layout jump.
    <div className="relative h-full w-full" {...gestureProps}>
      <SceneProvider controller={controller}>
        <Canvas slideRootRef={slideRootRef} />
        {/* Same spotlight + laser effects as playback, retargeted to the
            editor's element ids — driven by useCanvasStore.setSpotlight /
            setLaser (e.g. from the ActionsBar cue-badge hover). The laser cue
            replays as a laser pointer, the spotlight cue as a spotlight. */}
        <SpotlightOverlay rootRef={slideRootRef} domIdPrefix="editable-element-" />
        <LaserPointerOverlay rootRef={slideRootRef} domIdPrefix="editable-element-" />
      </SceneProvider>
      <AnchoredTextBar editingElementId={editingElementId} />
      <AnchoredElementBar element={nonTextElement} />
      {/* Canvas-side element picker for the timeline's element-bound cues. */}
      <ElementPickLayer />
    </div>
  );
}
