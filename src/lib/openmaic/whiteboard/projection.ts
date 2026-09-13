import katex from 'katex';
import type { CodeLine, PPTCodeElement, PPTElement } from '@openmaic/dsl';
import type { Action, WbEditCodeAction } from '@openmaic/lib/types/action';
import { whiteboardTextHtml } from '@openmaic/lib/action/whiteboard-text';
import {
  getWhiteboardActionBox,
  resolveWhiteboardLine,
  WHITEBOARD_HEIGHT,
  WHITEBOARD_WIDTH,
} from './layout';
import { auditWhiteboardContent } from './quality';

export type WhiteboardDrawAction = Extract<Action, { type: `wb_draw_${string}` }>;

/** Persist the source geometry with native PPT elements so connectors survive reloads. */
export type WhiteboardElement = PPTElement & {
  whiteboard?: { action: WhiteboardDrawAction };
};

const SHAPE_PATHS = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 500 1000 A 500 500 0 1 1 500 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
};

function escapePlainText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isWhiteboardDrawAction(action: Action): action is WhiteboardDrawAction {
  return action.type.startsWith('wb_draw_');
}

/** The one Action → PPT conversion used by editing previews and live execution. */
export function whiteboardActionToElement(
  action: WhiteboardDrawAction,
  visibleActions: readonly Action[] = [],
): WhiteboardElement | null {
  const identity = {
    id: action.elementId || action.id,
    ...(action.groupId ? { groupId: action.groupId } : {}),
    whiteboard: { action: structuredClone(action) },
  };
  if (action.type === 'wb_draw_line') {
    const line = resolveWhiteboardLine(action, visibleActions);
    const left = Math.min(line.startX, line.endX);
    const top = Math.min(line.startY, line.endY);
    return {
      ...identity,
      type: 'line',
      left,
      top,
      width: line.width ?? 2,
      start: [line.startX - left, line.startY - top],
      end: [line.endX - left, line.endY - top],
      style: line.style ?? 'solid',
      color: line.color ?? '#333333',
      points: line.points ?? ['', ''],
    };
  }

  const box = getWhiteboardActionBox(action);
  if (!box) return null;
  const base = {
    ...identity,
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    rotate: 0,
  };
  const issue = auditWhiteboardContent([action])[0];
  if (issue) {
    const message = action.type === 'wb_draw_latex' ? `${action.latex}\n${issue.message}` : issue.message;
    return {
      ...base,
      type: 'text',
      content: `<p style="font-size:20px">${escapePlainText(message).replace(/\r?\n/g, '<br/>')}</p>`,
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#92400e',
      fill: '#fffbeb',
      outline: { color: '#fcd34d', width: 1, style: 'dashed' },
    };
  }
  switch (action.type) {
    case 'wb_draw_text':
      return {
        ...base,
        type: 'text',
        content: whiteboardTextHtml(action.content ?? '', action.fontSize ?? 18),
        defaultFontName: 'Microsoft YaHei',
        defaultColor: action.color ?? '#333333',
      };
    case 'wb_draw_image':
      return { ...base, type: 'image', src: action.src, fixedRatio: true };
    case 'wb_draw_shape':
      return {
        ...base,
        type: 'shape',
        path: SHAPE_PATHS[action.shape] ?? SHAPE_PATHS.rectangle,
        viewBox: [1000, 1000],
        fill: action.fillColor ?? '#5b9bd5',
        fixedRatio: false,
      };
    case 'wb_draw_chart':
      return {
        ...base,
        type: 'chart',
        chartType: action.chartType,
        data: action.data,
        themeColors: action.themeColors ?? ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
      };
    case 'wb_draw_latex':
      return {
        ...base,
        type: 'latex',
        latex: action.latex,
        html: `<span style="font-size:28px">${katex.renderToString(action.latex, {
          throwOnError: false,
          trust: false,
          displayMode: true,
          output: 'html',
        })}</span>`,
        color: action.color ?? '#000000',
        fixedRatio: true,
      };
    case 'wb_draw_table': {
      const columns = action.data[0]?.length ?? 0;
      if (!columns) return null;
      return {
        ...base,
        type: 'table',
        colWidths: Array.from({ length: columns }, () => 1 / columns),
        cellMinHeight: 36,
        data: action.data.map((row, rowIndex) => row.map((text, columnIndex) => ({
          id: `${base.id}-cell-${rowIndex}-${columnIndex}`,
          colspan: 1,
          rowspan: 1,
          text: escapePlainText(text),
          style: { fontsize: '18px', fontname: 'Microsoft YaHei' },
        }))),
        outline: action.outline ? {
          ...action.outline,
          style: action.outline.style === 'dashed' || action.outline.style === 'dotted'
            ? action.outline.style
            : 'solid',
        } : { width: 2, style: 'solid', color: '#eeece1' },
        theme: action.theme ? {
          color: action.theme.color,
          rowHeader: true,
          rowFooter: false,
          colHeader: false,
          colFooter: false,
        } : undefined,
      };
    }
    case 'wb_draw_code':
      return {
        ...base,
        type: 'code',
        language: action.language,
        lines: action.code.split('\n').map((content, index) => ({ id: `L${index + 1}`, content })),
        fileName: action.fileName,
        showLineNumbers: true,
        fontSize: 14,
      };
  }
}

/** Read current native geometry, including changes applied directly through the Stage API. */
function visibleDrawActions(elements: readonly PPTElement[]): Action[] {
  return elements.flatMap((element): Action[] => {
    const source = (element as WhiteboardElement).whiteboard?.action;
    if (element.type === 'line') return [];
    const geometry = {
      id: source?.id ?? element.id,
      elementId: element.id,
      x: element.left,
      y: element.top,
      width: element.width,
      height: element.height,
    };
    if (source && source.type !== 'wb_draw_line') return [{ ...source, ...geometry }];
    // Older persisted native elements have no source metadata, but still serve
    // as rectangular attachment targets for newly authored connectors.
    return [{ ...geometry, type: 'wb_draw_shape', shape: 'rectangle' }];
  });
}

/** Re-resolve every attached connector when its visible targets move or disappear. */
export function resolveWhiteboardElementAnchors(elements: readonly PPTElement[]): PPTElement[] {
  const visible = visibleDrawActions(elements);
  return elements.map((element) => {
    const action = (element as WhiteboardElement).whiteboard?.action;
    if (element.type !== 'line' || action?.type !== 'wb_draw_line') return element;
    if (!action.startAnchor && !action.endAnchor) return element;
    const projected = whiteboardActionToElement(action, visible);
    if (!projected || projected.type !== 'line') return element;
    return {
      ...element,
      left: projected.left,
      top: projected.top,
      start: projected.start,
      end: projected.end,
    };
  });
}

/** Draw commands update their stable element ID without changing its stacking order. */
export function upsertWhiteboardElement(
  elements: readonly PPTElement[],
  element: PPTElement,
): PPTElement[] {
  const exists = elements.some((current) => current.id === element.id);
  return resolveWhiteboardElementAnchors(exists
    ? elements.map((current) => current.id === element.id ? element : current)
    : [...elements, element]);
}

/** Erasing an object also erases connectors attached to it, rather than leaving dangling arrows. */
export function removeWhiteboardElement(elements: readonly PPTElement[], elementId: string): PPTElement[] {
  const removedIds = new Set([elementId]);
  for (const element of elements) {
    const sourceId = (element as WhiteboardElement).whiteboard?.action.id;
    if (element.id === elementId || sourceId === elementId) {
      removedIds.add(element.id);
      if (sourceId) removedIds.add(sourceId);
    }
  }
  return resolveWhiteboardElementAnchors(elements.filter((element) => {
    const source = (element as WhiteboardElement).whiteboard?.action;
    if (removedIds.has(element.id) || (source && removedIds.has(source.id))) return false;
    return source?.type !== 'wb_draw_line'
      || ![source.startAnchor, source.endAnchor].some((anchor) => anchor && removedIds.has(anchor.elementId));
  }));
}

/** Deterministic line IDs let the same edit sequence replay identically in both views. */
export function editWhiteboardCodeElement(
  element: PPTCodeElement,
  action: WbEditCodeAction,
): PPTCodeElement {
  let lines = [...element.lines];
  const content = action.content === undefined ? [] : action.content.split('\n');
  const newLines = (preservedIds: readonly string[] = []): CodeLine[] => content.map((text, index) => ({
    id: preservedIds[index] ?? `L_${action.id}_${index + 1}`,
    content: text,
  }));
  switch (action.operation) {
    case 'insert_after':
    case 'insert_before': {
      const index = lines.findIndex((line) => line.id === action.lineId);
      if (index < 0 || action.content === undefined) return element;
      const inserted = newLines();
      if (inserted.some((line) => lines.some((existing) => existing.id === line.id))) return element;
      lines.splice(index + (action.operation === 'insert_after' ? 1 : 0), 0, ...inserted);
      break;
    }
    case 'delete_lines':
    case 'replace_lines': {
      if (!action.lineIds?.length || action.lineIds.some((id) => !lines.some((line) => line.id === id)))
        return element;
      const index = lines.findIndex((line) => line.id === action.lineIds![0]);
      const removed = new Set(action.lineIds);
      lines = lines.filter((line) => !removed.has(line.id));
      if (action.operation === 'replace_lines') {
        if (action.content === undefined) return element;
        lines.splice(index, 0, ...newLines(action.lineIds));
      }
      break;
    }
  }
  return { ...element, lines };
}

/** Apply a single board command without animations or browser/store dependencies. */
export function applyWhiteboardAction(elements: readonly PPTElement[], action: Action): PPTElement[] {
  if (action.type === 'wb_clear') return [];
  if (action.type === 'wb_delete')
    return removeWhiteboardElement(elements, action.elementId);
  if (action.type === 'wb_edit_code') {
    return elements.map((element) => element.id === action.elementId && element.type === 'code'
      ? editWhiteboardCodeElement(element, action)
      : element);
  }
  if (isWhiteboardDrawAction(action)) {
    const element = whiteboardActionToElement(action, visibleDrawActions(elements));
    return element ? upsertWhiteboardElement(elements, element) : [...elements];
  }
  return [...elements];
}

export function projectWhiteboardActions(actions: readonly Action[]): PPTElement[] {
  return actions.reduce<PPTElement[]>((elements, action) => applyWhiteboardAction(elements, action), []);
}

/** Includes reverse-direction lines and negative coordinates when fitting the native surface. */
export function getWhiteboardViewport(elements: readonly PPTElement[], padding = 40) {
  let left = 0;
  let top = 0;
  let right = WHITEBOARD_WIDTH;
  let bottom = WHITEBOARD_HEIGHT;
  for (const element of elements) {
    const startX = element.type === 'line' ? Math.min(element.start[0], element.end[0]) : 0;
    const startY = element.type === 'line' ? Math.min(element.start[1], element.end[1]) : 0;
    const endX = element.type === 'line' ? Math.max(element.start[0], element.end[0]) : element.width;
    const endY = element.type === 'line' ? Math.max(element.start[1], element.end[1]) : element.height;
    left = Math.min(left, element.left + startX);
    top = Math.min(top, element.top + startY);
    right = Math.max(right, element.left + endX);
    bottom = Math.max(bottom, element.top + endY);
  }
  if (left < 0) left -= padding;
  if (top < 0) top -= padding;
  if (right > WHITEBOARD_WIDTH) right += padding;
  if (bottom > WHITEBOARD_HEIGHT) bottom += padding;
  return { left, top, width: right - left, height: bottom - top };
}
