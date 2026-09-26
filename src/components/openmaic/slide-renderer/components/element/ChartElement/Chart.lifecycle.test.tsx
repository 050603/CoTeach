import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
import { Chart as PackageChart } from '../../../../../../../packages/@openmaic/renderer/src/elements/chart/Chart';

const instance = vi.hoisted(() => ({ setOption: vi.fn(), clear: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => instance) }));

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
