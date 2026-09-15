import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadonlySlideCanvas } from '../src/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import { inspectRenderedSlide, measureSlideElements } from '../src/lib/course-quality-review/render-measurements';
import type { Scene } from '../src/lib/openmaic/types/stage';
import type { GeneratedSlideContent } from '../src/lib/openmaic/types/generation';
import { I18nProvider } from '../src/lib/openmaic/hooks/use-i18n';

const root = createRoot(document.getElementById('root')!);
Object.assign(window, {
  benchmarkRender: async (content: GeneratedSlideContent, id: string) => {
    const scene = { id, stageId: 'benchmark', type: 'slide', title: id, order: 0, actions: [], content: { type: 'slide', canvas: { id, viewportSize: 1000, viewportRatio: 0.5625, ...content } } } as Scene;
    root.render(<I18nProvider locale="zh-CN"><ReadonlySlideCanvas scene={scene} /></I18nProvider>);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('img')].map((image) => image.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.querySelector<HTMLElement>('[data-review-canvas]');
    if (!canvas) throw new Error('ReadonlySlideCanvas did not mount');
    const measurements = measureSlideElements(canvas, content.elements);
    return { method: 'ReadonlySlideCanvas Chromium native 1000x562.5', issues: inspectRenderedSlide(id, measurements), measurements };
  },
});
