import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadonlySlideCanvas } from '../src/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import { I18nProvider } from '../src/lib/openmaic/hooks/use-i18n';
import { inspectRenderedSlide, measureSlideElements } from '../src/lib/course-quality-review/render-measurements';
import type { GeneratedSlideContent } from '../src/lib/openmaic/types/generation';
import type { Scene } from '../src/lib/openmaic/types/stage';
import { inspectApprovedVisualRendering } from './approved-visual-render-inspection';

const host = document.getElementById('root')!;
const root = createRoot(host);
// GeneratedSlideContent permits a missing theme. Match buildCompleteScene's
// legacy fallback before passing a saved content draft to the actual canvas.
const legacySceneTheme = {
  backgroundColor: '#ffffff', themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333', fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' as const },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};
Object.assign(window, {
  renderTeachingVisual: async (content: GeneratedSlideContent, id: string, displayedWidth = 1000) => {
    const scale = displayedWidth / 1000;
    Object.assign(host.style, { width: '1000px', height: '562.5px', transform: `scale(${scale})`, transformOrigin: 'top left',
      position: 'absolute', top: displayedWidth === 1000 ? '0px' : '80px', left: displayedWidth === 1000 ? '0px' : `${(window.innerWidth - displayedWidth) / 2}px` });
    const scene = { id, stageId: 'visual-acceptance', type: 'slide', title: id, order: 0, actions: [],
      content: { type: 'slide', canvas: { id, viewportSize: 1000, viewportRatio: 0.5625, ...content, theme: content.theme ?? legacySceneTheme } } } as Scene;
    root.render(<I18nProvider locale="zh-CN"><ReadonlySlideCanvas scene={scene} /></I18nProvider>);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
    if (content.elements.some((element) => element.type === 'chart')) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const canvas = document.querySelector<HTMLElement>('[data-review-canvas]');
    if (!canvas) throw new Error('ReadonlySlideCanvas 未挂载');
    const measurements = measureSlideElements(canvas, content.elements);
    const bound = canvas.getBoundingClientRect();
    const chartMeasurements = content.elements.filter((element) => element.type === 'chart').map((element) => {
      const wrapper = [...canvas.querySelectorAll<HTMLElement>('[data-review-element]')].find((node) => node.dataset.reviewElement === element.id);
      const text = [...(wrapper?.querySelectorAll<SVGTextElement>('svg text') ?? [])].map((node) => ({ text: node.textContent ?? '', fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
        fontFamily: getComputedStyle(node).fontFamily }));
      return { elementId: element.id, text, categoriesVisible: element.data.labels.every((label) => text.some((item) => item.text === label)),
        valuesVisible: element.data.series.flat().every((value) => text.some((item) => item.text === String(value))) };
    });
    const fontSizes = [...measurements.flatMap((item) => typeof item.fontSize === 'number' && item.text.trim() ? [item.fontSize] : []),
      ...chartMeasurements.flatMap((chart) => chart.text.flatMap((item) => Number.isFinite(item.fontSize) && item.text.trim() ? [item.fontSize] : []))];
    const essentialFontIssues = measurements.filter((item) => typeof item.fontSize === 'number' && item.fontSize < 18 && item.text.trim())
      .map((item) => ({ elementId: item.id, fontSize: item.fontSize, text: item.text }));
    essentialFontIssues.push(...chartMeasurements.flatMap((chart) => chart.text.filter((item) => Number.isFinite(item.fontSize) && item.fontSize < 18 && item.text.trim())
      .map((item) => ({ elementId: chart.elementId, fontSize: item.fontSize, text: item.text }))));
    return { method: '实际 ReadonlySlideCanvas、生产 CSS 和字体；隔离画布，不是完整学生学习页面',
      issues: inspectRenderedSlide(id, measurements), measurements, chartMeasurements, essentialFontIssues,
      referenceVisualMeasurements: inspectApprovedVisualRendering(canvas, content.elements),
      minimumFontPx: fontSizes.length ? Math.min(...fontSizes) : undefined,
      minimumDisplayedFontPx: fontSizes.length ? Math.min(...fontSizes) * scale : undefined,
      displayedWidth, scale, viewport: { width: window.innerWidth, height: window.innerHeight },
      canvasFullyVisible: bound.left >= -1 && bound.top >= -1 && bound.right <= window.innerWidth + 1 && bound.bottom <= window.innerHeight + 1,
      contentReview: 'pending', beautyReview: 'pending', fullStudentScreenReview: 'not-run' };
  },
});
