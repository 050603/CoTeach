import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { ACTION_DESCRIPTIONS } from './tool-schemas';

const empty = z.object({});
const elementId = z.string().min(1);
const anchor = z.object({ elementId, side: z.enum(['top', 'right', 'bottom', 'left', 'center']) });
const drawingIdentity = { elementId: elementId.optional(), groupId: elementId.optional() };
const coordinates = {
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(562.5),
};

const TOOL_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  spotlight: z.object({ elementId, dimOpacity: z.number().min(0).max(1).optional() }),
  laser: z.object({ elementId, color: z.string().optional() }),
  play_video: z.object({ elementId }),
  wb_open: empty,
  wb_close: empty,
  wb_clear: empty,
  wb_delete: z.object({ elementId }),
  wb_draw_text: z.object({
    content: z.string().min(1),
    ...coordinates,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fontSize: z.number().min(8).max(96).optional(),
    color: z.string().optional(),
    ...drawingIdentity,
  }),
  wb_draw_image: z.object({
    src: z.string().trim().min(1),
    ...coordinates,
    width: z.number().positive(),
    height: z.number().positive(),
    ...drawingIdentity,
  }),
  wb_draw_shape: z.object({
    shape: z.enum(['rectangle', 'circle', 'triangle']),
    ...coordinates,
    width: z.number().positive(),
    height: z.number().positive(),
    fillColor: z.string().optional(),
    ...drawingIdentity,
  }),
  wb_draw_chart: z.object({
    chartType: z.enum(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter']),
    ...coordinates,
    width: z.number().positive(),
    height: z.number().positive(),
    data: z.object({
      labels: z.array(z.string()).min(1),
      legends: z.array(z.string()).min(1),
      series: z.array(z.array(z.number().finite()).min(1)).min(1),
    }).refine((data) => data.series.length === data.legends.length && data.series.every((values) => values.length === data.labels.length), 'Chart labels, legends and series must align'),
    themeColors: z.array(z.string()).optional(),
    ...drawingIdentity,
  }).refine((chart) => chart.chartType !== 'scatter' || chart.data.series.length === 2,
    'Scatter charts require exactly two numeric series: X then Y')
    .refine((chart) => !['pie', 'ring'].includes(chart.chartType) || (chart.data.series.length === 1
      && chart.data.series[0].every((value) => value >= 0) && chart.data.series[0].some((value) => value > 0)),
    'Pie and ring charts require one nonnegative series with a positive total'),
  wb_draw_latex: z.object({
    latex: z.string().min(1),
    ...coordinates,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    color: z.string().optional(),
    ...drawingIdentity,
  }),
  wb_draw_table: z.object({
    ...coordinates,
    width: z.number().positive(),
    height: z.number().positive(),
    data: z.array(z.array(z.string()).min(1)).min(1).refine((rows) => rows.every((row) => row.length === rows[0].length), 'Table rows must have equal column counts'),
    outline: z
      .object({ width: z.number().positive(), style: z.string(), color: z.string() })
      .optional(),
    theme: z.object({ color: z.string() }).optional(),
    ...drawingIdentity,
  }),
  wb_draw_line: z.object({
    startX: z.number().min(0).max(1000),
    startY: z.number().min(0).max(562.5),
    endX: z.number().min(0).max(1000),
    endY: z.number().min(0).max(562.5),
    startAnchor: anchor.optional(),
    endAnchor: anchor.optional(),
    color: z.string().optional(),
    width: z.number().positive().optional(),
    style: z.enum(['solid', 'dashed']).optional(),
    points: z.tuple([z.enum(['', 'arrow']), z.enum(['', 'arrow'])]).optional(),
    ...drawingIdentity,
  }),
  wb_draw_code: z.object({
    language: z.string().min(1),
    code: z.string(),
    ...coordinates,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fileName: z.string().optional(),
    ...drawingIdentity,
  }),
  wb_edit_code: z.object({
    elementId,
    operation: z.enum(['insert_after', 'insert_before', 'delete_lines', 'replace_lines']),
    lineId: z.string().optional(),
    lineIds: z.array(z.string()).optional(),
    content: z.string().optional(),
  }),
  widget_highlight: z.object({ target: z.string().min(1), content: z.string().optional() }),
  widget_setState: z.object({
    state: z.record(z.string(), z.unknown()),
    content: z.string().optional(),
  }),
  widget_annotation: z.object({ target: z.string().min(1), content: z.string().optional() }),
  widget_reveal: z.object({ target: z.string().min(1), content: z.string().optional() }),
};

export function getNativeTeachingToolNames(allowedActions: readonly string[]): string[] {
  return allowedActions.filter(
    (action) => Boolean(TOOL_INPUT_SCHEMAS[action] && ACTION_DESCRIPTIONS[action]),
  );
}

/**
 * Build request-scoped AI SDK tools. Tool execution only acknowledges the
 * call; the actual side effect is compiled into an Action SSE event and runs
 * in the shared ActionEngine on the classroom client.
 */
export function createNativeTeachingTools(allowedActions: readonly string[]): ToolSet {
  const tools: ToolSet = {};
  for (const actionName of getNativeTeachingToolNames(allowedActions)) {
    tools[actionName] = tool({
      description: ACTION_DESCRIPTIONS[actionName],
      inputSchema: TOOL_INPUT_SCHEMAS[actionName],
      execute: async () => ({ ok: true, scheduledAction: actionName }),
    });
  }
  return tools;
}
