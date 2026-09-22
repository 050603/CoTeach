'use client';

import { motion } from 'motion/react';
import type { PercentageGeometry } from '../utils/geometry';

export interface LaserOverlayProps {
  geometry: PercentageGeometry;
  /** Origin for a newly mounted target transition. Omit for immediate placement. */
  previousGeometry?: PercentageGeometry | null;
  /** @deprecated Waypoint timing belongs to narration playback. */
  waypointGeometries?: PercentageGeometry[];
  color?: string;
  /** @deprecated Visibility lifetime is controlled by playback. */
  duration?: number;
  transitionDurationMs?: number;
  /** Place the dot just before text instead of covering its glyphs. */
  avoidCoveringTarget?: boolean;
  /** Apply the same placement rule to the previous transition origin. */
  previousAvoidCoveringTarget?: boolean;
}

function pointerPosition(geometry: PercentageGeometry, avoidCoveringTarget: boolean) {
  return avoidCoveringTarget
    ? { x: Math.max(0.8, geometry.x - 0.8), y: geometry.centerY }
    : { x: geometry.centerX, y: geometry.centerY };
}

export function LaserOverlay({
  geometry,
  previousGeometry,
  waypointGeometries: _waypointGeometries = [],
  color = '#ff3b30',
  duration: _duration = 2500,
  transitionDurationMs = 150,
  avoidCoveringTarget = false,
  previousAvoidCoveringTarget = false,
}: LaserOverlayProps) {
  const position = pointerPosition(geometry, avoidCoveringTarget);
  const previousPosition = previousGeometry
    ? pointerPosition(previousGeometry, previousAvoidCoveringTarget)
    : position;
  const travelDuration = Math.max(0, transitionDurationMs) / 1000;

  return (
    <motion.div
      initial={{ opacity: 0, left: `${previousPosition.x}%`, top: `${previousPosition.y}%` }}
      animate={{ opacity: 1, left: `${position.x}%`, top: `${position.y}%` }}
      exit={{
        opacity: 0,
        transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        left: { duration: travelDuration, ease: 'easeInOut' },
        top: { duration: travelDuration, ease: 'easeInOut' },
        opacity: { duration: 0.15 },
      }}
      style={{ position: 'absolute', zIndex: 101, pointerEvents: 'none' }}
    >
      <div style={{ position: 'relative', transform: 'translate(-50%, -50%)' }}>
        <motion.div
          animate={{ scale: [1, 2.8], opacity: [0.6, 0] }}
          transition={{
            repeat: Infinity,
            duration: 1.5,
            ease: 'easeOut',
            repeatDelay: 0.3,
          }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '9999px',
            border: `1.5px solid ${color}`,
          }}
        />
        <div
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '9999px',
            backgroundColor: color,
            boxShadow: `0 0 8px 2px ${color}60`,
          }}
        />
      </div>
    </motion.div>
  );
}
