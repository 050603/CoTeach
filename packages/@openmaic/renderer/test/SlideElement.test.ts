import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTTableElement, PPTTextElement } from '../../dsl/src';
import { SlideElement } from '../src/SlideElement';

const textElement: PPTTextElement = {
  id: 'text-1',
  type: 'text',
  left: 24,
  top: 32,
  width: 120,
  height: 48,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
};

describe('SlideElement', () => {
  it('keeps the full-slide root non-interactive and restores events on the visual element target', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: textElement,
        elementIndex: 3,
        onElementClick: vi.fn(),
      }),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('class="slide-element-hit-target"');
    expect(html).toContain('pointer-events:auto');
  });

  it('keeps read-only rendered elements non-interactive so parent cards can receive clicks', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: textElement,
        elementIndex: 3,
      }),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('class="slide-element-hit-target"');
    expect(html).not.toContain('pointer-events:auto');
  });

  it('uses the same text padding and wrapping geometry as generated classroom slides', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: textElement,
        elementIndex: 3,
      }),
    );

    expect(html).toContain('box-sizing:border-box');
    expect(html).toContain('padding:10px');
    expect(html).toContain('overflow-wrap:break-word');
    expect(html).toContain('line-height:1.5');
    expect(html).toContain('--paragraphSpace:5px');
  });

  it('emits stable element and table-cell anchors for scoped visual targeting', () => {
    const tableElement: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      left: 10,
      top: 20,
      width: 400,
      height: 120,
      rotate: 0,
      outline: { color: '#333333', width: 1, style: 'solid' },
      colWidths: [0.5, 0.5],
      cellMinHeight: 40,
      data: [[
        { id: 'cell-a', colspan: 2, rowspan: 2, text: '小学' },
        { id: 'cell-b', colspan: 1, rowspan: 1, text: '低代码' },
      ]],
    };
    const html = renderToStaticMarkup(
      createElement(SlideElement, { elementInfo: tableElement, elementIndex: 1 }),
    );

    expect(html).toContain('data-slide-element-id="table-1"');
    expect(html).toContain('data-slide-cell-id="cell-a"');
    expect(html).toContain('colSpan="2"');
    expect(html).toContain('rowSpan="2"');
    expect(html).toContain('data-slide-cell-id="cell-b"');
  });
});
