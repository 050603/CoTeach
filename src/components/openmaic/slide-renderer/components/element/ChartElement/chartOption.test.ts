import { describe, expect, it } from 'vitest';
import { getChartOption } from './chartOption';
import { getChartOption as getPackageChartOption } from '../../../../../../../packages/@openmaic/renderer/src/elements/chart/chartOption';
import type { ChartType } from '@openmaic/dsl';

const data = { labels: ['甲', '乙'], legends: ['数量', '数量二'], series: [[12, 20], [15, 18]] };
const types: ChartType[] = ['bar', 'column', 'line', 'area', 'pie', 'ring', 'radar', 'scatter'];

describe.each([['application', getChartOption], ['package', getPackageChartOption]] as const)('%s adopted chart fonts', (_, makeOption) => {
  it.each([18, 16])('uses %spx across visible axes, names, legends and values', (fontSize) => {
    for (const type of types) {
      const option = makeOption({ type, data, themeColors: ['#123456'], fontSize });
      expect(option).toMatchObject({ textStyle: { fontSize, fontFamily: 'Noto Sans SC' } });
      if (['bar', 'column', 'line', 'area', 'scatter'].includes(type)) {
        expect(option).toMatchObject({ xAxis: { axisLabel: { fontSize }, nameTextStyle: { fontSize } },
          yAxis: { axisLabel: { fontSize }, nameTextStyle: { fontSize } } });
      }
      const series = Array.isArray(option?.series) ? option.series : [option?.series];
      for (const item of series) expect(item).toMatchObject({ label: { fontSize } });
      if (type !== 'scatter') expect(option).toMatchObject({ legend: { textStyle: { fontSize } } });
      if (type === 'pie' || type === 'ring') expect(option).toMatchObject({
        series: [{ label: { fontSize }, emphasis: { label: { fontSize } } }],
      });
      if (type === 'radar') expect(option).toMatchObject({ radar: { axisName: { fontSize } }, series: [{ label: { fontSize } }] });
      if (type === 'scatter') expect(option).toMatchObject({ tooltip: { textStyle: { fontSize } } });
    }
  });

  it('keeps the historical implicit typography and 14px pie emphasis without an adopted font', () => {
    const option = makeOption({ type: 'bar', data, themeColors: ['#123456'] });
    expect(option).toMatchObject({ textStyle: {}, legend: { textStyle: {} },
      xAxis: { axisLabel: {} }, yAxis: { axisLabel: {} } });
    const series = Array.isArray(option?.series) ? option.series : [option?.series];
    for (const item of series) expect(item).toMatchObject({ label: { show: true } });
    expect(option?.textStyle).not.toHaveProperty('fontSize');
    const pie = makeOption({ type: 'pie', data, themeColors: ['#123456'] });
    expect(pie).toMatchObject({ series: [{ label: {}, emphasis: { label: { fontSize: 14 } } }] });
  });
});

describe('scatter data meaning', () => {
  it('keeps point names and labels numeric axes with their actual measurement names', () => {
    const option = getChartOption({ type: 'scatter', themeColors: ['#7c3aed'], data: {
      labels: ['教室 A', '教室 B'], legends: ['使用时长（小时）', '用电量（千瓦时）'], series: [[2, 4], [6, 10]],
    } });
    expect(option).toMatchObject({
      xAxis: { type: 'value', name: '使用时长（小时）' },
      yAxis: { type: 'value', name: '用电量（千瓦时）' },
      series: [{ data: [{ name: '教室 A', value: [2, 6] }, { name: '教室 B', value: [4, 10] }] }],
      tooltip: { trigger: 'item' },
    });
  });
});
