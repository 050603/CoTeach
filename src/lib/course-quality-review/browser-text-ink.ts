export type BrowserInkRect = { left: number; top: number; width: number; height: number };

/**
 * DOM ranges contain the font's ascent/descent space, rather than its painted
 * glyphs. Keep DOM wrapping/positions, and measure the font's actual ink at a
 * browser-calibrated baseline. This function is self-contained for Playwright.
 */
export function measureBrowserTextInk(input: { root?: HTMLElement; selector?: string }): {
  rects: BrowserInkRect[];
  exact: boolean;
} {
  const root = input.root ?? document.querySelector<HTMLElement>(input.selector ?? '');
  if (!root) return { rects: [], exact: false };
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return { rects: [], exact: false };
  const rects: BrowserInkRect[] = [];
  const baselineOffsets = new Map<string, number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let exact = true;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? '';
    if (!value.trim() || !node.parentElement) continue;
    const style = getComputedStyle(node.parentElement);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    // A rotated font box cannot establish an axis-aligned glyph baseline.
    // Preserve the existing conservative check in that unsupported case.
    let scaleX = 1;
    let scaleY = 1;
    let supported = style.writingMode === 'horizontal-tb' && style.direction === 'ltr'
      && style.textTransform === 'none' && style.textDecorationLine === 'none' && style.textShadow === 'none'
      && style.fontFeatureSettings === 'normal' && style.fontVariationSettings === 'normal';
    for (let ancestor: HTMLElement | null = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (ancestorStyle.textDecorationLine !== 'none') supported = false;
      const transform = ancestorStyle.transform;
      if (!transform || transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(transform);
      if (Math.abs(matrix.b) > 0.00001 || Math.abs(matrix.c) > 0.00001 || matrix.a <= 0 || matrix.d <= 0) {
        supported = false;
        break;
      }
      scaleX *= matrix.a;
      scaleY *= matrix.d;
    }
    if (!supported) { exact = false; continue; }
    const font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.font = font;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    context.direction = style.direction === 'rtl' ? 'rtl' : 'ltr';
    const signature = JSON.stringify([font, style.fontFeatureSettings, style.fontVariationSettings]);
    let baselineOffset = baselineOffsets.get(signature);
    if (baselineOffset === undefined) {
      // An isolated, zero-height inline marker gives the true DOM baseline,
      // without splitting or reshaping the learner-visible text.
      const probe = document.createElement('div');
      probe.style.cssText = 'all:initial;position:fixed;left:-10000px;top:0;width:max-content;white-space:pre;visibility:hidden;pointer-events:none;';
      probe.style.font = font;
      probe.style.fontFeatureSettings = style.fontFeatureSettings;
      probe.style.fontVariationSettings = style.fontVariationSettings;
      const sample = document.createTextNode('Hg');
      const marker = document.createElement('span');
      marker.style.cssText = 'all:initial;display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
      probe.append(sample, marker);
      document.body.append(probe);
      const sampleRange = document.createRange();
      sampleRange.selectNodeContents(sample);
      const fontBox = sampleRange.getBoundingClientRect();
      baselineOffset = marker.getBoundingClientRect().top - fontBox.top;
      probe.remove();
      if (!Number.isFinite(baselineOffset) || baselineOffset <= 0) { exact = false; continue; }
      baselineOffsets.set(signature, baselineOffset);
    }
    for (const part of segmenter.segment(value)) {
      if (!part.segment.trim()) continue;
      const range = document.createRange();
      range.setStart(node, part.index);
      range.setEnd(node, part.index + part.segment.length);
      const fontBox = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
      if (!fontBox) continue;
      const metrics = context.measureText(part.segment);
      const inkWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
      const inkHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      if (![inkWidth, inkHeight].every(Number.isFinite)) { exact = false; continue; }
      if (inkWidth <= 0 || inkHeight <= 0) continue;
      const baseline = fontBox.top + baselineOffset * scaleY;
      rects.push({ left: fontBox.left - metrics.actualBoundingBoxLeft * scaleX,
        top: baseline - metrics.actualBoundingBoxAscent * scaleY,
        width: inkWidth * scaleX, height: inkHeight * scaleY });
    }
  }
  return { rects, exact };
}
