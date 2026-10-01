import { describe, expect, it } from 'vitest';
import { adoptChartPresentationTypography } from '../src/chart-presentation-typography.js';

const chart = { id: 'chart', type: 'chart', left: 50, top: 140, width: 900, height: 300, chartType: 'bar',
  options: { stack: true }, data: { labels: ['甲', '乙'], legends: ['数量'], series: [[12, 20]] } };
const typography = { bodyFontSize: 18, minimumBodyFontSize: 16 };

describe('pre-adopted chart typography', () => {
  it.each([18, 16])('applies measured %spx to native charts and nested flow charts without changing data or geometry', (fontSize) => {
    const draft = { elements: [chart, { type: 'shape', fill: '#fff' }], layout: { groups: [{ kind: 'row', children: [
      { kind: 'textBox', text: '比较同一指标' }, { kind: 'column', children: [{ kind: 'native', element: chart }] },
    ] }] } } as const;
    const result = adoptChartPresentationTypography(draft, { ...typography, chartFontSize: fontSize });
    expect(result.elements[0]).toEqual({ ...chart, options: { stack: true, fontSize } });
    expect(result.elements[0]?.data).toBe(chart.data);
    expect(result.layout.groups[0]?.children[1]?.children?.[0]?.element).toEqual({ ...chart, options: { stack: true, fontSize } });
    expect(draft.elements[0]?.options).toEqual({ stack: true });
    expect(result.elements[1]).toBe(draft.elements[1]);
    expect(result.layout.groups[0]?.children[0]).toBe(draft.layout.groups[0]?.children[0]);
  });

  it('preserves explicit usable fonts and records profile deviations without stopping generation', () => {
    const compact = { ...chart, options: { fontSize: 16 } };
    expect(adoptChartPresentationTypography({ elements: [compact] }, typography).elements[0]).toEqual(compact);
    const larger = { ...chart, options: { fontSize: 24 } };
    const diagnostics: string[] = [];
    expect(adoptChartPresentationTypography({ elements: [larger] }, typography, (detail) => diagnostics.push(detail)).elements[0]).toEqual(larger);
    expect(larger.options.fontSize).toBe(24);
    const tooSmall = { ...chart, options: { fontSize: 14 } };
    expect(adoptChartPresentationTypography({ elements: [tooSmall] }, typography, (detail) => diagnostics.push(detail)).elements[0]).toEqual(tooSmall);
    expect(diagnostics).toEqual([expect.stringContaining('24px'), expect.stringContaining('14px')]);
  });

  it('leaves historical charts and raw responses without a profile exactly unchanged', () => {
    const draft = { elements: [chart, { ...chart, options: { fontSize: 14 } }] };
    expect(adoptChartPresentationTypography(draft)).toBe(draft);
    expect(chart.options).toEqual({ stack: true });
  });
});
