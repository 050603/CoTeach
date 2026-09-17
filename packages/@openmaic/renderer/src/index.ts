export { SlideCanvas, type SlideCanvasProps } from './SlideCanvas';
export { SlideElement, type SlideElementProps } from './SlideElement';
export {
  SlideRendererProvider,
  useSlideContext,
  useOptionalSlideContext,
  type SlideContextValue,
  type SlideRendererProviderProps,
} from './context';

export {
  HighlightOverlay,
  SpotlightOverlay,
  LaserOverlay,
  ZoomWrapper,
  type HighlightOverlayProps,
  type SpotlightOverlayProps,
  type LaserOverlayProps,
  type ZoomWrapperProps,
} from './effects';

export { useSlideBackgroundStyle } from './hooks/useSlideBackgroundStyle';
export {
  useVisualTargetGeometry,
  useVisualTargetPathGeometry,
} from './hooks/useVisualTargetGeometry';
export {
  useViewportSize,
  type ViewportStyles,
  type UseViewportSizeOptions,
  type UseViewportSizeResult,
} from './hooks/useViewportSize';

export {
  findElementGeometry,
  findNearestCorner,
  getElementPercentageGeometry,
  type PercentageGeometry,
} from './utils/geometry';
export {
  resolveVisualTarget,
  resolveVisualTargetGeometry,
  visualTargetRectToPercentageGeometry,
  visualTargetKey,
  type ResolvedVisualTarget,
  type VisualTarget,
} from './utils/visualTarget';
export { cn } from './utils/cn';

export * from './types';
