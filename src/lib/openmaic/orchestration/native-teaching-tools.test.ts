import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createNativeTeachingTools, getNativeTeachingToolNames } from './native-teaching-tools';

describe('native classroom teaching tools', () => {
  it('retains group and connector identity and rejects incompatible chart data', () => {
    const tools = createNativeTeachingTools(['wb_draw_shape', 'wb_draw_line', 'wb_draw_chart']);
    const line = { startX: 240, startY: 140, endX: 440, endY: 140, groupId: 'process', startAnchor: { elementId: 'node', side: 'right' } };
    expect((tools.wb_draw_line.inputSchema as z.ZodType).parse(line)).toEqual(line);
    const chart = { chartType: 'scatter', x: 60, y: 80, width: 600, height: 340, data: { labels: ['A', 'B'], legends: ['X', 'Y'], series: [[1, 2], [3, 4]] } };
    const schema = tools.wb_draw_chart.inputSchema as z.ZodType;
    expect(schema.safeParse(chart).success).toBe(true);
    expect(schema.safeParse({ ...chart, chartType: 'pie' }).success).toBe(false);
    expect(schema.safeParse({ ...chart, data: { ...chart.data, series: [[1], [3, 4]] } }).success).toBe(false);
  });
  it('exposes only supported and role-allowed actions', () => {
    expect(
      getNativeTeachingToolNames([
        'wb_draw_line',
        'not_a_tool',
      ]),
    ).toEqual(['wb_draw_line']);
  });

  it('builds AI SDK tools for whiteboard and simulation actions', () => {
    const tools = createNativeTeachingTools([
      'wb_draw_text',
      'widget_setState',
    ]);

    expect(Object.keys(tools)).toEqual([
      'wb_draw_text',
      'widget_setState',
    ]);
  });
});
