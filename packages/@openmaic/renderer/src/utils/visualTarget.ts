import type { VisualTargetSelector } from '@openmaic/dsl';
import type { PercentageGeometry } from './geometry';

export interface VisualTarget {
  elementId: string;
  selector?: VisualTargetSelector;
}

/** DOM target resolved inside one slide root. */
export interface ResolvedVisualTarget {
  /** Actual element or text-range bounds in viewport coordinates. */
  rect: DOMRect;
  /** Individual rendered line fragments for a quote target. */
  textRects?: DOMRect[];
  /** Element whose layout changes can invalidate `rect`. */
  observeElement: HTMLElement;
}

export interface ResolveVisualTargetGeometryOptions {
  /** Use the first rendered quote fragment so a pointer never lands between lines. */
  quoteRect?: 'bounds' | 'first-fragment';
}

const ELEMENT_ID_ATTRIBUTE = 'data-slide-element-id';
const CELL_ID_ATTRIBUTE = 'data-slide-cell-id';
const ROW_INDEX_ATTRIBUTE = 'data-slide-row-index';

function findByDataAttribute(
  root: HTMLElement,
  attribute: string,
  value: string,
): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (candidate.getAttribute(attribute) === value) return candidate;
  }
  return null;
}

function findQuoteRange(scope: HTMLElement, quote: string, occurrence: number): Range | null {
  if (!quote || !Number.isInteger(occurrence) || occurrence < 0) return null;

  const document = scope.ownerDocument;
  const walker = document.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = '';
  let current: Node | null;

  while ((current = walker.nextNode())) {
    const node = current as Text;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }

  let matchStart = -1;
  let fromIndex = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    matchStart = text.indexOf(quote, fromIndex);
    if (matchStart < 0) return null;
    fromIndex = matchStart + quote.length;
  }

  const matchEnd = matchStart + quote.length;
  const startNode = nodes.find(({ start, end }) => matchStart >= start && matchStart < end);
  const endNode = nodes.find(({ start, end }) => matchEnd > start && matchEnd <= end);
  if (!startNode || !endNode) return null;

  const range = document.createRange();
  range.setStart(startNode.node, matchStart - startNode.start);
  range.setEnd(endNode.node, matchEnd - endNode.start);
  return range;
}

export function visualTargetRectToPercentageGeometry(
  rootRect: DOMRect,
  targetRect: DOMRect,
): PercentageGeometry | null {
  if (
    rootRect.width <= 0
    || rootRect.height <= 0
    || targetRect.width <= 0
    || targetRect.height <= 0
  ) {
    return null;
  }

  const x = ((targetRect.left - rootRect.left) / rootRect.width) * 100;
  const y = ((targetRect.top - rootRect.top) / rootRect.height) * 100;
  const w = (targetRect.width / rootRect.width) * 100;
  const h = (targetRect.height / rootRect.height) * 100;
  if (![x, y, w, h].every(Number.isFinite)) return null;

  return { x, y, w, h, centerX: x + w / 2, centerY: y + h / 2 };
}

/**
 * Resolve an effect target strictly inside one rendered slide root.
 * Fine-grained selectors intentionally return `null` when stale or invalid;
 * callers must not fall back to the enclosing element because that produces a
 * confident-looking cue for the wrong content.
 */
export function resolveVisualTarget(
  root: HTMLElement,
  target: VisualTarget,
): ResolvedVisualTarget | null {
  const element = findByDataAttribute(root, ELEMENT_ID_ATTRIBUTE, target.elementId);
  if (!element) return null;

  let targetElement: HTMLElement;
  if (target.selector && 'cellId' in target.selector) {
    const cell = findByDataAttribute(element, CELL_ID_ATTRIBUTE, target.selector.cellId);
    if (!cell) return null;
    targetElement = cell;
  } else if (target.selector && 'rowIndex' in target.selector) {
    const row = findByDataAttribute(
      element,
      ROW_INDEX_ATTRIBUTE,
      String(target.selector.rowIndex),
    );
    if (!row) return null;
    targetElement = row;
  } else {
    targetElement = element.querySelector<HTMLElement>('.element-content') ?? element;
  }

  if (target.selector?.quote !== undefined) {
    const quoteScope = targetElement;
    const range = findQuoteRange(
      quoteScope,
      target.selector.quote,
      target.selector.occurrence ?? 0,
    );
    if (!range) return null;
    const textRects = typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
      : [];
    return {
      rect: range.getBoundingClientRect(),
      textRects,
      observeElement: quoteScope,
    };
  }

  return { rect: targetElement.getBoundingClientRect(), observeElement: targetElement };
}

/** Convert a resolved DOM target to the renderer's percentage coordinate system. */
export function resolveVisualTargetGeometry(
  root: HTMLElement,
  target: VisualTarget,
  options: ResolveVisualTargetGeometryOptions = {},
): PercentageGeometry | null {
  const resolved = resolveVisualTarget(root, target);
  if (!resolved) return null;
  const targetRect = options.quoteRect === 'first-fragment'
    ? (resolved.textRects?.[0] ?? resolved.rect)
    : resolved.rect;
  return visualTargetRectToPercentageGeometry(root.getBoundingClientRect(), targetRect);
}

export function visualTargetKey(target: VisualTarget): string {
  const selector = target.selector;
  if (!selector) return target.elementId;
  if ('cellId' in selector) {
    const quoteKey = selector.quote === undefined
      ? ''
      : `:quote:${selector.occurrence ?? 0}:${selector.quote}`;
    return `${target.elementId}:cell:${selector.cellId}${quoteKey}`;
  }
  if ('rowIndex' in selector) {
    const quoteKey = selector.quote === undefined
      ? ''
      : `:quote:${selector.occurrence ?? 0}:${selector.quote}`;
    return `${target.elementId}:row:${selector.rowIndex}${quoteKey}`;
  }
  return `${target.elementId}:quote:${selector.occurrence ?? 0}:${selector.quote}`;
}
