'use client';

import { useRef, type RefObject } from 'react';
import { AnimatePresence } from 'motion/react';
import { useSceneSelector } from '@openmaic/lib/contexts/scene-context';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import type { SlideContent } from '@openmaic/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import { LaserOverlay } from './LaserOverlay';
import { useVisualTargetGeometry } from './useVisualTargetGeometry';

interface LaserPointerOverlayProps {
  /** Explicit rendered slide root used to isolate duplicate element ids. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * @deprecated Targeting uses data-slide-element-id. Retained while the
   * editor preview caller migrates to an explicit root ref.
   */
  domIdPrefix?: string;
}

/**
 * Store-driven laser pointer overlay.
 *
 * The laser sibling of {@link SpotlightOverlay}: reads `laserElementId` /
 * `laserOptions` from the canvas store and measures the rendered DOM element
 * (`getBoundingClientRect`) to place the laser dot at its center. Without this,
 * the edit canvas had no laser surface, so laser cues had nowhere to render and
 * were collapsed into a spotlight instead.
 */
export function LaserPointerOverlay({
  rootRef,
}: LaserPointerOverlayProps) {
  const laserElementId = useCanvasStore.use.laserElementId();
  const laserOptions = useCanvasStore.use.laserOptions();
  const canvasScale = useCanvasStore.use.canvasScale();
  const containerRef = useRef<HTMLDivElement>(null);

  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  const selector = laserOptions?.selector;
  const targetElement = elements.find((element) => element.id === laserElementId);
  const avoidCoveringTarget = Boolean(
    selector
    || targetElement?.type === 'text'
    || targetElement?.type === 'table'
    || targetElement?.type === 'latex'
    || (targetElement?.type === 'shape' && targetElement.text?.content),
  );
  const geometry = useVisualTargetGeometry({
    containerRef,
    rootRef,
    elementId: laserElementId,
    selector,
    canvasScale,
    contentRevision: elements,
  });
  return (
    // No overflow-hidden: the laser flies in from just outside the frame.
    <div ref={containerRef} className="absolute inset-0 z-[101] pointer-events-none">
      <AnimatePresence>
        {laserElementId && geometry && (
          <LaserOverlay
            key="laser-active"
            geometry={geometry}
            color={laserOptions?.color}
            transitionDurationMs={laserOptions?.transitionDurationMs}
            avoidCoveringTarget={avoidCoveringTarget}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
