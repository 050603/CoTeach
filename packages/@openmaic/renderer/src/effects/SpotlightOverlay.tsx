'use client';

import { useId, type RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { SpotlightEffectOptions } from '../types/effects';
import type { PercentageGeometry } from '../utils/geometry';
import { useVisualTargetGeometry } from '../hooks/useVisualTargetGeometry';
import { visualTargetKey } from '../utils/visualTarget';

export interface SpotlightOverlayProps {
  options?: SpotlightEffectOptions;
  /** Pre-resolved geometry. When omitted, the target is measured within `rootRef`. */
  geometry?: PercentageGeometry | null;
  /** Per-line quote rectangles. Falls back to `geometry` for whole elements. */
  geometries?: PercentageGeometry[];
  /** Rendered slide root that owns the target. */
  rootRef?: RefObject<HTMLElement | null>;
  /** @deprecated Targets are scoped by `rootRef`; retained for source compatibility. */
  elementIdPrefix?: string;
}

export function SpotlightOverlay({
  options,
  geometry,
  geometries,
  rootRef,
}: SpotlightOverlayProps) {
  const measuredGeometry = useVisualTargetGeometry(
    rootRef,
    geometry === undefined ? options : undefined,
  );
  const rect = geometry === undefined ? measuredGeometry : geometry;
  const rects = geometries?.length ? geometries : rect ? [rect] : [];
  const active = !!options?.elementId && !!rect;
  const targetKey = options ? visualTargetKey(options) : 'inactive';
  const maskId = `spotlight-mask-${useId().replace(/:/g, '')}`;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <AnimatePresence mode="wait">
        {active && rect && (
          <motion.div
            key={`spotlight-${targetKey}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0 }}
            >
              <defs>
                <mask id={maskId}>
                  <rect x="0" y="0" width="100" height="100" fill="white" />
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

              <rect
                width="100"
                height="100"
                fill={`rgba(0,0,0,${options?.dimOpacity ?? 0.7})`}
                mask={`url(#${maskId})`}
              />

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
