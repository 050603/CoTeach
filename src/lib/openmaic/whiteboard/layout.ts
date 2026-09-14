import type { Action, WbDrawLineAction } from '@openmaic/lib/types/action';

export const WHITEBOARD_WIDTH = 1000;
export const WHITEBOARD_HEIGHT = 562.5;

export interface WhiteboardActionBox {
  /** Matches the rendered element id, including legacy actions without elementId. */
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type WhiteboardLayoutIssueCode =
  | 'out-of-bounds'
  | 'overlap'
  | 'missing-anchor'
  | 'invalid-geometry'
  | 'unreadable-content'
  | 'missing-target'
  | 'line-through-content';

export interface WhiteboardLayoutIssue {
  code: WhiteboardLayoutIssueCode;
  message: string;
  actionIds: string[];
}

/** Lines connect occupied regions; they are never occupied rectangles. */
export function getWhiteboardActionBox(action: Action): WhiteboardActionBox | null {
  const id = 'elementId' in action && action.elementId ? action.elementId : action.id;
  switch (action.type) {
    case 'wb_draw_text':
      return { id, left: action.x, top: action.y, width: action.width ?? 400, height: action.height ?? 100 };
    case 'wb_draw_shape':
    case 'wb_draw_image':
    case 'wb_draw_chart':
    case 'wb_draw_table':
      return { id, left: action.x, top: action.y, width: action.width, height: action.height };
    case 'wb_draw_latex':
      return { id, left: action.x, top: action.y, width: action.width ?? 400, height: action.height ?? 80 };
    case 'wb_draw_code':
      return { id, left: action.x, top: action.y, width: action.width ?? 500, height: action.height ?? 300 };
    default:
      return null;
  }
}

function validBox(box: WhiteboardActionBox): boolean {
  return [box.left, box.top, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0;
}

function targetFor(id: string, actions: readonly Action[]): Action | undefined {
  // Last write wins when callers provide a list rather than a keyed projection.
  return actions.findLast((action) => {
    const box = getWhiteboardActionBox(action);
    return box && (box.id === id || action.id === id);
  });
}

type Anchor = NonNullable<WbDrawLineAction['startAnchor']>;

function anchorPoint(action: Action, side: Anchor['side']): { x: number; y: number } | null {
  const box = getWhiteboardActionBox(action);
  if (!box || !validBox(box)) return null;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const triangle = action.type === 'wb_draw_shape' && action.shape === 'triangle';
  switch (side) {
    case 'top': return { x, y: box.top };
    case 'right': return { x: box.left + box.width * (triangle ? 0.75 : 1), y };
    case 'bottom': return { x, y: box.top + box.height };
    case 'left': return { x: box.left + box.width * (triangle ? 0.25 : 0), y };
    case 'center': return { x, y };
    default: return null;
  }
}

/** Resolve against the currently visible drawing actions. A deleted/missing
 * target leaves that endpoint's original coordinates intact; audit reports it. */
export function resolveWhiteboardLine<T extends WbDrawLineAction>(
  action: T,
  visibleActions: readonly Action[],
): T {
  const resolve = (anchor: Anchor | undefined) => {
    if (!anchor) return null;
    const target = targetFor(anchor.elementId, visibleActions);
    return target ? anchorPoint(target, anchor.side) : null;
  };
  const start = resolve(action.startAnchor);
  const end = resolve(action.endAnchor);
  return {
    ...action,
    ...(start ? { startX: start.x, startY: start.y } : {}),
    ...(end ? { endX: end.x, endY: end.y } : {}),
  };
}

function contains(outer: WhiteboardActionBox, inner: WhiteboardActionBox): boolean {
  return inner.left >= outer.left - 1 && inner.top >= outer.top - 1
    && inner.left + inner.width <= outer.left + outer.width + 1
    && inner.top + inner.height <= outer.top + outer.height + 1;
}

function isContainedLabel(shape: Action, label: Action): boolean {
  if (shape.type !== 'wb_draw_shape' || !['wb_draw_text', 'wb_draw_latex'].includes(label.type)) return false;
  const outer = getWhiteboardActionBox(shape);
  const inner = getWhiteboardActionBox(label);
  return Boolean(outer && inner && contains(outer, inner));
}

export function minimumWhiteboardTextHeight(
  action: Extract<Action, { type: 'wb_draw_text' }>,
  width = action.width ?? 400,
): number {
  const fontSize = action.fontSize ?? 18;
  const plain = action.content.replace(/<br\s*\/?\s*>|<\/(?:p|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').trim();
  if (!plain) return 0;
  const rows = plain.split('\n').reduce((sum, line) => {
    const measuredWidth = [...line].reduce((total, character) => total + fontSize * (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.6), 0);
    return sum + Math.max(1, Math.ceil(measuredWidth / Math.max(1, width - 20)));
  }, 0);
  // The native text element uses 10px padding and a 1.5 line-height. This is
  // deliberately conservative: a single-line label must have room for both.
  return rows * fontSize * 1.5 + 20;
}

function textWillClip(action: Extract<Action, { type: 'wb_draw_text' }>, box: WhiteboardActionBox): boolean {
  return minimumWhiteboardTextHeight(action, box.width) > box.height + 1;
}

function lineCrossesBox(line: WbDrawLineAction, box: WhiteboardActionBox): boolean {
  // Clip the finite segment against the box interior. Merely touching an edge
  // is a valid connector and does not count as obscuring unrelated content.
  const inset = Math.min(2, box.width / 4, box.height / 4);
  let start = 0;
  let end = 1;
  for (const [origin, delta, minimum, maximum] of [
    [line.startX, line.endX - line.startX, box.left + inset, box.left + box.width - inset],
    [line.startY, line.endY - line.startY, box.top + inset, box.top + box.height - inset],
  ]) {
    if (Math.abs(delta) < 0.000001) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta;
    const last = (maximum - origin) / delta;
    start = Math.max(start, Math.min(first, last));
    end = Math.min(end, Math.max(first, last));
    if (end <= start) return false;
  }
  return end > start && Math.hypot(line.endX - line.startX, line.endY - line.startY) > 1;
}

/** Replay the same lifecycle as playback: open/close only change visibility;
 * clear removes content, delete removes one target, and redraw replaces an id.
 * Issues include intermediate states so a later clear cannot hide an earlier
 * unreadable teaching step. */
export function auditWhiteboardLayout(actions: readonly Action[]): WhiteboardLayoutIssue[] {
  const visible = new Map<string, Action>();
  const issues = new Map<string, WhiteboardLayoutIssue>();
  const report = (issue: WhiteboardLayoutIssue) => {
    const key = JSON.stringify([issue.code, [...issue.actionIds].sort(), issue.message]);
    issues.set(key, issue);
  };
  const inspectVisible = () => {
    const current = [...visible.values()];
    const boxes = current.flatMap((action) => {
      const box = getWhiteboardActionBox(action);
      return box && validBox(box) ? [{ action, box }] : [];
    });
    for (let left = 0; left < boxes.length; left++) {
      for (let right = left + 1; right < boxes.length; right++) {
        const a = boxes[left];
        const b = boxes[right];
        if (isContainedLabel(a.action, b.action) || isContainedLabel(b.action, a.action)) continue;
        const width = Math.min(a.box.left + a.box.width, b.box.left + b.box.width) - Math.max(a.box.left, b.box.left);
        const height = Math.min(a.box.top + a.box.height, b.box.top + b.box.height) - Math.max(a.box.top, b.box.top);
        if (width > 1 && height > 1 && width * height > Math.min(a.box.width * a.box.height, b.box.width * b.box.height) * 0.06) {
          report({ code: 'overlap', message: '两个白板内容互相遮挡，请移动内容或使用新的一页。', actionIds: [a.action.id, b.action.id] });
        }
      }
    }
    for (const action of current) {
      if (action.type !== 'wb_draw_line') continue;
      for (const anchor of [action.startAnchor, action.endAnchor]) {
        const target = anchor ? targetFor(anchor.elementId, current) : undefined;
        if (anchor && (!target || !anchorPoint(target, anchor.side))) {
          report({ code: 'missing-anchor', message: `连线引用的对象“${anchor.elementId}”尚未绘制、已删除或没有有效边界。`, actionIds: [action.id] });
        }
      }
      const line = resolveWhiteboardLine(action, current);
      const coordinates = [line.startX, line.startY, line.endX, line.endY];
      if (!coordinates.every(Number.isFinite)) {
        report({ code: 'invalid-geometry', message: '连线包含无效坐标。', actionIds: [action.id] });
      } else if ([line.startX, line.endX].some((x) => x < 0 || x > WHITEBOARD_WIDTH)
        || [line.startY, line.endY].some((y) => y < 0 || y > WHITEBOARD_HEIGHT)) {
        report({ code: 'out-of-bounds', message: '连线超出白板画布。', actionIds: [action.id] });
      }
      if (coordinates.every(Number.isFinite)) {
        const targets = [action.startAnchor, action.endAnchor]
          .flatMap((anchor) => anchor ? [targetFor(anchor.elementId, current)].filter((target): target is Action => Boolean(target)) : []);
        for (const entry of boxes) {
          if (targets.some((target) => target.id === entry.action.id || isContainedLabel(target, entry.action))) continue;
          if (lineCrossesBox(line, entry.box)) report({
            code: 'line-through-content', message: '连线穿过了无关内容，请调整对象位置或连接方向。', actionIds: [action.id, entry.action.id],
          });
        }
      }
    }
  };
  for (const action of actions) {
    if (action.type === 'wb_clear') {
      visible.clear();
      continue;
    }
    if (action.type === 'wb_delete' || action.type === 'wb_edit_code') {
      const target = visible.get(action.elementId)
        ?? [...visible.values()].find((candidate) => candidate.id === action.elementId);
      if (!target || (action.type === 'wb_edit_code' && target.type !== 'wb_draw_code')) {
        report({ code: 'missing-target', message: '擦除或修改的白板对象尚未绘制或已被清除。', actionIds: [action.id] });
      } else if (action.type === 'wb_delete') {
        const targetId = getWhiteboardActionBox(target)?.id
          ?? ('elementId' in target && target.elementId ? target.elementId : target.id);
        visible.delete(targetId);
        for (const [id, line] of visible) {
          if (line.type === 'wb_draw_line' && [line.startAnchor, line.endAnchor]
            .some((anchor) => anchor && [targetId, target.id].includes(anchor.elementId))) visible.delete(id);
        }
      }
      inspectVisible();
      continue;
    }
    const box = getWhiteboardActionBox(action);
    if (box) {
      visible.set(box.id, action);
      if (!validBox(box)) {
        report({ code: 'invalid-geometry', message: '白板内容的位置或尺寸无效，宽高必须为正数。', actionIds: [action.id] });
      } else {
        if (box.left < 0 || box.top < 0 || box.left + box.width > WHITEBOARD_WIDTH + 0.01
          || box.top + box.height > WHITEBOARD_HEIGHT + 0.01) {
          report({ code: 'out-of-bounds', message: '白板内容超出 1000 × 562.5 画布，请调整尺寸或使用新的一页。', actionIds: [action.id] });
        }
        if (action.type === 'wb_draw_text' && ((action.fontSize ?? 18) < 12 || textWillClip(action, box))) {
          report({ code: 'unreadable-content', message: '文字过小或超出文本框，请增大文本框或拆分内容。', actionIds: [action.id] });
        }
      }
    } else if (action.type === 'wb_draw_line') {
      visible.set(action.elementId || action.id, action);
    } else continue;
    inspectVisible();
  }
  return [...issues.values()];
}
