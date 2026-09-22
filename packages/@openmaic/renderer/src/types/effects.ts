import type { LaserWaypoint, VisualTargetSelector } from '@openmaic/dsl';

export interface LaserEffectOptions {
  elementId: string;
  selector?: VisualTargetSelector;
  /**
   * Legacy authored path. Playback should select one target at its narration
   * anchor and expose it through `elementId`/`selector`, rather than asking the
   * renderer to divide the full cue duration across this array.
   */
  waypoints?: LaserWaypoint[];
  /** Previous active target, used only as the origin of a short target change. */
  previousTarget?: LaserWaypoint;
  /** Target-change travel time. Set to 0 after a seek. Defaults to 150ms. */
  transitionDurationMs?: number;
  speechId?: string;
  color?: string;
  duration?: number;
}

export interface SpotlightEffectOptions {
  elementId: string;
  selector?: VisualTargetSelector;
  speechId?: string;
  endSpeechId?: string;
  dimOpacity?: number;
}

export interface HighlightEffectOptions {
  elementId: string;
  color?: string;
  opacity?: number;
  borderWidth?: number;
  animated?: boolean;
}

export interface ZoomEffectOptions {
  elementId: string;
  scale: number;
}

export interface SlideEffects {
  laser?: LaserEffectOptions;
  spotlight?: SpotlightEffectOptions;
  highlight?: HighlightEffectOptions;
  zoom?: ZoomEffectOptions;
}
