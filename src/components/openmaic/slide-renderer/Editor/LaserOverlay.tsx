'use client';

import { motion } from 'motion/react';
import type { PercentageGeometry } from '@openmaic/lib/types/action';

interface LaserOverlayProps {
  geometry: PercentageGeometry;
  color?: string;
  transitionDurationMs?: number;
  avoidCoveringTarget?: boolean;
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
  color = '#ff3b30',
  transitionDurationMs = 150,
  avoidCoveringTarget = false,
}: LaserOverlayProps) {
  const pointerX = avoidCoveringTarget ? Math.max(0.8, geometry.x - 0.8) : geometry.centerX;
  const pointerY = geometry.centerY;

  return (
    <motion.div
      initial={{
        opacity: 0,
        left: `${pointerX}%`,
        top: `${pointerY}%`,
      }}
      animate={{
        opacity: 1,
        left: `${pointerX}%`,
        top: `${pointerY}%`,
      }}
      exit={{
        opacity: 0,
        transition: { duration: 0.25, ease: [0.4, 0, 1, 1] },
      }}
      transition={{
        left: { duration: Math.max(0, transitionDurationMs) / 1000, ease: 'easeOut' },
        top: { duration: Math.max(0, transitionDurationMs) / 1000, ease: 'easeOut' },
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
