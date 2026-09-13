import { describe, expect, it } from 'vitest';
import { getChartOption } from './chartOption';

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
