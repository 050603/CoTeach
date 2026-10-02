import type { PPTElement } from '@openmaic/dsl';

type Rect = { left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };

/** Diagnostic measurements from the actual renderer. Arrow paths are sampled
 * from native SVG geometry, including broken/curved routes; text is grouped
 * using per-character DOM ranges, not estimated string lengths. These signals
 * support a human visual review and never substitute for beauty acceptance. */
export function inspectApprovedVisualRendering(canvas: HTMLElement, elements: readonly PPTElement[]) {
  const origin = canvas.getBoundingClientRect(), scale = origin.width / 1000;
  const wrappers = [...canvas.querySelectorAll<HTMLElement>('[data-review-element]')];
  const rect = (value: DOMRect): Rect => ({ left: (value.left - origin.left) / scale, top: (value.top - origin.top) / scale,
    width: value.width / scale, height: value.height / scale });
  const characters: Array<{ elementId: string; character: string; box: Rect }> = [];
  const textLines: Array<{ elementId: string; text: string; lines: Array<{ text: string; top: number; left: number; right: number }>; diagnostics: string[] }> = [];
  for (const definition of elements) {
    const wrapper = wrappers.find((node) => node.dataset.reviewElement === definition.id);
    const textRoot = wrapper?.querySelector('.ProseMirror-static');
    if (!textRoot) continue;
    const lines: Array<{ text: string; top: number; left: number; right: number }> = [];
    const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const style = node.parentElement ? getComputedStyle(node.parentElement) : null;
      if (style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity ?? 1) === 0) continue;
      let offset = 0;
      for (const character of Array.from(node.textContent ?? '')) {
        const range = document.createRange(); range.setStart(node, offset); offset += character.length; range.setEnd(node, offset);
        const actual = range.getBoundingClientRect();
        if (!actual.width || !actual.height) continue;
        const box = rect(actual);
        let line = lines.find((item) => Math.abs(item.top - box.top) < 2);
        if (!line) { line = { text: '', top: box.top, left: box.left, right: box.left + box.width }; lines.push(line); }
        line.text += character; line.left = Math.min(line.left, box.left); line.right = Math.max(line.right, box.left + box.width);
        if (character.trim()) characters.push({ elementId: definition.id, character, box });
      }
    }
    lines.sort((a, b) => a.top - b.top);
    const nonempty = lines.filter((item) => item.text.trim());
    const last = nonempty.at(-1)?.text.trim() ?? '', diagnostics: string[] = [];
    if (nonempty.length > 1 && /^\p{Script=Han}[\p{Punctuation}\s]*$/u.test(last)) diagnostics.push('single-cjk-character-last-line');
    if (nonempty.length > 2 && /^[A-Za-z]+[\p{Punctuation}\s]*$/u.test(last)) diagnostics.push('single-english-word-last-line');
    if (nonempty.length >= 6 || (nonempty.length >= 4 && nonempty.map((item) => item.text).join('').length >= 110)) diagnostics.push('dense-paragraph-review');
    textLines.push({ elementId: definition.id, text: textRoot.textContent ?? '', lines: nonempty, diagnostics });
  }
  const linePaths: Array<{ elementId: string; directed: boolean; points: Point[]; start?: Point; end?: Point; diagnostic?: string }> = [];
  const lineTextIntersections: Array<{ lineId: string; textElementId: string; text: string; characterCount: number }> = [];
  for (const definition of elements.filter((element) => element.type === 'line')) {
    const wrapper = wrappers.find((node) => node.dataset.reviewElement === definition.id);
    const path = wrapper?.querySelector<SVGPathElement>('svg > path[fill="none"]');
    const matrix = path?.getScreenCTM();
    if (!path || !matrix) { linePaths.push({ elementId: definition.id, directed: definition.points.some(Boolean), points: [], diagnostic: 'actual-svg-path-not-measurable' }); continue; }
    const length = path.getTotalLength(), count = Math.max(2, Math.ceil(length / 2));
    const points = Array.from({ length: count + 1 }, (_, index) => {
      const value = path.getPointAtLength(length * index / count).matrixTransform(matrix);
      return { x: (value.x - origin.left) / scale, y: (value.y - origin.top) / scale };
    });
    linePaths.push({ elementId: definition.id, directed: definition.points.some(Boolean), points, start: points[0], end: points.at(-1) });
    const hits = characters.filter(({ box }) => points.some((point) => point.x > box.left + Math.min(1, box.width / 4)
      && point.x < box.left + box.width - Math.min(1, box.width / 4)
      && point.y > box.top + 1 && point.y < box.top + box.height - 1));
    for (const id of new Set(hits.map((hit) => hit.elementId))) {
      const matches = hits.filter((hit) => hit.elementId === id);
      lineTextIntersections.push({ lineId: definition.id, textElementId: id,
        text: matches.map((hit) => hit.character).join(''), characterCount: matches.length });
    }
  }
  return { method: '实际DOM逐字符Range与实际SVG路径/CTM，线段每2px采样；不代替逐页美观判断。',
    textLines, linePaths, lineTextIntersections,
    limitations: ['字形Range是字形排版包围盒，内侧采样仍可能把字的留白计为相交；命中需实际图像复核。',
      '箭头marker头部不在中心线轨迹内，箭头端点/完整阅读路径仍需逐图核对。',
      '英文孤词、密集正文是评审提示，公式、单位和必要条件可能需要较多文字；不自动删除或缩字。'],
    beautyAcceptance: 'pending' };
}
