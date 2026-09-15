import type { ComposeOption } from 'echarts/core';
import type {
  BarSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  ScatterSeriesOption,
  RadarSeriesOption,
} from 'echarts/charts';
import type { ChartData, ChartType } from '@openmaic/dsl';
import type { TooltipComponentOption, GridComponentOption } from 'echarts/components';

type EChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | PieSeriesOption | ScatterSeriesOption | RadarSeriesOption | TooltipComponentOption | GridComponentOption
>;

export interface ChartOptionPayload {
  type: ChartType;
  data: ChartData;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
  lineSmooth?: boolean;
  stack?: boolean;
}

export const getChartOption = ({
  type,
  data,
  themeColors,
  textColor,
  lineColor,
  lineSmooth,
  stack,
}: ChartOptionPayload): EChartOption | null => {
  const textStyle = textColor
    ? {
        color: textColor,
      }
    : {};

  const axisLine = textColor
    ? {
        lineStyle: {
          color: textColor,
        },
      }
    : {};

  const axisLabel = textColor
    ? {
        color: textColor,
      }
    : {};

  const splitLine = lineColor
    ? {
        lineStyle: {
          color: lineColor,
        },
      }
    : {};

  // Defensive check: ensure series is a non-empty array before processing
  if (!Array.isArray(data?.series) || data.series.length === 0) {
    return null;
  }

  const legend =
    data.series.length > 1
      ? {
          top: 'bottom',
          textStyle,
        }
      : undefined;

  // An explicit undefined axis object suppresses ECharts' default labels.
  // Keep empty style objects above so unstyled charts retain their axes.
  // The library's default 65px + 80px grid margins exceed compact slide
  // frames. Reserve proportional inner space without changing DSL geometry.
  const grid = { left: '3%', right: '3%', top: '8%', bottom: legend ? 32 : '8%', containLabel: true };

  if (type === 'bar') {
    return {
      color: themeColors,
      textStyle,
      legend,
      grid,
      xAxis: {
        type: 'category',
        data: data.labels,
        axisLine,
        axisLabel,
      },
      yAxis: {
        type: 'value',
        axisLine,
        axisLabel,
        splitLine,
      },
      series: data.series.map((item, index) => {
        const seriesItem: BarSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'bar',
          label: {
            show: true,
          },
          itemStyle: {
            borderRadius: [2, 2, 0, 0],
          },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'column') {
    return {
      color: themeColors,
      textStyle,
      legend,
      grid,
      yAxis: {
        type: 'category',
        data: data.labels,
        axisLine,
        axisLabel,
      },
      xAxis: {
        type: 'value',
        axisLine,
        axisLabel,
        splitLine,
      },
      series: data.series.map((item, index) => {
        const seriesItem: BarSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'bar',
          label: {
            show: true,
          },
          itemStyle: {
            borderRadius: [0, 2, 2, 0],
          },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'line') {
    return {
      color: themeColors,
      textStyle,
      legend,
      grid,
      xAxis: {
        type: 'category',
        data: data.labels,
        axisLine,
        axisLabel,
      },
      yAxis: {
        type: 'value',
        axisLine,
        axisLabel,
        splitLine,
      },
      series: data.series.map((item, index) => {
        const seriesItem: LineSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'line',
          smooth: lineSmooth,
          label: {
            show: true,
          },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'pie') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    return {
      color: themeColors,
      textStyle,
      legend: {
        top: 'bottom',
        textStyle,
      },
      series: [
        {
          data: series0.map((item, index) => ({
            value: item,
            name: data.labels[index],
          })),
          label: textColor
            ? {
                color: textColor,
              }
            : {},
          type: 'pie',
          radius: '70%',
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
            label: {
              show: true,
              fontSize: 14,
              fontWeight: 'bold',
            },
          },
        },
      ],
    };
  }
  if (type === 'ring') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    return {
      color: themeColors,
      textStyle,
      legend: {
        top: 'bottom',
        textStyle,
      },
      series: [
        {
          data: series0.map((item, index) => ({
            value: item,
            name: data.labels[index],
          })),
          label: textColor
            ? {
                color: textColor,
              }
            : {},
          type: 'pie',
          radius: ['40%', '70%'],
          padAngle: 1,
          avoidLabelOverlap: false,
          itemStyle: {
            borderRadius: 4,
          },
          emphasis: {
            label: {
              show: true,
              fontSize: 14,
              fontWeight: 'bold',
            },
          },
        },
      ],
    };
  }
  if (type === 'area') {
    return {
      color: themeColors,
      textStyle,
      legend,
      grid,
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: data.labels,
        axisLine,
        axisLabel,
      },
      yAxis: {
        type: 'value',
        axisLine,
        axisLabel,
        splitLine,
      },
      series: data.series.map((item, index) => {
        const seriesItem: LineSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'line',
          areaStyle: {},
          label: {
            show: true,
          },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'radar') {
    // Display is broken without max in indicator; setting max triggers console warnings. No workaround — waiting for ECharts to fix this bug
    // const values: number[] = []
    // for (const item of data.series) {
    //   values.push(...item)
    // }
    // const max = Math.max(...values)

    return {
      color: themeColors,
      textStyle,
      legend,
      radar: {
        indicator: data.labels.map((item) => ({ name: item })),
        splitLine,
        axisLine: lineColor
          ? {
              lineStyle: {
                color: lineColor,
              },
            }
          : undefined,
      },
      series: [
        {
          data: data.series.map((item, index) => ({
            value: item,
            name: data.legends[index],
          })),
          type: 'radar',
        },
      ],
    };
  }
  if (type === 'scatter') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    const points = series0.map((x, index) => ({
      name: data.labels[index] ?? String(index + 1),
      value: [x, data.series[1]?.[index] ?? x],
    }));
    return {
      color: themeColors,
      textStyle,
      grid: { left: 56, right: 32, top: 24, bottom: 52, containLabel: true },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', name: data.legends[0] ?? 'X', nameLocation: 'middle', nameGap: 30, axisLine, axisLabel, splitLine },
      yAxis: { type: 'value', name: data.legends[1] ?? 'Y', nameLocation: 'middle', nameGap: 36, axisLine, axisLabel, splitLine },
      series: [{ symbolSize: 12, data: points, type: 'scatter' }],
    };
  }

  return null;
};
