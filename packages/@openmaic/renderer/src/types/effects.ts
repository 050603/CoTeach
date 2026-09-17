import type { LaserWaypoint, VisualTargetSelector } from '@openmaic/dsl';

export interface LaserEffectOptions {
  elementId: string;
  selector?: VisualTargetSelector;
  waypoints?: LaserWaypoint[];
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
