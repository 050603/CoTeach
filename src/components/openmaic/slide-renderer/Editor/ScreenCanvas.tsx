'use client';

import { ScreenElement } from './ScreenElement';
import { HighlightOverlay } from './HighlightOverlay';
import { SpotlightOverlay } from './SpotlightOverlay';
import { LaserPointerOverlay } from './LaserPointerOverlay';
import { useSlideBackgroundStyle } from '@openmaic/lib/hooks/use-slide-background-style';
import { useCanvasStore } from '@openmaic/lib/store';
import { useSceneSelector } from '@openmaic/lib/contexts/scene-context';
import { findElementGeometry } from '@openmaic/lib/utils/geometry';
import type { SlideContent } from '@openmaic/lib/types/stage';
import type { PercentageGeometry } from '@openmaic/lib/types/action';
import type { PPTElement, SlideBackground } from '@openmaic/dsl';
import { useViewportSize } from './Canvas/hooks/useViewportSize';
import { useRef, useMemo } from 'react';

export function ScreenCanvas() {
  const canvasScale = useCanvasStore.use.canvasScale();
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const slideRootRef = useRef<HTMLDivElement>(null);

  // Viewport size and positioning
  const { viewportStyles } = useViewportSize(canvasRef);

  // Get background style
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );
  const { backgroundStyle } = useSlideBackgroundStyle(background);

  // Get visual effect state
  const zoomTarget = useCanvasStore.use.zoomTarget();

  // Compute zoom target geometry
  const zoomGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!zoomTarget) return null;
    const element = elements.find((el) => el.id === zoomTarget.elementId);
    if (!element) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      zoomTarget.elementId,
    );
  }, [zoomTarget, elements]);

  return (
    <div className="relative h-full w-full overflow-hidden select-none" ref={canvasRef}>
      <div
        ref={slideRootRef}
        className="absolute shadow-[0_0_0_1px_rgba(0,0,0,0.01),0_0_12px_0_rgba(0,0,0,0.1)] rounded-lg overflow-hidden transition-transform duration-700"
        style={{
          width: `${viewportStyles.width * canvasScale}px`,
          height: `${viewportStyles.height * canvasScale}px`,
          left: `${viewportStyles.left}px`,
          top: `${viewportStyles.top}px`,
          ...(zoomTarget && zoomGeometry
            ? {
                transform: `scale(${zoomTarget.scale})`,
                transformOrigin: `${zoomGeometry.centerX}% ${zoomGeometry.centerY}%`,
              }
            : {}),
        }}
      >
        {/* Background layer */}
        <div
          className="w-full h-full bg-position-center rounded-lg"
          style={{ ...backgroundStyle }}
        ></div>

        {/* Content layer - scaled */}
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: `${viewportStyles.width}px`,
            height: `${viewportStyles.height}px`,
            transform: `scale(${canvasScale})`,
          }}
        >
          {elements.map((element, index) => (
            <ScreenElement key={element.id} elementInfo={element} elementIndex={index + 1} />
          ))}

          {/* Highlight overlay - stacked above elements */}
          <HighlightOverlay />
        </div>

        {/* Spotlight overlay - covers the entire slide, positioned via DOM measurement */}
        <SpotlightOverlay rootRef={slideRootRef} />
        <LaserPointerOverlay rootRef={slideRootRef} />
      </div>
    </div>
  );
}
