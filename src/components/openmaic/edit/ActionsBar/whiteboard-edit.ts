import type { Action } from '@openmaic/lib/types/action';
import { clampInsertSlot } from './actions-edit';
import { whiteboardBlocks, type WhiteboardBlock } from '@openmaic/lib/edit/whiteboard-blocks';
export {
  whiteboardBlocks,
  replaceWhiteboardSteps,
  moveTimelineActionByIdDir,
  type WhiteboardBlock,
} from '@openmaic/lib/edit/whiteboard-blocks';

export type BoardStepType =
  | 'speech'
  | 'wb_draw_text'
  | 'wb_draw_table'
  | 'wb_draw_image'
  | 'wb_draw_shape'
  | 'wb_draw_chart'
  | 'wb_draw_line'
  | 'wb_draw_latex'
  | 'wb_draw_code'
  | 'wb_clear';

export function makeBoardStep(type: BoardStepType, id: string, y = 60): Action {
  const position = { x: 60, y, width: 880, height: 110, elementId: `element-${id}` };
  switch (type) {
    case 'speech':
      return { id, type, text: '请观察白板上的内容。' };
    case 'wb_draw_text':
      return { id, type, ...position, content: '板书要点', fontSize: 32, color: '#243447' };
    case 'wb_draw_table':
      return {
        id,
        type,
        ...position,
        height: 180,
        data: [
          ['项目', '观察与说明'],
          ['示例', '填写内容'],
        ],
        theme: { color: '#344A6A' },
      };
    case 'wb_draw_image':
      return { id, type, ...position, width: 400, height: 225, src: '' };
    case 'wb_draw_shape':
      return {
        id,
        type,
        ...position,
        width: 200,
        height: 120,
        shape: 'rectangle',
        fillColor: '#93b4ad',
      };
    case 'wb_draw_chart':
      return {
        id, type, ...position, width: 620, height: 280, chartType: 'column',
        data: { labels: ['项目 A', '项目 B', '项目 C'], legends: ['方案一', '方案二'], series: [[12, 18, 24], [10, 16, 21]] },
        themeColors: ['#7c3aed', '#0d9488'],
      };
    case 'wb_draw_line':
      return { id, type, elementId: `element-${id}`, startX: 100, startY: y, endX: 400, endY: y, width: 3, color: '#7c3aed', points: ['', 'arrow'] };
    case 'wb_draw_latex':
      return { id, type, ...position, latex: 'a^2 + b^2 = c^2', color: '#243447' };
    case 'wb_draw_code':
      return { id, type, ...position, height: 200, language: 'python', code: 'print("Hello")' };
    case 'wb_clear':
      return { id, type };
  }
}

export type BoardChart = Extract<Action, { type: 'wb_draw_chart' }>;

export const boardChartTypes: Array<[BoardChart['chartType'], string]> = [
  ['column', '柱状图'], ['bar', '条形图'], ['line', '折线图'], ['area', '面积图'],
  ['pie', '饼图'], ['ring', '环形图'], ['radar', '雷达图'], ['scatter', '散点图'],
];

export function hasEditableChartData(chart: BoardChart): boolean {
  const data = chart.data;
  return Boolean(data && Array.isArray(data.labels) && data.labels.length && data.labels.every((value) => typeof value === 'string')
    && Array.isArray(data.legends) && data.legends.length && data.legends.every((value) => typeof value === 'string')
    && Array.isArray(data.series) && data.series.length === data.legends.length
    && data.series.every((series) => Array.isArray(series) && series.length === data.labels.length && series.every(Number.isFinite)));
}

/** Keep chart switches explicit: the renderer must never silently discard a series. */
export function chartTypeIssue(chart: BoardChart, type: BoardChart['chartType']): string | null {
  if (!hasEditableChartData(chart)) return '请先修复图表数据的行列。';
  if ((type === 'pie' || type === 'ring') && chart.data.series.length !== 1)
    return '饼图和环形图只显示一个系列，请先删除不需要的系列。';
  if ((type === 'pie' || type === 'ring') && chart.data.series[0]?.some((value) => value < 0))
    return '饼图和环形图需要非负数据。';
  if ((type === 'pie' || type === 'ring') && !chart.data.series[0]?.some((value) => value > 0))
    return '饼图和环形图至少需要一个正数。';
  if (type === 'scatter' && chart.data.series.length !== 2)
    return '散点图需要恰好两个数值系列，分别作为 X 和 Y。';
  if (type === 'radar' && chart.data.labels.length < 3)
    return '雷达图至少需要三个数据项。';
  return null;
}

/** Resize both matrix axes together so edits keep renderer-valid dimensions. */
export function resizeBoardChartData(chart: BoardChart, rows: number, series: number): BoardChart['data'] {
  const labels = Array.isArray(chart.data?.labels) ? chart.data.labels : [];
  const legends = Array.isArray(chart.data?.legends) ? chart.data.legends : [];
  const matrix = Array.isArray(chart.data?.series) ? chart.data.series : [];
  const rowCount = Math.max(chart.chartType === 'radar' ? 3 : 1, Math.min(Math.max(16, labels.length), rows));
  const seriesCount = chart.chartType === 'scatter' ? 2
    : chart.chartType === 'pie' || chart.chartType === 'ring' ? 1 : Math.max(1, Math.min(Math.max(6, matrix.length), series));
  return {
    labels: Array.from({ length: rowCount }, (_, index) => typeof labels[index] === 'string' ? labels[index] : `项目 ${index + 1}`),
    legends: Array.from({ length: seriesCount }, (_, index) => typeof legends[index] === 'string' ? legends[index] : `系列 ${index + 1}`),
    series: Array.from({ length: seriesCount }, (_, seriesIndex) =>
      Array.from({ length: rowCount }, (_, row) => Number.isFinite(matrix[seriesIndex]?.[row]) ? matrix[seriesIndex][row] : 0)),
  };
}

/** Place only the new draw; a full page never implicitly clears earlier teaching. */
export function placeBoardStep(type: BoardStepType, id: string, actions: readonly Action[]): { action: Action; crowded: boolean } {
  const action = makeBoardStep(type, id);
  if (!('x' in action) || !('y' in action)) return { action, crowded: false };
  const boxes = visibleBoardDraws(actions).flatMap((draw) => 'x' in draw && 'y' in draw
    ? [{ x: draw.x, y: draw.y, width: draw.width ?? 400, height: draw.height ?? 100 }] : []);
  const width = action.width ?? 400;
  const height = action.height ?? 100;
  const xs = [...new Set([60, ...boxes.map((box) => box.x + box.width + 24)])].sort((a, b) => a - b);
  const ys = [...new Set([60, ...boxes.map((box) => box.y + box.height + 24)])].sort((a, b) => a - b);
  for (const y of ys) for (const x of xs) {
    if (x + width > 960 || y + height > 530) continue;
    if (boxes.every((box) => x + width + 12 <= box.x || box.x + box.width + 12 <= x || y + height + 12 <= box.y || box.y + box.height + 12 <= y))
      return { action: { ...action, x, y }, crowded: false };
  }
  return { action: { ...action, y: Math.max(40, 530 - height) }, crowded: boxes.length > 0 };
}

function boardPageRange(steps: readonly Action[], index: number): [number, number] {
  let start = index;
  let end = index + 1;
  while (start > 0 && steps[start - 1].type !== 'wb_clear') start--;
  while (end < steps.length && steps[end].type !== 'wb_clear') end++;
  return [start, end];
}

/** Moving a template node keeps even its subsequently drawn label attached. */
export function editBoardStep(steps: Action[], id: string, update: (action: Action) => Action): Action[] {
  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return steps;
  const original = steps[index];
  const next = update(original);
  const dx = 'x' in original && 'x' in next ? next.x - original.x : 0;
  const dy = 'y' in original && 'y' in next ? next.y - original.y : 0;
  const [start, end] = boardPageRange(steps, index);
  return steps.map((step, stepIndex) => {
    if (stepIndex === index) return next;
    if (original.groupId && step.groupId === original.groupId && stepIndex >= start && stepIndex < end
      && (dx || dy) && 'x' in step && 'y' in step) return { ...step, x: step.x + dx, y: step.y + dy };
    return step;
  });
}

/** Delete a node and its anchored connectors as one undoable edit, within this page only. */
export function deleteBoardStep(steps: Action[], id: string): Action[] {
  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return steps;
  const selected = steps[index];
  const aliases = new Set([id, 'elementId' in selected ? selected.elementId : undefined]);
  const [start, end] = boardPageRange(steps, index);
  return steps.filter((step, stepIndex) => stepIndex !== index && !(stepIndex >= start && stepIndex < end
    && step.type === 'wb_draw_line' && ((step.startAnchor && aliases.has(step.startAnchor.elementId)) || (step.endAnchor && aliases.has(step.endAnchor.elementId)))));
}

export function appendWhiteboardBlock(actions: Action[], id: string): Action[] {
  const slot = clampInsertSlot(actions, actions.length);
  return [
    ...actions.slice(0, slot),
    { id, type: 'wb_open', title: '白板讲授' },
    { id: `${id}-clear`, type: 'wb_clear' },
    makeBoardStep('wb_draw_text', `${id}-text`),
    { id: `${id}-close`, type: 'wb_close' },
    ...actions.slice(slot),
  ];
}

export function removeWhiteboardBlock(actions: Action[], id: string): Action[] {
  const block = whiteboardBlocks(actions).find((item) => item.id === id);
  return block ? [...actions.slice(0, block.start), ...actions.slice(block.end + 1)] : actions;
}

/** Move a board past one whole adjacent segment, never past a terminal discussion. */
export function moveWhiteboardBlock(actions: Action[], id: string, direction: -1 | 1): Action[] {
  const blocks = whiteboardBlocks(actions);
  const block = blocks.find((item) => item.id === id);
  if (!block) return actions;
  if (direction < 0) {
    if (!block.start) return actions;
    const previous = blocks.find((item) => item.end === block.start - 1);
    const start = previous?.start ?? block.start - 1;
    return [
      ...actions.slice(0, start),
      ...actions.slice(block.start, block.end + 1),
      ...actions.slice(start, block.start),
      ...actions.slice(block.end + 1),
    ];
  }
  if (block.end === actions.length - 1 || actions[block.end + 1].type === 'discussion')
    return actions;
  const next = blocks.find((item) => item.start === block.end + 1);
  const end = next?.end ?? block.end + 1;
  return [
    ...actions.slice(0, block.start),
    ...actions.slice(block.end + 1, end + 1),
    ...actions.slice(block.start, block.end + 1),
    ...actions.slice(end + 1),
  ];
}

export function boardStepLabel(action: Action): string {
  const labels: Record<string, string> = {
    speech: 'AI 讲解',
    wb_draw_text: '板书文字',
    wb_draw_table: '表格',
    wb_draw_image: '图片',
    wb_draw_shape: '图形',
    wb_draw_latex: '公式',
    wb_draw_code: '代码',
    wb_edit_code: '逐步修改代码',
    wb_draw_chart: '图表',
    wb_draw_line: '连线与箭头',
    wb_clear: '清空白板',
    wb_delete: '擦除内容',
  };
  return labels[action.type] ?? action.type;
}

export function boardStepSummary(action: Action): string {
  if (action.type === 'speech') return action.text;
  if (action.type === 'wb_draw_text') return action.content.replace(/<[^>]*>/g, ' ');
  if (action.type === 'wb_draw_table') return action.data[0]?.join(' · ') ?? '';
  if (action.type === 'wb_draw_image') return action.src ? '展示图片' : '待添加图片';
  if (action.type === 'wb_draw_latex') return action.latex;
  if (action.type === 'wb_draw_code') return action.code;
  if (action.type === 'wb_draw_chart') return `${boardChartTypes.find(([type]) => type === action.chartType)?.[1] ?? '图表'} · ${action.data.labels.length} 项数据`;
  return boardStepLabel(action);
}

/** Project the retained board through a selected step; opening it does not erase it. */
export function visibleBoardDraws(actions: readonly Action[]): Action[] {
  let visible: Action[] = [];
  const elementId = (action: Action) => 'elementId' in action && action.elementId || action.id;
  for (const action of actions) {
    if (action.type === 'wb_clear') visible = [];
    else if (action.type === 'wb_delete') {
      const targets = new Set([action.elementId, ...visible.filter((item) => elementId(item) === action.elementId || item.id === action.elementId).flatMap((item) => [item.id, elementId(item)])]);
      visible = visible.filter((item) => !targets.has(elementId(item)) && !targets.has(item.id)
        && !(item.type === 'wb_draw_line' && ((item.startAnchor && targets.has(item.startAnchor.elementId)) || (item.endAnchor && targets.has(item.endAnchor.elementId)))));
    } else if (action.type.startsWith('wb_draw_')) {
      const index = visible.findIndex((item) => elementId(item) === elementId(action));
      if (index >= 0) visible[index] = action;
      else visible.push(action);
    }
  }
  return visible;
}

export function whiteboardAIPrompt(
  sceneId: string,
  block: WhiteboardBlock,
  instruction: string,
): string {
  return `请使用 edit_whiteboard 编辑当前白板。页面 ID：${sceneId}；白板 ID：${block.id}。\n教师要求：${instruction}\n白板步骤按顺序播放，speech 为 AI 讲解，wb_draw_text 为逐次板书，支持表格、图表、图片、图形、连接箭头、公式和代码。保留其他课堂页面和白板以外的步骤。先读取当前页面获取最新白板内容。`;
}
