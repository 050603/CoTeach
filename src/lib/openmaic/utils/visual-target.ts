/**
 * App compatibility exports for the canonical renderer target resolver.
 * Keeping this shim lets existing app imports converge on one DOM contract and
 * one Range/geometry implementation without duplicating renderer logic.
 */
export {
  resolveVisualTarget,
  resolveVisualTargetGeometry,
  visualTargetRectToPercentageGeometry,
  visualTargetKey,
  type VisualTarget,
} from '@openmaic/renderer';

export type { VisualTargetSelector } from '@openmaic/lib/types/action';
