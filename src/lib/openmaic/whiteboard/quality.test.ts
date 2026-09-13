import { describe, expect, it } from 'vitest';
import type { WbDrawChartAction } from '@openmaic/lib/types/action';
import { auditWhiteboardContent } from './quality';

const chart: WbDrawChartAction = {
  id: 'chart', type: 'wb_draw_chart', chartType: 'column', x: 40, y: 80, width: 600, height: 360,
  data: { labels: ['甲', '乙'], legends: ['测量值'], series: [[12, 24]] },
};

describe('whiteboard content quality', () => {
  it('preserves valid data and distinguishes scatter coordinates from ordinary series', () => {
    expect(auditWhiteboardContent([chart])).toEqual([]);
    expect(auditWhiteboardContent([{ ...chart, chartType: 'scatter' }])[0]?.message).toContain('X');
    expect(auditWhiteboardContent([{ ...chart, chartType: 'scatter', data: { ...chart.data, legends: ['X', 'Y'], series: [[1, 2], [3, 4]] } }])).toEqual([]);
    expect(chart.data.series).toEqual([[12, 24]]);
  });

  it('rejects mismatched data, invisible extra pie series and meaningless pie totals', () => {
    for (const invalid of [
      { ...chart, data: { ...chart.data, series: [[1]] } },
      { ...chart, data: { ...chart.data, series: [[1, Number.NaN]] } },
      { ...chart, chartType: 'pie' as const, data: { ...chart.data, legends: ['A', 'B'], series: [[1, 2], [3, 4]] } },
      { ...chart, chartType: 'ring' as const, data: { ...chart.data, series: [[0, 0]] } },
      { ...chart, chartType: 'pie' as const, data: { ...chart.data, series: [[-1, 3]] } },
    ]) expect(auditWhiteboardContent([invalid])[0]?.code).toBe('chart-data');
  });

  it('checks formula syntax before publication, including JSON escape damage', () => {
    const formula = { id: 'formula', type: 'wb_draw_latex' as const, x: 40, y: 80, latex: String.raw`\frac{x+1}{2}=3` };
    expect(auditWhiteboardContent([formula])).toEqual([]);
    expect(auditWhiteboardContent([{ ...formula, latex: String.raw`\frac{x+1}{` }])[0]?.code).toBe('formula-syntax');
    expect(auditWhiteboardContent([{ ...formula, latex: '\frac{x+1}{2}' }])[0]?.code).toBe('formula-syntax');
  });
});
