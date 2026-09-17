// @vitest-environment node
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from './StaticTable';

describe('StaticTable visual target anchors', () => {
  it('exposes stable cell ids, including the anchor of a merged cell', () => {
    const element = {
      id: 'table',
      type: 'table',
      left: 0,
      top: 0,
      width: 400,
      height: 200,
      rotate: 0,
      cellMinHeight: 40,
      colWidths: [0.5, 0.5],
      data: [
        [
          { id: 'heading', text: '标题', colspan: 2, rowspan: 1 },
          { id: 'covered', text: '', colspan: 1, rowspan: 1 },
        ],
        [
          { id: 'primary', text: '小学', colspan: 1, rowspan: 1 },
          { id: 'secondary', text: '中学', colspan: 1, rowspan: 1 },
        ],
      ],
    } as PPTTableElement;

    const html = renderToStaticMarkup(createElement(StaticTable, { elementInfo: element }));
    expect(html).toContain('data-slide-cell-id="heading"');
    expect(html).toContain('data-cell-id="heading"');
    expect(html).not.toContain('data-slide-cell-id="covered"');
    expect(html).not.toContain('data-cell-id="covered"');
    expect(html).toContain('data-slide-cell-id="primary"');
    expect(html).toContain('data-slide-cell-id="secondary"');
    expect(html).toContain('data-cell-id="primary"');
    expect(html).toContain('data-cell-id="secondary"');
  });

  it('keeps single-line body text within the default 30px row contract', () => {
    const element = {
      id: 'compact-table',
      type: 'table',
      left: 0,
      top: 0,
      width: 400,
      height: 60,
      rotate: 0,
      cellMinHeight: 30,
      colWidths: [1],
      outline: { width: 1, style: 'solid', color: '#E2E8F0' },
      data: [[
        {
          id: 'cell',
          text: '不缩小字号的正文',
          colspan: 1,
          rowspan: 1,
          style: { fontsize: '16px' },
        },
      ]],
    } as PPTTableElement;

    const html = renderToStaticMarkup(createElement(StaticTable, { elementInfo: element }));
    expect(html).toContain('height:30px');
    expect(html).toContain('padding:1px 5px');
    expect(html).toContain('font-size:16px');
    expect(html).toContain('不缩小字号的正文');
  });
});
