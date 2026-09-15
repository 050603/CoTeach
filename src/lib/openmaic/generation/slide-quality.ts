import type { PPTElement } from '@openmaic/dsl';

export interface SlideQualityAudit {
  passed: boolean;
  reasons: string[];
}

export type SlideQualityOptions = { canvasWidth?: number; canvasHeight?: number; checkComposition?: boolean };

function plainText(element: PPTElement): string {
  const value = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content : '';
  return decodeHtmlText((value ?? '').replace(/<[^>]+>/g, ' ')).trim();
}

function textHtml(element: PPTElement): string {
  return element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '';
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function textLayout(element: PPTElement): {
  fontSize: number;
  lines: number;
  requiredHeight: number;
  paragraphLines: number[];
  paragraphText: string[];
  paragraphVisualUnits: number[];
  lineCapacity: number;
} | null {
  if (element.type !== 'text' && element.type !== 'shape') return null;
  const text = plainText(element);
  if (!text) return null;
  const html = textHtml(element);
  const sizes = [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((match) => Number(match[1]));
  const fontSize = sizes.length ? Math.max(...sizes) : 20;
  const paragraphText = html
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeHtmlText(line).trimEnd())
    .filter((line) => line.trim());
  // The renderer uses 10px padding on each side. CJK glyphs are estimated a
  // little wider than one nominal font-size unit, so another arbitrary 75%
  // multiplier here double-counted safety and inflated otherwise valid boxes.
  const safeWidth = Math.max(1, element.width - 20);
  const paragraphVisualUnits = paragraphText.map((line) => {
    const cjk = (line.match(/[\u2E80-\u9FFF]/g) ?? []).length;
    const latin = line.length - cjk;
    return cjk * 1.05 + latin * 0.58;
  });
  const lineCapacity = safeWidth / fontSize;
  const paragraphLines = paragraphVisualUnits.map((units) => Math.max(1, Math.ceil(units / lineCapacity)));
  const lines = Math.max(1, ...paragraphLines);
  const totalLines = Math.max(1, paragraphLines.reduce((sum, count) => sum + count, 0));
  const paragraphSpace = element.type === 'text' ? element.paragraphSpace : element.text?.paragraphSpace;
  const paragraphSpacing = Math.max(0, paragraphText.length - 1) * (paragraphSpace ?? 5);
  // Match the classroom renderer: 10px internal padding on both vertical
  // edges and a 1.5 line height. This is also the OpenMAIC prompt's published
  // lookup-table model (18px one-line text needs about 49px, 26px needs 61px).
  return { fontSize, lines, paragraphLines, paragraphText, paragraphVisualUnits, lineCapacity,
    requiredHeight: Math.ceil(totalLines * fontSize * 1.5 + 22 + paragraphSpacing) };
}

/**
 * Text rendering is auto-height, while the DSL box height is also used for
 * selection, collision checks and animation targets. Bring generated text
 * boxes up to the renderer's measured minimum before auditing the composition;
 * any resulting collision or canvas overflow is still rejected below.
 */
export function fitGeneratedTextBoxHeights(input: readonly PPTElement[]): PPTElement[] {
  return input.map((element) => {
    if (element.type !== 'text' || element.vertical || element.rotate) return element;
    const layout = textLayout(element);
    if (!layout || element.height >= layout.requiredHeight) return element;
    return { ...element, height: layout.requiredHeight };
  });
}

function estimatedTextBounds(element: PPTElement) {
  const box = bounds(element);
  const layout = textLayout(element);
  return layout ? { ...box, bottom: Math.max(box.bottom, element.top + layout.requiredHeight) } : box;
}

function estimatedTextInkBounds(element: PPTElement) {
  const box = estimatedTextBounds(element);
  const layout = textLayout(element);
  if (!layout || box.right - box.left <= 20) return box;
  return {
    left: box.left + 10,
    top: box.top + 10,
    right: box.right - 10,
    bottom: Math.min(box.bottom - 10, element.top + layout.requiredHeight - 12),
  };
}

function overlapArea(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function overlapDimensions(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) {
  return {
    width: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
    height: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
  };
}

function boxArea(box: ReturnType<typeof bounds>): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
}

function boxContains(outer: ReturnType<typeof bounds>, inner: ReturnType<typeof bounds>, inset = 0): boolean {
  return inner.left >= outer.left + inset && inner.top >= outer.top + inset
    && inner.right <= outer.right - inset && inner.bottom <= outer.bottom - inset;
}

function isOpaqueShape(element: PPTElement): boolean {
  return element.type === 'shape'
    && Boolean(element.fill && element.fill !== 'none' && element.fill !== 'transparent')
    && (element.opacity ?? 1) >= 0.85;
}

function isContentBlock(element: PPTElement): boolean {
  return ['image', 'table', 'chart', 'video', 'code', 'latex'].includes(element.type)
    || isOpaqueShape(element);
}

function tableNeedsMoreHeight(element: Extract<PPTElement, { type: 'table' }>): boolean {
  if (!element.data.length) return false;
  const widths = element.colWidths?.length ? element.colWidths : Array.from({ length: element.data[0]?.length || 1 }, () => 1 / (element.data[0]?.length || 1));
  let required = 0;
  for (const row of element.data) {
    let column = 0;
    let rowHeight = 0;
    for (const cell of row) {
      const span = Math.max(1, cell.colspan ?? 1);
      const cellWidth = element.width * widths.slice(column, column + span).reduce((sum, value) => sum + value, 0);
      const rawSize = cell.style?.fontsize;
      const fontSize = typeof rawSize === 'number' ? rawSize : Number.parseFloat(rawSize ?? '20') || 20;
      const text = cell.text ?? '';
      const cjk = (text.match(/[\u2E80-\u9FFF]/g) ?? []).length;
      const visualWidth = (cjk * 1.05 + (text.length - cjk) * 0.58) * fontSize;
      // Table cells already reserve 5px padding per side in the classroom
      // renderer. Applying the prompt's planning margin a second time made
      // normal tables look 25% narrower and caused endless false repairs.
      const lines = Math.max(1, Math.ceil(visualWidth / Math.max(1, cellWidth - 10)));
      rowHeight = Math.max(rowHeight, lines * fontSize * 1.5 + 10);
      column += span;
    }
    required += Math.max(element.cellMinHeight ?? 0, rowHeight);
  }
  return required > element.height + 3;
}

function bounds(element: PPTElement) {
  if (element.type === 'line') {
    const xs = [0, element.start?.[0] ?? 0, element.end?.[0] ?? 0];
    const ys = [0, element.start?.[1] ?? 0, element.end?.[1] ?? 0];
    return { left: element.left + Math.min(...xs), top: element.top + Math.min(...ys),
      right: element.left + Math.max(...xs), bottom: element.top + Math.max(...ys) };
  }
  return { left: element.left, top: element.top, right: element.left + element.width, bottom: element.top + element.height };
}

/** Compact only isolated sparse text: an oversized empty box is not visible content.
 * This conservative draft estimate is followed by real DOM measurement in teacher preview.
 * Diagrams, containers and mixed-media compositions retain their geometry.
 */
function compactSparseTextBoxes(elements: readonly PPTElement[]): PPTElement[] {
  const body = elements.filter((element) => element.top >= 125);
  if (!body.length || body.length > 3 || body.some((element) => element.type !== 'text')
    || body.reduce((sum, element) => sum + plainText(element).length, 0) > 160) return [...elements];
  return elements.map((element) => {
    if (!body.includes(element) || element.type !== 'text' || element.vertical || element.rotate || element.fill || element.outline) return element;
    const sizes = [...element.content.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((match) => Number(match[1]));
    const fontSize = Math.max(24, ...sizes);
    const paragraphs = element.content.replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '').split('\n').filter((line) => line.trim());
    const lines = paragraphs.reduce((sum, line) => {
      const cjk = (line.match(/[\u2E80-\u9FFF]/g) ?? []).length;
      return sum + Math.max(1, Math.ceil((cjk + (line.length - cjk) * 0.55) * fontSize / Math.max(1, element.width - 20)));
    }, 0);
    const estimatedHeight = Math.ceil(24 + lines * fontSize * Math.max(1.5, element.lineHeight ?? 1.5) + Math.max(0, paragraphs.length - 1) * (element.paragraphSpace ?? 5));
    return estimatedHeight < element.height * 0.7 ? { ...element, height: estimatedHeight } : element;
  });
}

/** Move a sparse, top-heavy body as one group, preserving relative content positions. */
export function balanceSparseSlideLayout(input: readonly PPTElement[], canvasHeight = 562.5): PPTElement[] {
  const elements = compactSparseTextBoxes(input);
  const body = elements.filter((element) => element.top >= 125 && bounds(element).bottom <= canvasHeight - 35);
  const content = body.filter(carriesInstructionalContent);
  if (!content.length) return [...elements];
  // Never pull a label out of a containing model or shape that straddles the
  // title/body boundary. Full-canvas backgrounds are not semantic containers.
  if (elements.some((element) => element.top < 125 && bounds(element).bottom > 145
    && element.type !== 'text' && !(element.width >= 950 && bounds(element).bottom - element.top >= canvasHeight * 0.9))) return [...elements];
  // A hero image/model crossing the title region owns its original composition.
  if (elements.some((element) => element.top < 125 && element.type !== 'text' && carriesInstructionalContent(element))) return [...elements];
  const top = Math.min(...body.map((element) => bounds(element).top));
  const bottom = Math.max(...body.map((element) => bounds(element).bottom));
  if (bottom >= canvasHeight * 0.66 || bottom - top > canvasHeight * 0.45) return [...elements];
  const shift = Math.round((canvasHeight + 125 - 45) / 2 - (top + bottom) / 2);
  if (shift <= 12) return [...elements];
  const selected = new Set(body);
  return elements.map((element) => selected.has(element) ? { ...element, top: element.top + shift } : element);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasRenderableGeometry(element: PPTElement): boolean {
  if (!finite(element.left) || !finite(element.top) || !finite(element.width)) return false;
  if (element.left < 0 || element.top < 0 || element.width <= 0) return false;
  if (element.type === 'line') return true;
  return finite(element.height) && element.height > 0;
}

function visibleText(value: unknown): boolean {
  return typeof value === 'string'
    && value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').trim().length > 0;
}

function carriesInstructionalContent(element: PPTElement): boolean {
  switch (element.type) {
    case 'text':
      return visibleText(element.content);
    case 'shape':
      return visibleText(element.text?.content);
    case 'image':
      return visibleText(element.src);
    case 'latex':
      return visibleText(element.latex) || visibleText(element.html);
    case 'chart':
    case 'table':
    case 'video':
    case 'audio':
    case 'code':
      return true;
    case 'line':
      return false;
  }
}

/** Reject concrete rendering failures; do not pretend geometry proves factual accuracy. */
export function auditGeneratedSlide(elements: ReadonlyArray<PPTElement>, options: SlideQualityOptions = {}): SlideQualityAudit {
  const reasons: string[] = [];
  if (elements.length === 0) reasons.push('slide contains no elements');

  const invalidGeometryCount = elements.filter((element) => !hasRenderableGeometry(element)).length;
  if (invalidGeometryCount > 0) {
    reasons.push(`${invalidGeometryCount} element(s) have invalid render geometry`);
  }
  if (elements.length > 0 && !elements.some(carriesInstructionalContent)) {
    reasons.push('slide contains only decorative shapes or lines');
  }

  const width = options.canvasWidth ?? 1000;
  const height = options.canvasHeight ?? 562.5;
  const outside = elements.filter((element) => {
    const box = bounds(element);
    return box.left < -2 || box.top < -2 || box.right > width + 2 || box.bottom > height + 2;
  });
  if (outside.length) reasons.push(`${outside.length} element(s) extend outside the slide canvas`);

  if (options.checkComposition) {
    const texts = elements.filter((element) => plainText(element));
    const totalText = texts.reduce((sum, element) => sum + plainText(element).length, 0);
    if (totalText > 750) reasons.push('slide has too much visible text; keep core evidence and move expanded explanation to narration');
    for (const element of texts) {
      if (element.type === 'line') continue;
      const layout = textLayout(element);
      if (!layout) continue;
      if (layout.fontSize < 16) reasons.push(`text ${element.id} is too small for a teaching slide (under 16px)`);
      if (layout.requiredHeight > element.height + 3) {
        reasons.push(`text ${element.id} needs at least ${layout.requiredHeight}px height after wrapping, but its box is ${Math.round(element.height)}px`);
      }
      const unexpectedlyWrapped = layout.paragraphLines.some((lineCount, index) => {
        const text = layout.paragraphText[index]?.trim() ?? '';
        const trailingUnits = (layout.paragraphVisualUnits[index] ?? 0) - layout.lineCapacity * (lineCount - 1);
        // A planned two-line node is valid. Reject the visibly accidental case
        // where wrapping strands only one or two glyph-equivalents on the last
        // line, which is what the reported labels exhibited.
        return lineCount > 1 && text.length <= 20 && element.width <= 240
          && trailingUnits <= Math.min(2.2, layout.lineCapacity * 0.28);
      });
      if (unexpectedlyWrapped) {
        reasons.push(`short label ${element.id} wraps unexpectedly; widen it or add an intentional line break at a meaningful boundary`);
      }
    }
    for (const element of elements) {
      if (element.type !== 'line') continue;
      const span = Math.hypot((element.end?.[0] ?? 0) - (element.start?.[0] ?? 0), (element.end?.[1] ?? 0) - (element.start?.[1] ?? 0));
      if (span < 16 && !(element.points ?? []).some((point) => point === 'arrow' || point === 'dot')) {
        reasons.push(`line ${element.id} is an isolated short mark, not a meaningful connector`);
      }
    }
    for (const element of elements) {
      if (element.type === 'table' && tableNeedsMoreHeight(element)) {
        reasons.push(`table ${element.id} cannot fit its cell text at the chosen font size; increase row/table height or simplify optional wording`);
      }
    }
    const body = elements.filter((element) => element.top >= 125 && element.top < height - 55 && carriesInstructionalContent(element));
    if (body.length && Math.max(...body.map((element) => bounds(element).bottom)) < height * 0.57) {
      reasons.push('instructional content is clustered in the upper half; rebalance the whole body around the canvas center');
    }
    const textElements = elements.filter((element) => plainText(element));
    for (let i = 0; i < textElements.length; i++) {
      const a = estimatedTextBounds(textElements[i]);
      for (let j = i + 1; j < textElements.length; j++) {
        const b = estimatedTextBounds(textElements[j]);
        const overlap = overlapArea(a, b);
        const smallerArea = Math.min(boxArea(a), boxArea(b));
        if (smallerArea > 0 && overlap / smallerArea > 0.3) reasons.push(`text boxes ${textElements[i].id} and ${textElements[j].id} overlap substantially`);
      }
    }
    // Tables, charts, media and code own their rectangles. A label may live in
    // an earlier opaque shape only when it is fully contained with padding;
    // partial intersections are layout failures regardless of paint order.
    for (const textElement of textElements) {
      const textBox = estimatedTextInkBounds(textElement);
      for (const block of elements) {
        if (block.id === textElement.id || !isContentBlock(block)) continue;
        const blockBox = bounds(block);
        const overlap = overlapArea(textBox, blockBox);
        if (!overlap) continue;
        if (block.type === 'shape' && boxContains(blockBox, textBox, 6)) continue;
        const overlapSize = overlapDimensions(textBox, blockBox);
        // DSL boxes include padding and line-height leading. Shallow edge
        // contact is not visible-ink collision; browser review later measures
        // the real glyph rectangles.
        if (overlapSize.width <= 12 || overlapSize.height <= 12) continue;
        if (overlap / Math.max(1, boxArea(textBox)) > 0.08) {
          reasons.push(`text ${textElement.id} collides with ${block.type} ${block.id}; keep the label outside its reserved rectangle or fully inside its intended background`);
        }
      }
    }
    // Content panels must not be stacked over one another. Full-canvas and
    // nested background shapes are allowed because one rectangle contains the
    // other; partially intersecting panels create the failures seen in class.
    const contentBlocks = elements.filter(isContentBlock);
    for (let i = 0; i < contentBlocks.length; i++) {
      const a = bounds(contentBlocks[i]);
      for (let j = i + 1; j < contentBlocks.length; j++) {
        const b = bounds(contentBlocks[j]);
        if (boxContains(a, b) || boxContains(b, a)) continue;
        const overlap = overlapArea(a, b);
        const smaller = Math.min(boxArea(a), boxArea(b));
        if (smaller > 0 && overlap / smaller > 0.18) {
          reasons.push(`content blocks ${contentBlocks[i].id} and ${contentBlocks[j].id} overlap; allocate non-intersecting rectangles on the slide grid`);
        }
      }
    }
    for (let i = 0; i < elements.length; i++) {
      const item = elements[i];
      if (!plainText(item)) continue;
      const textBox = estimatedTextBounds(item);
      for (const cover of elements.slice(i + 1)) {
        const opaque = cover.type === 'image'
          || (cover.type === 'shape' && Boolean(cover.fill && cover.fill !== 'none' && cover.fill !== 'transparent'));
        if (!opaque || ('opacity' in cover && (cover.opacity ?? 1) < 0.85)) continue;
        if (overlapArea(textBox, bounds(cover)) > boxArea(textBox) * 0.5) {
          reasons.push(`text ${item.id} is covered by later ${cover.type} ${cover.id}`);
        }
      }
    }
  }

  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
