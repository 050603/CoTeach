import type { PPTElement } from '@openmaic/dsl';

export interface SlideQualityAudit {
  passed: boolean;
  reasons: string[];
}

export type SlideQualityOptions = { canvasWidth?: number; canvasHeight?: number; checkComposition?: boolean };

function plainText(element: PPTElement): string {
  const value = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content : '';
  return (value ?? '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').trim();
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
      const html = element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '';
      const sizes = [...html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((match) => Number(match[1]));
      if (sizes.some((size) => size < 16)) reasons.push(`text ${element.id} is too small for a teaching slide (under 16px)`);
      const fontSize = sizes.length ? Math.min(...sizes) : 20;
      // Conservative lower bound: only reject clearly impossible text boxes.
      const text = plainText(element);
      const cjk = (text.match(/[\u2E80-\u9FFF]/g) ?? []).length;
      const approximateWidth = (cjk + (text.length - cjk) * 0.45) * fontSize;
      const minimumLines = Math.ceil(approximateWidth / Math.max(1, element.width));
      if (element.type !== 'line' && text.length > 25 && minimumLines * fontSize * 1.1 > element.height * 1.5) {
        reasons.push(`text ${element.id} cannot fit its box at the chosen font size`);
      }
    }
    const body = elements.filter((element) => element.top >= 125 && element.top < height - 55 && carriesInstructionalContent(element));
    if (body.length && Math.max(...body.map((element) => bounds(element).bottom)) < height * 0.57) {
      reasons.push('instructional content is clustered in the upper half; rebalance the whole body around the canvas center');
    }
    const textElements = elements.filter((element) => element.type === 'text' && plainText(element));
    for (let i = 0; i < textElements.length; i++) {
      const a = bounds(textElements[i]);
      for (let j = i + 1; j < textElements.length; j++) {
        const b = bounds(textElements[j]);
        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const smallerArea = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
        if (smallerArea > 0 && overlap / smallerArea > 0.3) reasons.push(`text boxes ${textElements[i].id} and ${textElements[j].id} overlap substantially`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
