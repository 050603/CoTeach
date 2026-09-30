import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';

type Rect = { left: number; top: number; width: number; height: number };

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.left <= inner.left && outer.top <= inner.top
    && outer.left + outer.width >= inner.left + inner.width
    && outer.top + outer.height >= inner.top + inner.height;
}

function overlapShare(a: Rect, b: Rect): number {
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 ? overlapArea(a, b) / smallerArea : 0;
}

function isForegroundText(element: PPTElement): element is PPTTextElement | PPTShapeElement {
  return (element.type === 'text' && Boolean(element.content?.trim()))
    || (element.type === 'shape' && Boolean(element.text?.content?.trim()));
}

function isContentPanel(element: PPTElement): element is PPTShapeElement {
  return element.type === 'shape' && !element.text?.content?.trim()
    && Boolean(element.fill && element.fill !== 'none' && element.fill !== 'transparent')
    && (element.opacity ?? 1) >= 0.85
    && element.width >= 120 && element.height >= 60;
}

/** Reject major peer-region collisions before an authored slide becomes a saved page. */
export function nativeSlideCollisions(elements: readonly PPTElement[]): string[] {
  const findings: string[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const first = elements[index]!;
    for (let next = index + 1; next < elements.length; next += 1) {
      const second = elements[next]!;
      if (isForegroundText(first) && isForegroundText(second)
        && overlapShare(first, second) > 0.3) {
        findings.push(`native text ${first.id} overlaps ${second.id}; give these teaching statements separate, non-overlapping rectangles`);
      } else if (isContentPanel(first) && isContentPanel(second)
        && !contains(first, second) && !contains(second, first)
        && overlapShare(first, second) > 0.18) {
        findings.push(`native content panels ${first.id} and ${second.id} overlap; place peer panels in separate regions`);
      }
      if (findings.length >= 4) return findings;
    }
  }
  return findings;
}
