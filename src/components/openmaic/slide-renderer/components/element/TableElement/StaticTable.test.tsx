// @vitest-environment node
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from './StaticTable';
import { tableCellLayout } from './tableUtils';

describe('StaticTable visual target anchors', () => {
  it('retains every compact rowspan cell in its actual logical column', () => {
    const cell = (id: string, text: string, rowspan = 1, colspan = 1) => ({
      id, text, rowspan, colspan, style: { fontsize: '16px', bold: true, color: '#334155' },
    });
    const data = [
      [cell('stage', '阶段'), cell('point', '要点'), cell('detail', '关键做法')],
      [cell('design', '设计阶段', 4), cell('p1', '选准教学内容'), cell('d1', '核心概念不宜硬套')],
      [cell('p2', '知识与活动平衡'), cell('d2', '以概念为中心设计活动')],
      [cell('p3', '整体性与阶段性'), cell('d3', '复杂问题分解为子问题')],
      [cell('p4', '技术作为认知工具'), cell('d4', '技术使用与目标结合')],
      [cell('implementation', '实施阶段', 2), cell('p5', '过程监督与调整'), cell('d5', '关注能力差距')],
      [cell('p6', '小组分工合理化'), cell('d6', '确保每位学生参与')],
    ];
    const original = structuredClone(data);
    const layout = tableCellLayout(data, 3);
    expect(layout.map((row) => row.map(({ columnIndex }) => columnIndex)))
      .toEqual([[0, 1, 2], [0, 1, 2], [1, 2], [1, 2], [1, 2], [0, 1, 2], [1, 2]]);
    expect(layout.flat().map(({ cell }) => cell)).toEqual(data.flat());
    expect(layout[2]![0]!.cell).toBe(data[2]![0]);
    const element: PPTTableElement = { id: 'native-table', type: 'table', left: 60, top: 190,
      width: 880, height: 316, rotate: 0, colWidths: [0.11, 0.18, 0.71], cellMinHeight: 40, data,
      outline: { color: '#CBD5E1', width: 1, style: 'solid' } };
    const html = renderToStaticMarkup(createElement(StaticTable, { elementInfo: element }));
    for (const authored of data.flat()) {
      expect(html).toContain(`data-slide-cell-id="${authored.id}"`);
      expect(html).toContain(authored.text);
    }
    expect(html).toContain('rowSpan="4"');
    expect(html).toContain('rowSpan="2"');
    expect(html).toContain('font-size:16px');
    expect(data).toEqual(original);
  });

  it('preserves a compact cell after colspan and an empty compact cell under rowspan', () => {
    const cell = (id: string, text: string, colspan = 1, rowspan = 1) => ({ id, text, colspan, rowspan });
    const data = [[cell('merged', '两列标题', 2, 2), cell('right', '第三列')], [cell('empty', '')],
      [cell('a', '甲'), cell('b', '乙'), cell('c', '丙')]];
    expect(tableCellLayout(data, 3).map((row) => row.map(({ cell, columnIndex }) => [cell.id, columnIndex])))
      .toEqual([[['merged', 0], ['right', 2]], [['empty', 2]], [['a', 0], ['b', 1], ['c', 2]]]);
  });

  it('keeps legacy full-grid rowspan placeholders out without hiding actual text', () => {
    const cell = (id: string, text: string, rowspan = 1) => ({ id, text, colspan: 1, rowspan });
    const data = [[cell('stage', '阶段', 2), cell('first', '首项')],
      [cell('covered', ''), cell('second', '次项')]];
    expect(tableCellLayout(data, 2).map((row) => row.map(({ cell, columnIndex }) => [cell.id, columnIndex])))
      .toEqual([[['stage', 0], ['first', 1]], [['second', 1]]]);
  });

  it('resolves combined row and column spans identically in compact and legacy full-grid rows', () => {
    const merged = { id: 'merged', text: '联合表头', colspan: 2, rowspan: 2 };
    const first = { id: 'first', text: '右上', colspan: 1, rowspan: 1 };
    const second = { id: 'second', text: '右下', colspan: 1, rowspan: 1 };
    const empty = (id: string) => ({ id, text: '', colspan: 1, rowspan: 1 });
    const compact = [[merged, first], [second]];
    const legacy = [[merged, empty('covered-h'), first], [empty('covered-v1'), empty('covered-v2'), second]];
    expect(tableCellLayout(legacy, 3)).toEqual(tableCellLayout(compact, 3));
    expect(tableCellLayout(compact, 3).map((row) => row.map(({ columnIndex }) => columnIndex)))
      .toEqual([[0, 2], [2]]);
  });

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
    expect(html).toContain('data-slide-row-index="0"');
    expect(html).toContain('data-slide-row-index="1"');
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
