'use client';

import { useId, useRef, type RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useSceneSelector } from '@openmaic/lib/contexts/scene-context';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import type { SlideContent } from '@openmaic/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import { visualTargetKey } from '@openmaic/lib/utils/visual-target';
import {
  useVisualTargetFragmentGeometries,
  useVisualTargetGeometry,
} from './useVisualTargetGeometry';

/**
 * Spotlight overlay component
 *
 * Uses DOM measurement (getBoundingClientRect) to compute spotlight position,
 * avoiding alignment offsets from percentage coordinate conversion.
 */
interface SpotlightOverlayProps {
  /** Explicit rendered slide root used to isolate duplicate element ids. */
  rootRef: RefObject<HTMLElement | null>;
  /**
   * @deprecated Targeting uses data-slide-element-id. Retained while the
   * editor preview caller migrates to an explicit root ref.
   */
  domIdPrefix?: string;
}

export function SpotlightOverlay({ rootRef }: SpotlightOverlayProps) {
  const spotlightElementId = useCanvasStore.use.spotlightElementId();
  const spotlightOptions = useCanvasStore.use.spotlightOptions();
  const canvasScale = useCanvasStore.use.canvasScale();
  const containerRef = useRef<HTMLDivElement>(null);
  const maskId = `spotlight-mask-${useId().replace(/:/g, '')}`;

  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  const selector = spotlightOptions?.selector;
  const targetKey = spotlightElementId
    ? visualTargetKey({ elementId: spotlightElementId, selector })
    : 'inactive';
  const rect = useVisualTargetGeometry({
    containerRef,
    rootRef,
    elementId: spotlightElementId,
    selector,
    canvasScale,
    contentRevision: elements,
  });
  const fragments = useVisualTargetFragmentGeometries({
    containerRef,
    rootRef,
    elementId: spotlightElementId,
    selector,
    canvasScale,
    contentRevision: elements,
  });
  const rects = fragments.length ? fragments : rect ? [rect] : [];

  const active = !!spotlightElementId && !!spotlightOptions && !!rect;
  const dimness = spotlightOptions?.dimness ?? 0.7;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-[100] pointer-events-none overflow-hidden"
    >
      <AnimatePresence mode="wait">
        {active && rect && (
          <motion.div
            key={`spotlight-${targetKey}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0"
            >
              <defs>
                <mask id={maskId}>
                  {/* White background = show mask layer (dimmed) */}
                  <rect x="0" y="0" width="100" height="100" fill="white" />
                  {/* Black rectangle = hide mask layer (highlighted area / cutout) */}
                  {rects.map((fragment, index) => (
                    <motion.rect
                      key={index}
                      fill="black"
                      initial={{ x: fragment.x - 2, y: fragment.y - 2, width: fragment.w + 4, height: fragment.h + 4, rx: 2 }}
                      animate={{ x: fragment.x - 0.4, y: fragment.y - 0.6, width: fragment.w + 0.8, height: fragment.h + 1.2, rx: 1 }}
                      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    />
                  ))}
                </mask>
              </defs>

              {/* Dimmed Background. No backdrop-filter: combined with SVG <mask>
                 it breaks compositing (backdrop bypasses the mask cutout) in some
                 browsers, leaving the focused area dimmed despite the cutout.
                 Tailwind 3 silently dropped `backdrop-blur-[1.5px]` on SVG via
                 --tw-* variables; Tailwind 4 emits the property directly and
                 surfaced the bug. */}
              <rect
                width="100"
                height="100"
                fill={`rgba(0,0,0,${dimness})`}
                mask={`url(#${maskId})`}
              />

              {/* THE ONE BORDER - white border */}
              {rects.map((fragment, index) => (
                <motion.rect
                  key={index}
                  initial={{ x: fragment.x - 2, y: fragment.y - 2, width: fragment.w + 4, height: fragment.h + 4, opacity: 0, rx: 2 }}
                  animate={{ x: fragment.x - 0.4, y: fragment.y - 0.6, width: fragment.w + 0.8, height: fragment.h + 1.2, opacity: 1, rx: 1 }}
                  fill="none"
                  stroke="rgba(255,255,255,0.7)"
                  strokeWidth="1.2"
                  style={{ vectorEffect: 'non-scaling-stroke' } as React.CSSProperties}
                  transition={{ duration: 0.35, delay: 0.03, ease: [0.16, 1, 0.3, 1] }}
                />
              ))}
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
