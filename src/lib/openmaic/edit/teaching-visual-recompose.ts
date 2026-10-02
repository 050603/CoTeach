'use client';

import type { PPTElement } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import type { SlideContent } from '../types/stage';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { compileTeachingVisualScene } from '../generation/teaching-visual-compiler';
import { preserveTeachingVisualEdits } from './teaching-visual-edits';
import { getElementListRange } from '../utils/element';
import { SLIDE_RENDERER_STYLES } from '../../../../packages/@openmaic/renderer/src/styles';

/** Measure off-screen at canvas scale, with the actual playback CSS and fonts.
 * Browser edits do not request model work or access server source modules. */
function browserMeasurement(): { measure: TextMeasure; close: () => void } {
  const target = document.createElement('div');
  const styles = document.createElement('style');
  styles.dataset.teachingVisualMeasure = 'true';
  styles.textContent = SLIDE_RENDERER_STYLES;
  target.className = 'slide-renderer-prose';
  Object.assign(target.style, { position: 'fixed', left: '-20000px', top: '0', visibility: 'hidden',
    boxSizing: 'border-box', overflowWrap: 'break-word' });
  document.body.append(styles, target);
  return { close: () => { target.remove(); styles.remove(); }, measure: async (input) => {
    await document.fonts.ready;
    Object.assign(target.style, { width: `${input.width}px`, fontSize: `${input.fontSize}px`,
      fontFamily: input.fontFamily, fontWeight: String(input.fontWeight), padding: `${input.padding}px`,
      lineHeight: String(input.lineHeight), textAlign: input.align, height: 'auto' });
    target.style.setProperty('--paragraphSpace', `${input.paragraphSpace}px`);
    target.innerHTML = input.html;
    await document.fonts.load(`${input.fontWeight} ${input.fontSize}px "${input.fontFamily}"`, input.text);
    const height = target.getBoundingClientRect().height;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法测量图解文字');
    context.font = `${input.fontWeight} ${input.fontSize}px "${input.fontFamily}"`;
    return { height, naturalWidth: Math.max(0, ...input.text.split('\n').map((line) => context.measureText(line).width)),
      lines: [input.text] };
  } };
}
type Rect = { left: number; top: number; width: number; height: number };
function bounds(elements: PPTElement[]): Rect | undefined {
  const boxes = elements.filter((element) => element.type !== 'line' && !('opacity' in element && element.opacity === 0)) as Array<PPTElement & Rect>;
  if (!boxes.length) return undefined;
  const range = getElementListRange(boxes);
  return { left: range.minX, top: range.minY, width: range.maxX - range.minX, height: range.maxY - range.minY };
}
function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width - 1 && b.left < a.left + a.width - 1
    && a.top < b.top + b.height - 1 && b.top < a.top + a.height - 1;
}
function collisions(content: SlideContent): Map<string, number> {
  const owned = new Set(content.canvas.teachingVisual?.components.flatMap((component) => component.elementIds) ?? []);
  const boxes = content.canvas.teachingVisual?.components.flatMap((component) => {
    const rect = bounds(content.canvas.elements.filter((element) => component.elementIds.includes(element.id)));
    return rect ? [{ id: component.id, ...rect }] : [];
  }) ?? [];
  const manualBoxes = content.canvas.elements.filter((element) => !owned.has(element.id)).flatMap((element) => {
    const rect = bounds([element]);
    return rect ? [{ id: `element:${element.id}`, ...rect }] : [];
  });
  const conflicts = new Map<string, number>();
  boxes.forEach((a, index) => {
    for (const b of [...boxes.slice(index + 1), ...manualBoxes]) {
      if (intersects(a, b)) conflicts.set([a.id, b.id].sort().join('|'),
        (Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
        * (Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)));
    }
  });
  return conflicts;
}

function projectedBounds(content: SlideContent, ids: readonly string[]): Rect | undefined {
  const selectedIds = new Set(ids);
  return bounds(content.canvas.elements.filter((element) => selectedIds.has(element.id)));
}

/** Unowned titles/notes stay intact; old cue targets retain their identities. */
function retainUnownedElements(previous: SlideContent, next: SlideContent): SlideContent {
  const ownedIds = new Set(previous.canvas.teachingVisual?.components.flatMap((component) => component.elementIds) ?? []);
  const unownedIds = new Set(previous.canvas.elements.filter((element) => !ownedIds.has(element.id)).map((element) => element.id));
  const manualIds = new Set(previous.canvas.teachingVisual?.manualElementIds ?? []);
  const elements = next.canvas.elements.filter((element) => !unownedIds.has(element.id)
    && !('opacity' in element && element.opacity === 0 && /:visible-\d+$/.test(element.id)));
  previous.canvas.elements.forEach((element, index) => {
    if (!unownedIds.has(element.id)) return;
    let kept = structuredClone(element);
    if (element.type === 'shape' && element.opacity === 0 && /:visible-\d+$/.test(element.id) && !manualIds.has(element.id)) {
      const sourceIds = Object.entries(previous.canvas.presentationProjection?.elementIdsBySource ?? {}).filter(([, ids]) => {
        const rect = projectedBounds(previous, ids);
        return rect && Math.abs(rect.left - element.left) < 1 && Math.abs(rect.top - element.top) < 1
          && Math.abs(rect.width - element.width) < 1 && Math.abs(rect.height - element.height) < 1;
      }).map(([id]) => id);
      const target = projectedBounds(next, sourceIds.flatMap((id) => next.canvas.presentationProjection?.elementIdsBySource[id] ?? []));
      if (target) kept = { ...kept, ...target };
    }
    elements.splice(Math.min(index, elements.length), 0, kept);
  });
  return { ...next, canvas: { ...next.canvas, elements } };
}

export async function recomposeTeachingVisualSlide(content: SlideContent,
  options: { componentId?: string; candidateId?: string } = {}): Promise<SlideContent> {
  const visual = content.canvas.teachingVisual;
  if (!visual) throw new Error('此页面没有可重新编排的图解构件');
  if (content.canvas.viewportSize !== 1000 || content.canvas.viewportRatio !== 0.5625) {
    throw new Error('当前画布尺寸无法使用这组构图，已保留原页面');
  }
  const page = visual.scene.pages.find((page) => page.id === visual.pageId);
  if (!page) throw new Error('当前页面的图解设计记录不完整');
  const selected = options.componentId ? visual.components.find((component) => component.id === options.componentId) : undefined;
  if (options.componentId && !selected) throw new Error('未找到选中的图解构件');
  if (selected?.locked || selected?.modified) throw new Error('此构件已保留，请先解除锁定或继续直接编辑');
  const localPrevious = options.componentId ? { ...content, canvas: { ...content.canvas,
    teachingVisual: { ...visual, components: visual.components.map((component) => component.id === options.componentId
      ? component : { ...component, locked: true }) } } } : content;
  const originalConflicts = collisions(content);
  const { measure, close } = browserMeasurement();
  try {
    const sourceCatalog = visual.sourceCatalog ?? [];
    const outline: SceneOutline = { id: page.id, type: 'slide', title: page.title, order: 0,
      description: page.focus, keyPoints: sourceCatalog.map((source) => source.text),
      ...(visual.adoptedDiagram ? { visualIntent: { representation: 'native-diagram', observationGoal: page.focus, diagram: visual.adoptedDiagram } } : {}) };
    const previous: GeneratedSlideContent = { ...localPrevious.canvas };
    const resourceIds = new Set(page.components.flatMap((component) => component.resourceId ? [component.resourceId] : []));
    const images = content.canvas.elements.flatMap((element) => {
      if (element.type !== 'image' || !resourceIds.has(element.id)) return [];
      const captionElement = content.canvas.elements.find((item) => item.id === `${element.id}-caption`);
      const caption = captionElement?.type === 'text' ? new DOMParser()
        .parseFromString(captionElement.content.replace(/<br\s*\/?\s*>/gi, '\n'), 'text/html').body.textContent?.trim() : undefined;
      return [{ id: element.id, src: element.src, width: element.width, height: element.height,
        ...(caption ? { caption } : {}) }];
    });
    const candidateIds = options.candidateId ? [options.candidateId]
      : ['visual-1', 'visual-2', 'visual-3'].filter((id) => id !== visual.candidateId);
    for (const candidateId of candidateIds) {
      const next = await compileTeachingVisualScene(outline, { ...visual.scene, pages: [page] },
        { measure, images, sourceCatalog, previous, preferredCandidateId: candidateId,
          allowedCandidateIds: [candidateId], allowSplit: false });
      if (!next || next.teachingVisual?.candidateId !== candidateId) continue;
      let generated: SlideContent = { ...content, canvas: { ...content.canvas, elements: next.elements,
        presentationProjection: next.presentationProjection, teachingVisual: { ...next.teachingVisual,
          scene: visual.scene }, background: next.background, theme: next.theme ?? content.canvas.theme } };
      // A local layout edit freezes the other semantic components. Their source
      // and playback identity is not collateral work for this operation.
      generated = preserveTeachingVisualEdits(localPrevious, generated);
      if (generated === localPrevious) continue;
      generated = retainUnownedElements(content, generated);
      if ([...collisions(generated)].some(([key, area]) => area > (originalConflicts.get(key) ?? 0) + 1)) continue;
      if (options.componentId && generated.canvas.teachingVisual) generated = { ...generated, canvas: { ...generated.canvas,
        teachingVisual: { ...generated.canvas.teachingVisual, components: generated.canvas.teachingVisual.components.map((component) => ({
          ...component, locked: visual.components.find((original) => original.id === component.id)?.locked,
        })) } } };
      if (JSON.stringify(generated.canvas.elements) !== JSON.stringify(content.canvas.elements)) return generated;
    }
    throw new Error('当前内容没有其他可读且保留修改的构图，请继续局部编辑');
  } finally { close(); }
}
