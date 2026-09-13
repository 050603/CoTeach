import { nanoid } from 'nanoid';
import { z } from 'zod';
import { validateAction } from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import { whiteboardBlocks } from './whiteboard-blocks';

export interface WhiteboardPatch {
  boardId: string;
  before: Action[];
  steps: Action[];
}

export const EMBEDDED_BOARD_IMAGE = '[embedded image omitted; keep this id and omit src to retain it]';
export const MAX_WHITEBOARD_STEPS = 120;

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(12000);
const color = z.string().min(1).max(64);
const size = z.number().finite().positive().max(5000);
const position = {
  x: z.number().finite().min(0).max(10000),
  y: z.number().finite().min(0).max(30000),
};
const drawing = { ...position, elementId: id.optional() };
const common = { id: id.optional(), groupId: id.optional(), title: z.string().max(200).optional(), description: z.string().max(2000).optional() };
const anchor = z.object({ elementId: id, side: z.enum(['top', 'right', 'bottom', 'left', 'center']) });
const tableData = z.array(z.array(z.string().max(2000)).min(1).max(16)).min(1).max(40)
  .refine((rows) => rows.every((row) => row.length === rows[0].length), '表格每行必须具有相同列数');

const stepSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('speech'), text, voice: z.string().max(200).optional(), speed: z.number().min(0.5).max(2).optional() }),
  z.object({ ...common, type: z.literal('wb_draw_text'), ...drawing, content: text, width: size.optional(), height: size.optional(), fontSize: z.number().min(8).max(120).optional(), color: color.optional() }),
  z.object({ ...common, type: z.literal('wb_draw_image'), ...drawing, src: z.string().max(1_000_000).optional(), width: size, height: size }),
  z.object({ ...common, type: z.literal('wb_draw_shape'), ...drawing, shape: z.enum(['rectangle', 'circle', 'triangle']), width: size, height: size, fillColor: color.optional() }),
  z.object({ ...common, type: z.literal('wb_draw_latex'), ...drawing, latex: text, width: size.optional(), height: size.optional(), color: color.optional() }),
  z.object({ ...common, type: z.literal('wb_draw_table'), ...drawing, width: size, height: size, data: tableData, outline: z.object({ width: z.number().min(0).max(20), style: z.enum(['solid', 'dashed', 'dotted']), color }).optional(), theme: z.object({ color }).optional() }),
  z.object({ ...common, type: z.literal('wb_draw_chart'), ...drawing, chartType: z.enum(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter']), width: size, height: size, data: z.object({ labels: z.array(z.string().max(200)).min(1).max(80), legends: z.array(z.string().max(200)).min(1).max(16), series: z.array(z.array(z.number().finite()).min(1).max(80)).min(1).max(16) }), themeColors: z.array(color).min(1).max(16).optional() }),
  z.object({ ...common, type: z.literal('wb_draw_line'), elementId: id.optional(), startX: position.x, startY: position.y, endX: position.x, endY: position.y, startAnchor: anchor.optional(), endAnchor: anchor.optional(), color: color.optional(), width: z.number().positive().max(30).optional(), style: z.enum(['solid', 'dashed']).optional(), points: z.tuple([z.enum(['', 'arrow']), z.enum(['', 'arrow'])]).optional() }),
  z.object({ ...common, type: z.literal('wb_draw_code'), ...drawing, language: z.string().min(1).max(40), code: z.string().max(30000), width: size.optional(), height: size.optional(), fileName: z.string().max(200).optional() }),
  z.object({ ...common, type: z.literal('wb_edit_code'), elementId: id, operation: z.enum(['insert_after', 'insert_before', 'delete_lines', 'replace_lines']), lineId: id.optional(), lineIds: z.array(id).min(1).max(500).optional(), content: z.string().max(30000).optional() }),
  z.object({ ...common, type: z.literal('wb_clear') }),
  z.object({ ...common, type: z.literal('wb_delete'), elementId: id }),
]);

function safeImageSource(src: string): boolean {
  if (!src || src !== src.trim() || /[\u0000-\u0020\\]/.test(src)) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(src)) return true;
  if (src.startsWith('/') && !src.startsWith('//')) return true;
  try {
    const url = new URL(src);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validate an AI-authored replacement against the actual, existing board. */
export function prepareWhiteboardPatch(
  actions: readonly Action[],
  boardId: string,
  proposedSteps: unknown,
): WhiteboardPatch {
  const block = whiteboardBlocks(actions).find((item) => item.id === boardId);
  if (!block) throw new Error('没有找到要编辑的白板，请重新读取当前页面后再试。');
  if (!Array.isArray(proposedSteps) || proposedSteps.length > MAX_WHITEBOARD_STEPS) {
    throw new Error(`白板步骤必须是列表，且最多 ${MAX_WHITEBOARD_STEPS} 步。`);
  }
  if (JSON.stringify(proposedSteps).length > 1_000_000) {
    throw new Error('白板内容过长，请分次编辑；已有内嵌图片可保留步骤 ID 并省略 src。');
  }
  const previous = new Map(block.steps.map((action) => [action.id, action]));
  const outside = actions.filter((_action, index) => index <= block.start || index > block.end || actions[index].type === 'wb_close');
  const reservedIds = new Set(outside.map((action) => action.id));
  const reservedElements = new Set(outside.flatMap((action) =>
    action.type.startsWith('wb_draw_') && 'elementId' in action && action.elementId ? [action.elementId] : [],
  ));
  const usedIds = new Set<string>();
  const usedElements = new Map<string, Action['type']>();
  const visibleElements = new Map<string, Action['type']>();
  const steps = proposedSteps.map((raw, index): Action => {
    const parsed = stepSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') || 'type';
      throw new Error(`第 ${index + 1} 步参数不正确（${field}）；只允许讲解、白板绘制、清空或擦除，不能嵌套打开/关闭白板。`);
    }
    const stepId = parsed.data.id ?? `board-action-${nanoid(10)}`;
    if (reservedIds.has(stepId) || usedIds.has(stepId)) throw new Error(`第 ${index + 1} 步的 ID 重复或属于白板之外的步骤。`);
    usedIds.add(stepId);
    const before = previous.get(stepId);
    const candidate = { ...parsed.data, id: stepId } as Action;

    if (candidate.type.startsWith('wb_draw_')) {
      const draw = candidate as Action & { elementId?: string };
      draw.elementId ??= before && 'elementId' in before ? before.elementId : undefined;
      draw.elementId ??= `element-${stepId}`;
      if (reservedElements.has(draw.elementId)) throw new Error(`第 ${index + 1} 步的元素 ID 属于其他白板。`);
      if (usedElements.has(draw.elementId) && usedElements.get(draw.elementId) !== draw.type) throw new Error(`第 ${index + 1} 步复用的元素 ID 必须保持原素材类型。`);
      usedElements.set(draw.elementId, draw.type);
      visibleElements.set(draw.elementId, draw.type);
    }
    if (candidate.type === 'wb_draw_line') {
      for (const endpoint of [candidate.startAnchor, candidate.endAnchor]) {
        if (!endpoint) continue;
        const targetType = visibleElements.get(endpoint.elementId);
        if (!targetType || targetType === 'wb_draw_line') throw new Error(`第 ${index + 1} 步的箭头必须连接之前已绘制且尚未清除的内容元素。`);
      }
    }
    if (candidate.type === 'wb_draw_image') {
      if ((candidate.src === undefined || candidate.src === EMBEDDED_BOARD_IMAGE) && before?.type === 'wb_draw_image') candidate.src = before.src;
      const trustedExisting = before?.type === 'wb_draw_image' && candidate.src === before.src;
      if (typeof candidate.src !== 'string' || !candidate.src || (!trustedExisting && !safeImageSource(candidate.src))) {
        throw new Error(`第 ${index + 1} 步需要有效的图片地址，请使用已上传图片地址或 HTTP(S) 图片地址；保留已有内嵌图片时请保留 ID 并省略 src。`);
      }
    }
    if (candidate.type === 'wb_draw_text' && candidate.content !== (before?.type === 'wb_draw_text' ? before.content : undefined) && /<\/?[a-z!]/i.test(candidate.content)) {
      throw new Error(`第 ${index + 1} 步的板书文字请使用纯文本，图片、表格、公式和代码请使用对应白板步骤。`);
    }
    if (candidate.type === 'speech') {
      if (before?.type === 'speech') {
        if (candidate.voice === undefined && before.voice !== undefined) candidate.voice = before.voice;
        if (candidate.speed === undefined && before.speed !== undefined) candidate.speed = before.speed;
      }
      if (before?.type === 'speech' && candidate.text === before.text && candidate.voice === before.voice && candidate.speed === before.speed) {
        if (before.audioId !== undefined) candidate.audioId = before.audioId;
        if (before.audioUrl !== undefined) candidate.audioUrl = before.audioUrl;
        if (before.audioInvalidated !== undefined) candidate.audioInvalidated = before.audioInvalidated;
      } else candidate.audioInvalidated = true;
    }
    if (candidate.type === 'wb_draw_chart' && (candidate.data.series.length !== candidate.data.legends.length || candidate.data.series.some((series) => series.length !== candidate.data.labels.length))) {
      throw new Error(`第 ${index + 1} 步的图表标签、图例和数据数量不一致。`);
    }
    if (candidate.type === 'wb_clear') visibleElements.clear();
    if (candidate.type === 'wb_delete' || candidate.type === 'wb_edit_code') {
      const elementType = visibleElements.get(candidate.elementId);
      if (!elementType || (candidate.type === 'wb_edit_code' && elementType !== 'wb_draw_code')) throw new Error(`第 ${index + 1} 步只能擦除或修改本白板之前步骤绘制且尚未清除的元素。`);
      if (candidate.type === 'wb_delete') visibleElements.delete(candidate.elementId);
      else if (
        ((candidate.operation === 'insert_after' || candidate.operation === 'insert_before') && (!candidate.lineId || candidate.content === undefined))
        || ((candidate.operation === 'delete_lines' || candidate.operation === 'replace_lines') && !candidate.lineIds?.length)
        || (candidate.operation === 'replace_lines' && candidate.content === undefined)
      ) throw new Error(`第 ${index + 1} 步缺少代码行 ID 或新代码内容。`);
    }
    const validation = validateAction(candidate);
    if (!validation.valid) throw new Error(`第 ${index + 1} 步缺少必要内容或位置参数：${validation.errors.map((issue) => issue.path).join('、')}`);
    return candidate;
  });
  return { boardId, before: structuredClone(block.steps), steps };
}
