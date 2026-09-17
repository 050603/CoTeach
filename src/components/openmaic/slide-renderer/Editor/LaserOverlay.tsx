'use client';

import { motion } from 'motion/react';
import type { PercentageGeometry } from '@openmaic/lib/types/action';

interface LaserOverlayProps {
  geometry: PercentageGeometry;
  waypointGeometries?: PercentageGeometry[];
  color?: string;
  duration?: number;
}

/**
 * Laser pointer overlay component
 *
 * Features:
 * - Smoothly flies in from the nearest corner to the element center
 * - Elegant light dot with soft breathing glow
 * - Uses percentage positioning (0-100)
 */
export function LaserOverlay({
  geometry,
  waypointGeometries = [],
  color = '#ff3b30',
  duration: _duration = 3000,
}: LaserOverlayProps) {
  const { centerX, centerY } = geometry;
  const path = [geometry, ...waypointGeometries];

  const startPos = {
    x: centerX > 50 ? 105 : -5,
    y: centerY > 50 ? 105 : -5,
  };
  const travelDuration = waypointGeometries.length > 0
    ? Math.max(0.8, (_duration - 300) / 1000)
    : 0.45;
  const entryRatio = waypointGeometries.length > 0
    ? Math.min(0.25, 0.45 / travelDuration)
    : 1;
  const times = waypointGeometries.length > 0
    ? [
        0,
        entryRatio,
        ...waypointGeometries.map((_point, index) => (
          entryRatio + ((index + 1) / waypointGeometries.length) * (1 - entryRatio)
        )),
      ]
    : [0, 1];
  const leftPath = [`${startPos.x}%`, ...path.map((point) => `${point.centerX}%`)];
  const topPath = [`${startPos.y}%`, ...path.map((point) => `${point.centerY}%`)];

  return (
    <motion.div
      key={`laser-${centerX}-${centerY}`}
      initial={{
        opacity: 0,
        left: `${startPos.x}%`,
        top: `${startPos.y}%`,
      }}
      animate={{
        opacity: 1,
        left: leftPath,
        top: topPath,
      }}
      exit={{
        opacity: 0,
        left: `${startPos.x}%`,
        top: `${startPos.y}%`,
        transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        left: { duration: travelDuration, ease: 'easeInOut', times },
        top: { duration: travelDuration, ease: 'easeInOut', times },
        opacity: { duration: 0.15 },
      }}
      className="absolute z-[101] pointer-events-none"
    >
      <div className="relative -translate-x-1/2 -translate-y-1/2">
        {/* Ring pulse */}
        <motion.div
          animate={{ scale: [1, 2.8], opacity: [0.6, 0] }}
          transition={{
            repeat: Infinity,
            duration: 1.5,
            ease: 'easeOut',
            repeatDelay: 0.3,
          }}
          className="absolute inset-0 rounded-full"
          style={{ border: `1.5px solid ${color}` }}
        />

        {/* Light core */}
        <div
          className="w-2.5 h-2.5 rounded-full"
          style={{
            backgroundColor: color,
            boxShadow: `0 0 8px 2px ${color}60`,
          }}
        />
      </div>
    </motion.div>
  );
}
