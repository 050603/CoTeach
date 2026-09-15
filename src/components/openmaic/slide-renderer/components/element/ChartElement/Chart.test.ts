// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts/core';
import type { ChartData, ChartType } from '@openmaic/dsl';
import './Chart';
import { getChartOption } from './chartOption';

describe('native chart component registration', () => {
  it.each<ChartType>(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter'])(
    'renders %s as real SVG with its required coordinate system',
    (type) => {
      const data: ChartData = {
        labels: ['A', 'B', 'C'],
        legends: type === 'scatter' ? ['X', 'Y'] : ['数量'],
        series: type === 'scatter' ? [[1, 2, 3], [3, 5, 4]] : [[10, 20, 30]],
      };
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 420, height: 280 });
      try {
        chart.setOption({ ...getChartOption({ type, data, themeColors: ['#123456'] }), animation: false });
        const svg = chart.renderToSVGString();
        expect(svg).toContain('<path');
        expect(svg).not.toMatch(/NaN|Infinity/);
      } finally {
        chart.dispose();
      }
    },
  );
});

describe('compact native chart layout', () => {
  it.each([138.5, 220])('keeps category labels and a usable plot inside a %spx frame', async (height) => {
    const { getChartOption: getPackageChartOption } = await import('../../../../../../../packages/@openmaic/renderer/src/elements/chart/chartOption');
    for (const makeOption of [getChartOption, getPackageChartOption]) {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 411, height });
      try {
        chart.setOption({ ...makeOption({ type: 'bar', themeColors: ['#5B9BD5'], data: {
          labels: ['周一', '周二', '周三'], legends: ['用电量 (kWh)'], series: [[12, 10, 14]],
        } }), animation: false });
        const svg = chart.renderToSVGString();
        for (const label of ['周一', '周二', '周三']) expect(svg).toContain(label);
        const bottom = chart.convertToPixel({ yAxisIndex: 0 }, 0) as number;
        const top = chart.convertToPixel({ yAxisIndex: 0 }, 14) as number;
        expect(bottom - top).toBeGreaterThan(height * 0.45);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThan(height);
      } finally { chart.dispose(); }
    }
  });
});
