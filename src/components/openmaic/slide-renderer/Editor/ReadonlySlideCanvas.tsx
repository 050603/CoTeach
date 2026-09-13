'use client';

import { forwardRef, useMemo } from 'react';
import { SceneProvider, type SceneDataController } from '@openmaic/lib/contexts/scene-context';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import { useSlideBackgroundStyle } from '@openmaic/lib/hooks/use-slide-background-style';
import { ScreenElement } from './ScreenElement';

/** The playback elements on a fixed canvas, without playback, selection or overlays. */
export const ReadonlySlideCanvas = forwardRef<HTMLDivElement, { scene: Scene }>(function ReadonlySlideCanvas({ scene }, ref) {
  const controller = useMemo<SceneDataController>(() => ({ sceneId: scene.id, sceneType: scene.type,
    getSnapshot: () => scene.content, updateSceneData: () => undefined }), [scene]);
  const content = scene.content as SlideContent;
  const canvas = content.type === 'slide' ? content.canvas : undefined;
  const { backgroundStyle } = useSlideBackgroundStyle(canvas?.background);
  if (!canvas) return null;
  const width = canvas.viewportSize || 1000;
  const height = width * (canvas.viewportRatio || 0.5625);
  return <SceneProvider controller={controller}>
    <div ref={ref} className="relative isolate overflow-visible" data-review-canvas={scene.id}
      style={{ width, height, ...backgroundStyle, fontFamily: canvas.theme.fontName, color: canvas.theme.fontColor }}>
      {canvas.elements.map((element, index) => <div key={element.id} data-review-element={element.id}>
        <ScreenElement elementInfo={element} elementIndex={index + 1} animate={false} />
      </div>)}
    </div>
  </SceneProvider>;
});
