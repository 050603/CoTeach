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
