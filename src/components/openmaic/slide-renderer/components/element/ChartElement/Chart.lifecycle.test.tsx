import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
import { Chart as PackageChart } from '../../../../../../../packages/@openmaic/renderer/src/elements/chart/Chart';
import { BaseChartElement } from './BaseChartElement';
import { BaseChartElement as PackageBaseChartElement } from '../../../../../../../packages/@openmaic/renderer/src/elements/chart/BaseChartElement';

const instance = vi.hoisted(() => ({ setOption: vi.fn(), clear: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => instance) }));

describe.each([['application', BaseChartElement], ['package', PackageBaseChartElement]] as const)('%s chart element font handoff', (_, Component) => {
  beforeEach(() => vi.clearAllMocks());
  it.each([18, 16])('passes the adopted %spx options through to the actual chart instance', (fontSize) => {
    const data = { labels: ['甲', '乙'], legends: ['人数', '人数二'], series: [[10, 20], [15, 25]] };
    const { unmount } = render(<Component elementInfo={{ id: 'chart', type: 'chart', chartType: 'bar',
      left: 50, top: 140, width: 420, height: 280, rotate: 0, data, themeColors: ['#123456'], options: { fontSize } }} />);
    expect(instance.setOption).toHaveBeenCalledWith(expect.objectContaining({
      textStyle: expect.objectContaining({ fontSize }),
      xAxis: expect.objectContaining({ axisLabel: expect.objectContaining({ fontSize }) }),
      legend: expect.objectContaining({ textStyle: expect.objectContaining({ fontSize }) }),
      series: expect.arrayContaining([expect.objectContaining({ label: expect.objectContaining({ fontSize }) })]),
    }), true);
    unmount();
  });
});

describe.each([['application', Chart], ['package', PackageChart]] as const)('%s chart lifecycle', (_, Component) => {
  beforeEach(() => vi.clearAllMocks());

  it('clears stale data when the series becomes empty, then renders later data', () => {
    const data = { labels: ['甲', '乙'], legends: ['人数'], series: [[10, 20]] };
    const props = { width: 420, height: 280, type: 'bar' as const, themeColors: ['#123456'] };
    const { rerender, unmount } = render(<Component {...props} data={data} />);
    expect(instance.setOption).toHaveBeenCalled();
    expect(instance.clear).not.toHaveBeenCalled();

    rerender(<Component {...props} data={{ labels: [], legends: [], series: [] }} />);
    expect(instance.clear).toHaveBeenCalledOnce();
    instance.setOption.mockClear();
    rerender(<Component {...props} data={data} />);
    expect(instance.setOption).toHaveBeenCalledOnce();

    unmount();
    expect(instance.dispose).toHaveBeenCalledOnce();
  });
});
