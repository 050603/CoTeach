import type { Action, WbDrawLineAction } from '@openmaic/lib/types/action';
import {
  getWhiteboardActionBox, minimumWhiteboardTextHeight, resolveWhiteboardLine, WHITEBOARD_HEIGHT, WHITEBOARD_WIDTH,
  type WhiteboardActionBox,
} from '@openmaic/lib/whiteboard/layout';

const MARGIN = 24;
const GAP = 24;
type Box = WhiteboardActionBox;
type Drawing = { index: number; end: number; action: Action; box: Box };
type Group = { key: number; members: Drawing[]; box: Box; groupId?: string };
type Placement = { left: number; top: number; scale: number };
type PlacedGroup = { group: Group; placement: Placement };

const round = (value: number) => Math.round(value * 1000) / 1000;

function finiteBox(box: Box): boolean {
  return [box.left, box.top, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}

function unionBoxes(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  return {
    id: boxes[0].id, left, top,
    width: Math.max(...boxes.map((box) => box.left + box.width)) - left,
    height: Math.max(...boxes.map((box) => box.top + box.height)) - top,
  };
}

function containsLabel(shape: Drawing, label: Drawing): boolean {
  if (shape.action.type !== 'wb_draw_shape' || !['wb_draw_text', 'wb_draw_latex'].includes(label.action.type)) return false;
  if (shape.action.groupId && label.action.groupId && shape.action.groupId !== label.action.groupId) return false;
  const outer = shape.box;
  const inner = label.box;
  return Math.max(shape.index, label.index) < Math.min(shape.end, label.end)
    && inner.left >= outer.left - 1 && inner.top >= outer.top - 1
    && inner.left + inner.width <= outer.left + outer.width + 1
    && inner.top + inner.height <= outer.top + outer.height + 1;
}

function collectGroups(actions: readonly Action[]): { groups: Map<number, Group>; byIndex: Map<number, number> } {
  const drawings: Drawing[] = [];
  const live = new Map<string, Drawing>();
  actions.forEach((action, index) => {
    if (action.type === 'wb_delete') {
      const previous = live.get(action.elementId) ?? [...live.values()].find((drawing) => drawing.action.id === action.elementId);
      if (previous) { previous.end = index; live.delete(previous.box.id); }
      return;
    }
    const box = getWhiteboardActionBox(action);
    if (!box || !finiteBox(box)) return;
    const previous = live.get(box.id);
    if (previous) previous.end = index;
    const drawing = { index, end: actions.length, action, box };
    drawings.push(drawing);
    live.set(box.id, drawing);
  });
  const parents = drawings.map((_drawing, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) index = parents[index];
    return index;
  };
  for (let left = 0; left < drawings.length; left++) {
    for (let right = left + 1; right < drawings.length; right++) {
      const a = drawings[left];
      const b = drawings[right];
      if ((a.action.groupId && a.action.groupId === b.action.groupId) || containsLabel(a, b) || containsLabel(b, a)) {
        parents[root(right)] = root(left);
      }
    }
  }
  const members = new Map<number, Drawing[]>();
  const byIndex = new Map<number, number>();
  drawings.forEach((drawing, index) => {
    const key = root(index);
    members.set(key, [...(members.get(key) ?? []), drawing]);
    byIndex.set(drawing.index, key);
  });
  return {
    byIndex,
    groups: new Map([...members].map(([key, entries]) => [key, {
      key, members: entries, box: unionBoxes(entries.map((entry) => entry.box)),
      groupId: entries.find((entry) => entry.action.groupId)?.action.groupId
        ?? (entries.length > 1 ? 'wb-group-' + entries[0].action.id : undefined),
    }])),
  };
}

function intersectionArea(a: Box, b: Box, gap = 0): number {
  const width = Math.min(a.left + a.width + gap, b.left + b.width + gap) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height + gap, b.top + b.height + gap) - Math.max(a.top, b.top);
  return Math.max(0, width) * Math.max(0, height);
}

function scaledTextFontSize(action: Extract<Action, { type: 'wb_draw_text' }>, scale: number): number {
  const sourceFontSize = action.fontSize ?? 18;
  return round(Math.max(12, Math.min(sourceFontSize, 14), sourceFontSize * scale));
}

function scaledDrawingBox(action: Action, origin: Box, scale: number): Box | null {
  const box = getWhiteboardActionBox(action);
  if (!box) return null;
  const width = round(box.width * scale);
  const scaledHeight = round(box.height * scale);
  const height = action.type === 'wb_draw_text'
    ? round(Math.max(
        scaledHeight,
        minimumWhiteboardTextHeight({
          ...action,
          width,
          fontSize: scaledTextFontSize(action, scale),
        }, width),
      ))
    : scaledHeight;
  return {
    id: box.id,
    left: round((box.left - origin.left) * scale),
    top: round((box.top - origin.top) * scale),
    width,
    height,
  };
}

function scaledGroupBox(group: Group, origin: Box, scale: number): Box {
  return unionBoxes(group.members.flatMap(({ action }) => {
    const box = scaledDrawingBox(action, origin, scale);
    return box ? [box] : [];
  }));
}

function groupAt(group: Group, index: number): Group {
  const members = new Map<string, Drawing>();
  for (const drawing of group.members) {
    if (drawing.index <= index && index < drawing.end) members.set(drawing.box.id, drawing);
  }
  // Reserve labels/nodes belonging to this composition, but stop at its next
  // replacement/deletion. A later movement of the same element must not turn
  // its whole trajectory into occupied space or shrink the earlier diagram.
  const horizon = Math.min(...[...members.values()].map((drawing) => drawing.end));
  for (const drawing of group.members) {
    if (drawing.index > index && drawing.index < horizon && !members.has(drawing.box.id)) members.set(drawing.box.id, drawing);
  }
  const entries = [...members.values()];
  return entries.length ? { ...group, members: entries, box: unionBoxes(entries.map((drawing) => drawing.box)) } : group;
}

function placeGroup(group: Group, occupied: Box[]): Placement {
  const availableWidth = WHITEBOARD_WIDTH - 2 * MARGIN;
  const availableHeight = WHITEBOARD_HEIGHT - 2 * MARGIN;
  const scaleToFit = Math.min(1, availableWidth / group.box.width, availableHeight / group.box.height);
  // Code/table fonts have no scalable field; retain readability and diagnose
  // overflow rather than silently squeezing their text into a smaller box.
  const minimumScale = Math.max(0, ...group.members.map(({ action }) => {
    if (action.type === 'wb_draw_text') return Math.min(1, 14 / (action.fontSize ?? 18));
    if (action.type === 'wb_draw_code' || action.type === 'wb_draw_table') return 1;
    return 0;
  }));
  let scale = Math.min(1, Math.max(scaleToFit, minimumScale));
  let scaledBox = scaledGroupBox(group, group.box, scale);
  // Text has fixed renderer padding, so proportional geometry can remain a
  // few pixels too tall after scaling. Recalculate against the actual text
  // bounds while respecting the established readable-font floor.
  for (let attempt = 0; attempt < 3; attempt++) {
    const correction = Math.min(1, availableWidth / scaledBox.width, availableHeight / scaledBox.height);
    const nextScale = Math.max(minimumScale, scale * correction);
    if (correction >= 0.999 || nextScale >= scale - 0.001) break;
    scale = nextScale;
    scaledBox = scaledGroupBox(group, group.box, scale);
  }
  const { width, height } = scaledBox;
  const clamp = (value: number, maximum: number) => Math.max(MARGIN, Math.min(value, maximum - MARGIN));
  const left = clamp(group.box.left, WHITEBOARD_WIDTH - width);
  const top = clamp(group.box.top, WHITEBOARD_HEIGHT - height);
  const original: Box = { ...group.box, left, top, width, height };
  if (!occupied.some((box) => intersectionArea(original, box, GAP) > 0)) return { left, top, scale };
  const xs = new Set([left, MARGIN, WHITEBOARD_WIDTH - MARGIN - width]);
  const ys = new Set([top, MARGIN, WHITEBOARD_HEIGHT - MARGIN - height]);
  occupied.forEach((box) => {
    xs.add(box.left + box.width + GAP); xs.add(box.left - width - GAP);
    ys.add(box.top + box.height + GAP); ys.add(box.top - height - GAP);
  });
  const candidates: Array<{ box: Box; overlap: number; distance: number }> = [];
  for (const x of xs) for (const y of ys) {
    if (x < MARGIN || y < MARGIN || x + width > WHITEBOARD_WIDTH - MARGIN + 0.01 || y + height > WHITEBOARD_HEIGHT - MARGIN + 0.01) continue;
    const box = { ...original, left: x, top: y };
    candidates.push({
      box, overlap: occupied.reduce((sum, entry) => sum + intersectionArea(box, entry, GAP), 0),
      distance: (x - left) ** 2 + (y - top) ** 2,
    });
  }
  // A full page keeps every readable element; audit reports the remaining
  // overlap so the teacher/model can explicitly split the teaching sequence.
  candidates.sort((a, b) => a.overlap - b.overlap || a.distance - b.distance || a.box.top - b.box.top || a.box.left - b.box.left);
  const chosen = candidates[0]?.box ?? original;
  return { left: chosen.left, top: chosen.top, scale };
}

function transformDrawing(source: Action, group: Group, placement: Placement): Action {
  const box = getWhiteboardActionBox(source);
  if (!box || !('x' in source)) return { ...source };
  const transformed = scaledDrawingBox(source, group.box, placement.scale)!;
  const fontSize = source.type === 'wb_draw_text' ? scaledTextFontSize(source, placement.scale) : undefined;
  return {
    ...source,
    x: round(placement.left + transformed.left),
    y: round(placement.top + transformed.top),
    ...(group.groupId ? { groupId: group.groupId } : {}),
    ...(placement.scale !== 1 || transformed.height !== box.height
      ? { width: transformed.width, height: transformed.height }
      : {}),
    ...(source.type === 'wb_draw_text' && fontSize !== (source.fontSize ?? 18) ? { fontSize } : {}),
  } as Action;
}

function inferAnchor(x: number, y: number, visible: readonly Action[]): WbDrawLineAction['startAnchor'] {
  const matches: Array<{ anchor: NonNullable<WbDrawLineAction['startAnchor']>; distance: number }> = [];
  for (const action of visible) {
    const box = getWhiteboardActionBox(action);
    if (!box || !finiteBox(box)) continue;
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const anchor = { elementId: box.id, side };
      const probe = resolveWhiteboardLine({
        id: 'probe', type: 'wb_draw_line', startX: x, startY: y, endX: x, endY: y, startAnchor: anchor,
      }, [action]);
      const distance = Math.hypot(probe.startX - x, probe.startY - y);
      if (distance <= 24) matches.push({ anchor, distance });
    }
  }
  matches.sort((a, b) => a.distance - b.distance);
  return matches[0] && (!matches[1] || matches[1].distance - matches[0].distance > 2) ? matches[0].anchor : undefined;
}

function normalizePage(actions: readonly Action[]): Action[] {
  const { groups, byIndex } = collectGroups(actions);
  const placements = new Map<number, PlacedGroup>();
  const originalVisible = new Map<string, Action>();
  const normalizedVisible = new Map<string, Action>();
  const activeGroups = new Map<string, number>();
  const remove = (id: string) => {
    const action = originalVisible.get(id) ?? [...originalVisible.values()].find((entry) => entry.id === id);
    if (!action) return;
    const elementId = getWhiteboardActionBox(action)?.id ?? ('elementId' in action && action.elementId ? action.elementId : action.id);
    originalVisible.delete(elementId); normalizedVisible.delete(elementId); activeGroups.delete(elementId);
    for (const [key, line] of normalizedVisible) {
      if (line.type === 'wb_draw_line' && [line.startAnchor, line.endAnchor].some((anchor) => anchor && [elementId, action.id].includes(anchor.elementId))) {
        originalVisible.delete(key); normalizedVisible.delete(key);
      }
    }
  };
  return actions.map((source, index) => {
    if (source.type === 'wb_delete') { remove(source.elementId); return { ...source }; }
    const key = byIndex.get(index);
    if (key !== undefined) {
      const group = groupAt(groups.get(key)!, index);
      const box = getWhiteboardActionBox(source)!;
      // Redrawing an id updates the node without removing its connectors.
      originalVisible.delete(box.id); normalizedVisible.delete(box.id); activeGroups.delete(box.id);
      if (![...activeGroups.values()].includes(key)) {
        const occupied = [...new Set(activeGroups.values())].map((activeKey) => {
          const entry = groupAt(groups.get(activeKey)!, index);
          const placed = placements.get(activeKey)!;
          const { placement } = placed;
          const box = scaledGroupBox(entry, placed.group.box, placement.scale);
          return {
            ...box,
            left: placement.left + box.left,
            top: placement.top + box.top,
          };
        });
        placements.set(key, { group, placement: placeGroup(group, occupied) });
      }
      const placed = placements.get(key)!;
      const next = transformDrawing(source, placed.group, placed.placement);
      originalVisible.set(box.id, source); normalizedVisible.set(box.id, next); activeGroups.set(box.id, key);
      return next;
    }
    if (source.type === 'wb_draw_line') {
      let line = { ...source };
      const startAnchor = source.startAnchor ?? inferAnchor(source.startX, source.startY, [...originalVisible.values()]);
      const endAnchor = source.endAnchor ?? inferAnchor(source.endX, source.endY, [...originalVisible.values()]);
      const group = source.groupId ? [...groups.values()].find((entry) => entry.groupId === source.groupId) : undefined;
      const placed = group ? placements.get(group.key) : undefined;
      const placement = placed?.placement;
      if (placed && placement) line = {
        ...line,
        startX: round(placement.left + (line.startX - placed.group.box.left) * placement.scale),
        startY: round(placement.top + (line.startY - placed.group.box.top) * placement.scale),
        endX: round(placement.left + (line.endX - placed.group.box.left) * placement.scale),
        endY: round(placement.top + (line.endY - placed.group.box.top) * placement.scale),
      };
      line = resolveWhiteboardLine({
        ...line, ...(startAnchor ? { startAnchor } : {}), ...(endAnchor ? { endAnchor } : {}),
      }, [...normalizedVisible.values()]);
      originalVisible.set(source.elementId || source.id, source); normalizedVisible.set(source.elementId || source.id, line);
      return line;
    }
    return { ...source };
  });
}

/** Preserve compositions and narration order on a fixed canvas. Only explicit
 * clear actions start a new page; open/close keep the existing board content. */
export function normalizeWhiteboardActionLayout(actions: ReadonlyArray<Action>): Action[] {
  const result: Action[] = [];
  let start = 0;
  actions.forEach((action, index) => {
    if (action.type !== 'wb_clear') return;
    result.push(...normalizePage(actions.slice(start, index)), { ...action });
    start = index + 1;
  });
  result.push(...normalizePage(actions.slice(start)));
  return result;
}
