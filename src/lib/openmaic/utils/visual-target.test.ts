import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVisualTargetGeometry } from './visual-target';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('shared visual target resolver app contract', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves a table cell through the unified data attributes', () => {
    document.body.innerHTML = `
      <section id="canvas">
        <div data-slide-element-id="table"><div class="element-content">
          <table><tbody><tr><td data-slide-cell-id="primary">小学内容</td></tr></tbody></table>
        </div></div>
      </section>`;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    const cell = root.querySelector<HTMLElement>('[data-slide-cell-id="primary"]')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(20, 30, 1000, 500));
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(120, 80, 240, 50));

    expect(
      resolveVisualTargetGeometry(root, { elementId: 'table', selector: { cellId: 'primary' } }),
    ).toEqual({ x: 10, y: 10, w: 24, h: 10, centerX: 22, centerY: 15 });
  });

  it('does not widen stale cell or quote selectors to the whole element', () => {
    document.body.innerHTML = `
      <section id="canvas">
        <div data-slide-element-id="table"><div class="element-content">整张表</div></div>
      </section>`;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    const content = root.querySelector<HTMLElement>('.element-content')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 500));
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 500, 300));

    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'table',
        selector: { cellId: 'covered-merged-cell' },
      }),
    ).toBeNull();
    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'table',
        selector: { quote: '不存在' },
      }),
    ).toBeNull();
  });

  it('scopes a quote to its selected table cell', () => {
    document.body.innerHTML = `
      <section id="canvas">
        <div data-slide-element-id="table"><div class="element-content"><table><tbody><tr>
          <td data-slide-cell-id="other">PBL 在另一个单元格</td>
          <td data-slide-cell-id="lesson">先讲 <span>P</span>BL，再讲 PBL</td>
        </tr></tbody></table></div></div>
      </section>`;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 500));
    const originalCreateRange = document.createRange.bind(document);
    let startParent = '';
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = originalCreateRange();
      Object.defineProperty(range, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          startParent = range.startContainer.parentElement?.tagName.toLowerCase() ?? '';
          return rect(400, 100, 50, 25);
        },
      });
      return range;
    });

    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'table',
        selector: { cellId: 'lesson', quote: 'PBL', occurrence: 0 },
      }),
    ).toEqual({ x: 40, y: 20, w: 5, h: 5, centerX: 42.5, centerY: 22.5 });
    expect(startParent).toBe('span');
    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'table',
        selector: { cellId: 'lesson', quote: '另一个单元格' },
      }),
    ).toBeNull();
  });

  it('finds zero-based repeated quotes across rich-text nodes', () => {
    document.body.innerHTML = `
      <section id="canvas">
        <div data-slide-element-id="copy"><div class="element-content">
          <p><span>P</span><strong>BL</strong> 是项目式学习，</p><p><em>PBL</em> 面向真实问题。</p>
        </div></div>
      </section>`;
    const root = document.querySelector<HTMLElement>('#canvas')!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 1000, 500));
    const boundaries: string[] = [];
    const originalCreateRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = originalCreateRange();
      Object.defineProperty(range, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const start = (range.startContainer.parentElement?.tagName ?? '').toLowerCase();
          const end = (range.endContainer.parentElement?.tagName ?? '').toLowerCase();
          boundaries.push(`${start}:${end}`);
          return rect(310, 145, 50, 25);
        },
      });
      return range;
    });

    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'copy',
        selector: { quote: 'PBL', occurrence: 0 },
      }),
    ).toEqual({ x: 30, y: 25, w: 5, h: 5, centerX: 32.5, centerY: 27.5 });
    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'copy',
        selector: { quote: 'PBL', occurrence: 1 },
      }),
    ).not.toBeNull();
    expect(boundaries).toEqual(['span:strong', 'em:em']);
    expect(
      resolveVisualTargetGeometry(root, {
        elementId: 'copy',
        selector: { quote: 'PBL', occurrence: 2 },
      }),
    ).toBeNull();
  });

  it('isolates duplicate element ids to the explicitly supplied root', () => {
    document.body.innerHTML = `
      <section id="first"><div data-slide-element-id="shared"><div class="element-content">一</div></div></section>
      <section id="second"><div data-slide-element-id="shared"><div class="element-content">二</div></div></section>`;
    const first = document.querySelector<HTMLElement>('#first')!;
    const second = document.querySelector<HTMLElement>('#second')!;
    const firstContent = first.querySelector<HTMLElement>('.element-content')!;
    const secondContent = second.querySelector<HTMLElement>('.element-content')!;
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 500));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 1000, 500));
    vi.spyOn(firstContent, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 30, 40));
    vi.spyOn(secondContent, 'getBoundingClientRect').mockReturnValue(rect(200, 200, 100, 50));

    expect(resolveVisualTargetGeometry(second, { elementId: 'shared' })).toEqual({
      x: 10,
      y: 20,
      w: 10,
      h: 10,
      centerX: 15,
      centerY: 25,
    });
  });
});
