import type { PPTElement } from '@openmaic/dsl';
import type { CourseQualityIssue } from './types';

export type VisibleRect = { left: number; top: number; width: number; height: number };
export type RenderedElement = {
  id: string;
  type: PPTElement['type'];
  box: VisibleRect;
  textRects: VisibleRect[];
  text: string;
  fontSize?: number;
  opacity?: number;
  imageLoaded?: boolean;
  imageType?: 'pageFigure' | 'itemFigure' | 'background';
  opaque?: boolean;
};

const right = (r: VisibleRect) => r.left + r.width;
const bottom = (r: VisibleRect) => r.top + r.height;
const area = (r: VisibleRect) => Math.max(0, r.width) * Math.max(0, r.height);
function intersection(a: VisibleRect, b: VisibleRect): number {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));
}

function contains(outer: VisibleRect, inner: VisibleRect, inset = 0): boolean {
  return inner.left >= outer.left + inset && inner.top >= outer.top + inset
    && right(inner) <= right(outer) - inset && bottom(inner) <= bottom(outer) - inset;
}

/** Uses visible glyph lines, not a text element's mostly-empty outer rectangle. */
export function inspectRenderedSlide(sceneId: string, elements: RenderedElement[], width = 1000, height = 562.5): CourseQualityIssue[] {
  const issues: CourseQualityIssue[] = [];
  function add(code: string, title: string, evidence: string, suggestion: string, elementId?: string) {
    issues.push({ id: `render:${sceneId}:${code}:${elementId ?? 'canvas'}`, origin: 'render', severity: 'suggestion', sceneId, elementId, title, evidence, suggestion, status: 'open' });
  }
  const textItems = elements.filter((item) => item.text.trim() && (item.opacity ?? 1) > 0.05);
  for (const item of textItems) {
    if (!item.textRects.length) {
      add('invisible-text', '文字未能正常显示', '存在教学文字，但没有可见文字行。', '检查字体、透明度和文本布局。', item.id);
      continue;
    }
    if (item.textRects.some((rect) => rect.left < -2 || rect.top < -2 || right(rect) > width + 2 || bottom(rect) > height + 2)) {
      add('overflow', '实际文字超出页面', '渲染后的文字行越过了画布边界。', '调整文本宽度、位置或分页，保留必要结论和条件。', item.id);
    }
    if (item.textRects.some((rect) => bottom(rect) > bottom(item.box) + 6 || right(rect) > right(item.box) + 6 || rect.left < item.box.left - 6)) {
      add('box-overflow', '文字超出原有排版区域', '实际文字行超过文本或图形容器。', '按实际行数重新分配空间，避免与相邻内容相撞。', item.id);
    }
    const visibleCharacters = item.text.replace(/\s+/g, '').length;
    const shortCaption = item.fontSize !== undefined
      && item.fontSize >= 14
      && visibleCharacters <= 40
      && item.textRects.length <= 2;
    if (item.fontSize !== undefined && (item.fontSize < 14 || (item.fontSize < 16 && !shortCaption))) {
      add('small-type', '投屏文字偏小', `可见文字最小字号约为 ${Math.round(item.fontSize)} px。`, '正文至少使用 16 px；不超过两行的简短图注可使用 14–16 px。', item.id);
    }
  }
  for (let i = 0; i < textItems.length; i++) {
    for (let j = i + 1; j < textItems.length; j++) {
      const a = textItems[i], b = textItems[j];
      if (a.textRects.some((ra) => b.textRects.some((rb) => intersection(ra, rb) > Math.min(area(ra), area(rb)) * 0.2))) {
        add(`overlap-${b.id}`, '两处文字相互重叠', `文字 ${a.id} 与 ${b.id} 的实际文字行重叠。`, '重新安排两处内容的位置或尺度。', a.id);
      }
    }
  }
  const reservedTypes: PPTElement['type'][] = ['image', 'shape', 'table', 'chart', 'video', 'code', 'latex'];
  for (const item of textItems) {
    const itemIndex = elements.indexOf(item);
    for (let blockIndex = 0; blockIndex < elements.length; blockIndex++) {
      const block = elements[blockIndex];
      if (block.id === item.id || !reservedTypes.includes(block.type)) continue;
      if (block.type === 'shape' && !block.opaque) continue;
      // An earlier image that contains every visible glyph is a backdrop or
      // labeled illustration. Its pixels cannot cover later-drawn text. Text
      // crossing an image edge still indicates a likely layout collision.
      if (block.type === 'image' && blockIndex < itemIndex
        && item.textRects.every((rect) => contains(block.box, rect, 4))) continue;
      if (
        block.type === 'shape'
        && block.opaque
        && (
          contains(block.box, item.box, 4)
          // Generated diagram labels sometimes use a text box wider than the
          // colored node for alignment, while every rendered glyph remains
          // safely inside that node. Judge what the learner can actually see;
          // otherwise valid OpenMAIC process diagrams become false collisions.
          || item.textRects.every((rect) => contains(block.box, rect, 4))
        )
      ) continue;
      if (item.textRects.some((rect) => intersection(rect, block.box) > area(rect) * 0.08)) {
        add(`collision-${block.id}`, '文字侵入相邻内容区域', `文字 ${item.id} 与 ${block.type} ${block.id} 的实际显示区域相交。`, '为表格、图示和面板分配互不相交的区域；容器内文字应完整留在内边距中。', item.id);
      }
    }
  }
  for (let i = 0; i < elements.length; i++) {
    const item = elements[i];
    if (item.type === 'image' && item.imageLoaded === false) add('image-missing', '图片未能加载', '当前预览中图片无法显示。', '检查图片资源并重试，避免缺图授课。', item.id);
    if (!item.textRects.length) continue;
    for (const cover of elements.slice(i + 1)) {
      if (!cover.opaque || (cover.opacity ?? 1) < 0.85 || !['image', 'shape'].includes(cover.type)) continue;
      if (item.textRects.some((rect) => intersection(rect, cover.box) > area(rect) * 0.5)) {
        add(`occluded-${cover.id}`, '文字可能被图形或图片遮挡', `后绘制的 ${cover.id} 覆盖了文字区域。`, '检查图层顺序和图文关系。', item.id);
      }
    }
  }
  // Ignore title/footer and empty containers. Diagrams and photos count as
  // content; full-page backgrounds and decoration must not mask top-heavy text.
  const bodyRects = elements.flatMap((item) => {
    if (item.type === 'image' && (item.imageType === 'background' || area(item.box) >= width * height * 0.65)) return [];
    const rects = item.textRects.length ? item.textRects : ['image', 'chart', 'table', 'latex', 'code', 'video'].includes(item.type) ? [item.box] : [];
    return rects.filter((rect) => rect.top >= height * 0.22 && rect.top < height * 0.85 && area(rect) < width * height * 0.8);
  });
  if (bodyRects.length) {
    const visibleBottom = Math.max(...bodyRects.map(bottom));
    const visibleTop = Math.min(...bodyRects.map((rect) => rect.top));
    const weightedCenter = bodyRects.reduce((sum, rect) => sum + area(rect) * (rect.top + rect.height / 2), 0)
      / Math.max(1, bodyRects.reduce((sum, rect) => sum + area(rect), 0));
    if (visibleBottom < height * 0.61 || (weightedCenter < height * 0.42 && visibleBottom - visibleTop < height * 0.38)) {
      add('top-heavy', '正文集中在页面上半部', '依据实际文字行和教学图示测量，下半页缺少与主体呼应的内容。', '放大并重排主体，或采用居中的核心观点、概念图布局，保留有意留白。');
    }
  }
  return issues;
}

export function measureSlideElements(root: HTMLElement, elements: readonly PPTElement[]): RenderedElement[] {
  const origin = root.getBoundingClientRect();
  const scaleX = origin.width > 0 ? origin.width / Math.max(1, root.offsetWidth || origin.width) : 1;
  const scaleY = origin.height > 0 ? origin.height / Math.max(1, root.offsetHeight || origin.height) : 1;
  const translate = (rect: DOMRect): VisibleRect => ({ left: (rect.left - origin.left) / scaleX, top: (rect.top - origin.top) / scaleY,
    width: rect.width / scaleX, height: rect.height / scaleY });
  return elements.map((element) => {
    const wrapper = Array.from(root.querySelectorAll<HTMLElement>('[data-review-element]')).find((node) => node.dataset.reviewElement === element.id);
    const visual = wrapper?.querySelector<HTMLElement>('[class*="base-element-"]');
    const box = visual ? translate(visual.getBoundingClientRect())
      : { left: element.left, top: element.top, width: element.width, height: element.type === 'line' ? 0 : element.height };
    if (!wrapper) return { id: element.id, type: element.type, box, text: '', textRects: [] };
    const textRoot = wrapper.querySelector<HTMLElement>('.ProseMirror-static') ?? (['code', 'table', 'latex'].includes(element.type) ? wrapper : null);
    const textRects: VisibleRect[] = [];
    const sizes: number[] = [];
    if (textRoot) {
      const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const style = node.parentElement ? getComputedStyle(node.parentElement) : null;
        if (style?.visibility === 'hidden' || style?.display === 'none' || Number(style?.opacity ?? 1) === 0) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        textRects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map(translate));
        const size = Number.parseFloat(style?.fontSize ?? '');
        if (Number.isFinite(size)) sizes.push(size);
      }
    }
    const images = Array.from(wrapper.querySelectorAll('img'));
    const opaque = element.type === 'image' || (element.type === 'shape' && Boolean(element.fill && element.fill !== 'none' && element.fill !== 'transparent'));
    return { id: element.id, type: element.type, box, textRects, text: textRoot?.textContent ?? '', fontSize: sizes.length ? Math.min(...sizes) : undefined,
      opacity: 'opacity' in element ? element.opacity : 1, opaque,
      imageType: element.type === 'image' ? element.imageType : undefined,
      imageLoaded: element.type === 'image' ? images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0) : undefined };
  });
}
