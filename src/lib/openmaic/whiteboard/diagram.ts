import type {
  Action, SpeechAnchor, WbDrawImageAction, WbDrawLineAction, WbDrawTextAction,
} from '../types/action';
import { minimumWhiteboardTextHeight, WHITEBOARD_HEIGHT, WHITEBOARD_WIDTH } from './layout';

export type WhiteboardDiagramIcon = 'person' | 'book' | 'target' | 'body' | 'environment'
  | 'group' | 'task' | 'strategy' | 'check';
export type WhiteboardDiagramNode = {
  key: string;
  label: string;
  lines?: Array<{ key: string; text: string }>;
  icon?: WhiteboardDiagramIcon;
  role?: 'source' | 'focus' | 'result';
};
export type WhiteboardDiagramRelation = {
  key: string;
  from: string;
  to: string;
  kind: 'branch' | 'supports' | 'sequence' | 'association';
};
export type WhiteboardDiagramPanel = {
  key: string;
  title?: string;
  kind: 'branches' | 'converge' | 'matrix';
  nodes: WhiteboardDiagramNode[];
  relations?: WhiteboardDiagramRelation[];
};
export type WhiteboardDiagram = { panels: WhiteboardDiagramPanel[] };
export type WhiteboardDiagramStep = {
  reveal: string[];
  /** Omitted: emphasize newly revealed text. Empty: remove current emphasis. */
  emphasize?: string[];
  speechId: string;
  speechAnchor: SpeechAnchor;
};
export type WhiteboardDiagramBinding = { speechId: string; speechAnchor: SpeechAnchor };
export type BoundWhiteboardDiagramAction = Action & WhiteboardDiagramBinding;
export type WhiteboardDiagramKeyEntry = {
  key: string;
  kind: 'node' | 'line' | 'relation';
  panelKey: string;
  text?: string;
  parentKey?: string;
};

const ICONS: readonly WhiteboardDiagramIcon[] = ['person', 'book', 'target', 'body', 'environment', 'group', 'task', 'strategy', 'check'];
const ROLES = ['source', 'focus', 'result'];
const RELATIONS = ['branch', 'supports', 'sequence', 'association'];
const PANEL_KINDS = ['branches', 'converge', 'matrix'];
const INK = '#334155';
const ACCENT = '#1d4ed8';
const MARGIN = 28;
const PANEL_WIDTH = WHITEBOARD_WIDTH - MARGIN * 2;
const PANEL_GAP = 16;
const ROW_GAP = 14;
const TEXT_SIZE = 24;
const LABEL_SIZE = 26;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Preserve every semantic item. Invalid references are not silently pruned. */
export function parseWhiteboardDiagram(value: unknown): WhiteboardDiagram | undefined {
  const raw = record(value);
  if (!Array.isArray(raw?.panels) || raw.panels.length === 0) return undefined;
  const keys = new Set<string>();
  const claim = (value: unknown): string | undefined => {
    const key = text(value);
    if (!key || keys.has(key)) return undefined;
    keys.add(key);
    return key;
  };
  const panels: WhiteboardDiagramPanel[] = [];
  for (const value of raw.panels) {
    const panel = record(value);
    const key = claim(panel?.key);
    const title = panel?.title === undefined ? undefined : text(panel.title);
    if (!key || !PANEL_KINDS.includes(String(panel?.kind)) || panel?.title !== undefined && !title
      || !Array.isArray(panel?.nodes) || panel.nodes.length === 0
      || panel.relations !== undefined && !Array.isArray(panel.relations)) return undefined;
    const nodes: WhiteboardDiagramNode[] = [];
    for (const value of panel.nodes) {
      const node = record(value);
      const key = claim(node?.key);
      const label = text(node?.label);
      if (!node || !key || !label || node.icon !== undefined && !ICONS.includes(node.icon as WhiteboardDiagramIcon)
        || node?.role !== undefined && !ROLES.includes(String(node.role))
        || node?.lines !== undefined && !Array.isArray(node.lines)) return undefined;
      const lines: NonNullable<WhiteboardDiagramNode['lines']> = [];
      for (const value of Array.isArray(node.lines) ? node.lines : []) {
        const line = record(value);
        const key = claim(line?.key);
        const content = text(line?.text);
        if (!key || !content) return undefined;
        lines.push({ key, text: content });
      }
      nodes.push({ key, label, ...(lines.length ? { lines } : {}),
        ...(node.icon ? { icon: node.icon as WhiteboardDiagramIcon } : {}),
        ...(node.role ? { role: node.role as NonNullable<WhiteboardDiagramNode['role']> } : {}) });
    }
    const nodeKeys = new Set(nodes.map((node) => node.key));
    const relations: WhiteboardDiagramRelation[] = [];
    for (const value of Array.isArray(panel.relations) ? panel.relations : []) {
      const relation = record(value);
      const key = claim(relation?.key);
      const from = text(relation?.from);
      const to = text(relation?.to);
      if (!key || !from || !to || from === to || !nodeKeys.has(from) || !nodeKeys.has(to)
        || !RELATIONS.includes(String(relation?.kind))) return undefined;
      relations.push({ key, from, to, kind: relation!.kind as WhiteboardDiagramRelation['kind'] });
    }
    panels.push({ key, ...(title ? { title } : {}), kind: panel.kind as WhiteboardDiagramPanel['kind'], nodes,
      ...(relations.length ? { relations } : {}) });
  }
  return { panels };
}

export const normalizeWhiteboardDiagram = parseWhiteboardDiagram;

export function whiteboardDiagramKeyEntries(diagram: WhiteboardDiagram): WhiteboardDiagramKeyEntry[] {
  return diagram.panels.flatMap((panel) => [
    ...panel.nodes.flatMap((node): WhiteboardDiagramKeyEntry[] => [
      { key: node.key, kind: 'node', panelKey: panel.key, text: node.label },
      ...(node.lines ?? []).map((line): WhiteboardDiagramKeyEntry => ({
        key: line.key, kind: 'line', panelKey: panel.key, parentKey: node.key, text: line.text,
      })),
    ]),
    ...(panel.relations ?? []).map((relation): WhiteboardDiagramKeyEntry => ({ key: relation.key, kind: 'relation', panelKey: panel.key })),
  ]);
}

export function whiteboardDiagramElementId(id: string, key: string): string {
  return `${id}:diagram:${encodeURIComponent(key)}`;
}

type Primitive = WbDrawTextAction | WbDrawImageAction | WbDrawLineAction;
type KeyLayout = { entry: WhiteboardDiagramKeyEntry; draws: Primitive[]; label?: WbDrawTextAction };
type PanelLayout = {
  panel: WhiteboardDiagramPanel;
  height: number;
  items: Map<string, KeyLayout>;
  title?: WbDrawTextAction;
  /** Already-taught hub context, reprojected when a continuation is needed. */
  contextKeys?: Set<string>;
};
type BoardLayout = { index: number; panels: PanelLayout[]; height: number };

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br/>');
}

function naturalWidth(value: string, fontSize = TEXT_SIZE): number {
  return [...value].reduce((sum, character) => sum + fontSize * (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.6), 0) + 20;
}

function drawing(id: string, value: string, x: number, y: number, width: number, fontSize = TEXT_SIZE, center = false): WbDrawTextAction {
  const action: WbDrawTextAction = {
    id, type: 'wb_draw_text', elementId: id, content: `<p${center ? ' style="text-align:center"' : ''}>${escapeHtml(value)}</p>`,
    x, y, width, height: 0, fontSize, color: INK,
  };
  action.height = minimumWhiteboardTextHeight(action, width);
  return action;
}

function svg(id: string, body: string, x: number, y: number, width: number, height: number, color = INK, viewWidth = width, viewHeight = height): WbDrawImageAction {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return { id, type: 'wb_draw_image', elementId: id, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, x, y, width, height };
}

function icon(id: string, name: WhiteboardDiagramIcon, x: number, y: number): WbDrawImageAction {
  const paths: Record<WhiteboardDiagramIcon, string> = {
    person: '<circle cx="20" cy="9" r="6"/><path d="M9 34v-7c0-10 22-10 22 0v7M20 20v14"/>',
    book: '<path d="M20 10C13 5 8 6 3 7v25c7-1 11-1 17 3 6-4 10-4 17-3V7c-5-1-10-2-17 3v25M8 14l7 1m-7 6 7 1m10-7 7-1m-7 8 7-1"/>',
    target: '<circle cx="20" cy="20" r="16"/><circle cx="20" cy="20" r="10"/><circle cx="20" cy="20" r="3"/><path d="m21 19 15-15m-7 0h7v7"/>',
    body: '<circle cx="20" cy="7" r="5"/><path d="M20 14v13M5 17l15 4 15-4M20 27l-9 10m9-10 9 10"/>',
    environment: '<path d="m4 19 16-13 16 13M9 17v19h22V17M17 36V25h7v11"/><path d="M2 7h5m-2-3v6m27-6 3 3m-1 7h4"/>',
    group: '<circle cx="20" cy="9" r="5"/><circle cx="7" cy="15" r="4"/><circle cx="33" cy="15" r="4"/><path d="M11 35v-8c0-10 18-10 18 0v8M2 34v-7c0-5 5-7 9-5m18 0c4-2 9 0 9 5v7"/>',
    task: '<path d="M13 6H7v31h26V6h-6M14 3h12v7H14zM13 19h14m-14 8h9"/><path d="m26 28 3 3 6-7"/>',
    strategy: '<path d="M20 36V20M20 23C20 14 7 20 7 8m13 15c0-9 13-3 13-15M3 12l4-5 4 5m18 0 4-5 4 5M20 20V4m-4 5 4-5 4 5"/>',
    check: '<path d="M34 17c4 17-20 25-29 10C-2 12 17-2 29 6m-18 14 7 7L36 6"/>',
  };
  return svg(id, paths[name], x, y, 36, 36, INK, 40, 40);
}

function bracket(id: string, x: number, y: number, height: number): WbDrawImageAction {
  return svg(id, `<path d="M10 2C3 2 5 8 5 ${height / 2 - 5}L1 ${height / 2}l4 5C5 ${height - 8} 3 ${height - 2} 10 ${height - 2}"/>`, x, y, 12, height);
}

function flowLines(id: string, node: WhiteboardDiagramNode, x: number, y: number, width: number, items: Map<string, KeyLayout>): number {
  const lines = node.lines ?? [];
  if (!lines.length) return 0;
  let cursorX = x;
  let cursorY = y;
  let rowHeight = 0;
  for (const line of lines) {
    const lineWidth = Math.min(width, Math.max(110, naturalWidth(line.text)));
    if (cursorX > x && cursorX + lineWidth > x + width + 0.01) {
      cursorX = x;
      cursorY += rowHeight + 8;
      rowHeight = 0;
    }
    const action = drawing(whiteboardDiagramElementId(id, line.key), line.text, cursorX, cursorY, lineWidth);
    items.set(line.key, { entry: { key: line.key, kind: 'line', panelKey: '', parentKey: node.key, text: line.text }, draws: [action], label: action });
    cursorX += lineWidth + 12;
    rowHeight = Math.max(rowHeight, action.height!);
  }
  const height = cursorY - y + rowHeight;
  if (lines.length > 1) items.get(lines[0].key)!.draws.unshift(bracket(`${whiteboardDiagramElementId(id, node.key)}:bracket`, x - 15, y + 4, height - 8));
  return height;
}

function nodeCard(id: string, node: WhiteboardDiagramNode, x: number, y: number, width: number, items: Map<string, KeyLayout>, iconPosition: 'left' | 'right' | 'above' = 'left', reserveIconBand = false): number {
  const hasIcon = Boolean(node.icon);
  const above = (hasIcon || reserveIconBand) && iconPosition === 'above' ? 40 : 0;
  const side = hasIcon && iconPosition !== 'above' ? 44 : 0;
  const label = drawing(whiteboardDiagramElementId(id, node.key), node.label,
    x + (hasIcon && iconPosition === 'left' ? side : 0), y + above, width - side, LABEL_SIZE, iconPosition === 'above');
  const draws: Primitive[] = [label];
  if (node.icon) draws.unshift(icon(`${label.elementId}:icon`, node.icon,
    iconPosition === 'above' ? x + (width - 36) / 2 : iconPosition === 'right' ? x + width - 36 : x,
    y + (iconPosition === 'above' ? 0 : 10)));
  items.set(node.key, { entry: { key: node.key, kind: 'node', panelKey: '', text: node.label }, draws, label });
  // Keep a full pen-mark lane between the editable label and its details.
  const bracketSpace = (node.lines?.length ?? 0) > 1 ? 15 : 0;
  const detailHeight = flowLines(id, node, x + bracketSpace, label.y + label.height! + 12, width - bracketSpace, items);
  return above + label.height! + (detailHeight ? 12 + detailHeight : 0);
}

function nodeRow(id: string, node: WhiteboardDiagramNode, x: number, y: number, width: number, items: Map<string, KeyLayout>, labelWidth = 216, iconRight = false): number {
  const side = node.icon ? 44 : 0;
  const label = drawing(whiteboardDiagramElementId(id, node.key), node.label,
    x + (node.icon && !iconRight ? side : 0), y, labelWidth - side, LABEL_SIZE);
  const draws: Primitive[] = [label];
  if (node.icon) draws.unshift(icon(`${label.elementId}:icon`, node.icon, iconRight ? x + labelWidth - 36 : x, y + 10));
  items.set(node.key, { entry: { key: node.key, kind: 'node', panelKey: '', text: node.label }, draws, label });
  const detailHeight = flowLines(id, node, x + labelWidth + 28, y, width - labelWidth - 28, items);
  return Math.max(label.height!, detailHeight);
}

function connectedRows(panel: WhiteboardDiagramPanel): WhiteboardDiagramNode[][] {
  const remaining = new Set(panel.nodes.map((node) => node.key));
  const rows: WhiteboardDiagramNode[][] = [];
  for (const first of panel.nodes) {
    if (!remaining.has(first.key)) continue;
    const keys = new Set([first.key]);
    for (let changed = true; changed;) {
      changed = false;
      for (const relation of panel.relations ?? []) {
        if (!['sequence', 'association'].includes(relation.kind) || !keys.has(relation.from) && !keys.has(relation.to)) continue;
        for (const key of [relation.from, relation.to]) if (!keys.has(key)) { keys.add(key); changed = true; }
      }
    }
    const nodes = panel.nodes.filter((node) => keys.has(node.key));
    // Follow an explicit sequence rather than rearranging pedagogical order by
    // arbitrary key sorting. Association-only rows keep the supplied order.
    const sequences = (panel.relations ?? []).filter((relation) => relation.kind === 'sequence' && keys.has(relation.from) && keys.has(relation.to));
    const ordered: WhiteboardDiagramNode[] = [];
    let next = sequences.length ? nodes.find((node) => !sequences.some((relation) => relation.to === node.key)) : undefined;
    while (next && !ordered.includes(next)) {
      ordered.push(next);
      const successor = sequences.find((relation) => relation.from === next!.key)?.to;
      next = nodes.find((node) => node.key === successor);
    }
    rows.push([...ordered, ...nodes.filter((node) => !ordered.includes(node))]);
    nodes.forEach((node) => remaining.delete(node.key));
  }
  return rows;
}

function layoutBranches(id: string, panel: WhiteboardDiagramPanel, start: number, items: Map<string, KeyLayout>): number {
  const focus = panel.nodes.find((node) => node.role === 'focus');
  if (focus && panel.nodes.length > 1) {
    const children = panel.nodes.filter((node) => node !== focus);
    let cursor = start;
    for (const node of children) cursor += nodeRow(id, node, 280, cursor, PANEL_WIDTH - 280, items, 200, true) + ROW_GAP;
    const childHeight = cursor - start - ROW_GAP;
    const temporary = new Map<string, KeyLayout>();
    const focusHeight = nodeCard(id, focus, 0, 0, 194, temporary);
    nodeCard(id, focus, 0, start + Math.max(0, (childHeight - focusHeight) / 2), 194, items);
    return start + Math.max(childHeight, focusHeight);
  }
  let cursor = start;
  for (const nodes of connectedRows(panel)) {
    let height = 0;
    if (nodes.length === 1) height = nodeRow(id, nodes[0], 0, cursor, PANEL_WIDTH, items);
    else {
      const width = (PANEL_WIDTH - (nodes.length - 1) * 44) / nodes.length;
      nodes.forEach((node, index) => {
        height = Math.max(height, nodeCard(id, node, index * (width + 44), cursor, width, items, 'above', nodes.some((entry) => entry.icon)));
      });
    }
    cursor += height + ROW_GAP;
  }
  return cursor - ROW_GAP;
}

function layoutConverge(id: string, panel: WhiteboardDiagramPanel, start: number, items: Map<string, KeyLayout>, issues: string[]): number {
  const focus = panel.nodes.find((node) => node.role === 'focus');
  const sources = panel.nodes.filter((node) => node !== focus && node.role !== 'result');
  const results = panel.nodes.filter((node) => node.role === 'result');
  if (!focus || panel.nodes.filter((node) => node.role === 'focus').length !== 1 || !sources.length) {
    issues.push(`图示 ${panel.key} 的汇聚图需要一个中心和至少一个依据；已保留全部内容并采用分支布局。`);
    return layoutBranches(id, { ...panel, nodes: panel.nodes.map((node) => ({ ...node, role: undefined })) }, start, items);
  }
  const sourceWidth = results.length ? 360 : 400;
  const focusWidth = results.length ? 220 : 320;
  const resultWidth = results.length ? 220 : 0;
  const gap = (PANEL_WIDTH - sourceWidth - focusWidth - resultWidth) / (results.length ? 2 : 1);
  const focusX = sourceWidth + gap;
  const resultX = focusX + focusWidth + gap;
  let sourceHeight = 0;
  for (const source of sources) sourceHeight += nodeCard(id, source, 0, start + sourceHeight, sourceWidth, items) + 18;
  sourceHeight -= 18;
  const measure = new Map<string, KeyLayout>();
  const focusHeight = nodeCard(id, focus, focusX, 0, focusWidth, measure, 'above');
  const resultHeights = results.map((node) => nodeCard(id, node, resultX, 0, resultWidth, new Map(), 'right'));
  const resultHeight = resultHeights.reduce((sum, height) => sum + height, 0) + 40 * Math.max(0, results.length - 1);
  const height = Math.max(sourceHeight, focusHeight, resultHeight);
  nodeCard(id, focus, focusX, start + (height - focusHeight) / 2, focusWidth, items, 'above');
  let resultY = start + (height - resultHeight) / 2;
  results.forEach((node, index) => {
    nodeCard(id, node, resultX, resultY, resultWidth, items, 'right');
    resultY += resultHeights[index] + 40;
  });
  return start + height;
}

function layoutMatrix(id: string, panel: WhiteboardDiagramPanel, start: number, items: Map<string, KeyLayout>): number {
  const focus = panel.nodes.find((node) => node.role === 'focus');
  let cursor = start;
  if (focus) cursor += nodeRow(id, focus, 0, cursor, PANEL_WIDTH, items, 244) + 18;
  const rows = panel.nodes.filter((node) => node !== focus);
  for (const node of rows) {
    const height = nodeRow(id, node, 0, cursor, PANEL_WIDTH, items, 216);
    const key = whiteboardDiagramElementId(id, node.key);
    const boundary: WbDrawLineAction = { id: `${key}:row-rule`, elementId: `${key}:row-rule`, type: 'wb_draw_line',
      startX: 0, startY: cursor - 7, endX: PANEL_WIDTH, endY: cursor - 7, color: '#94a3b8', width: 1.5, points: ['', ''] };
    items.get(node.key)!.draws.unshift(boundary);
    cursor += height + ROW_GAP;
  }
  return cursor - (rows.length ? ROW_GAP : 0);
}

function translate(draw: Primitive, dx: number, dy: number): Primitive {
  if (draw.type === 'wb_draw_line') return { ...draw, startX: draw.startX + dx, endX: draw.endX + dx, startY: draw.startY + dy, endY: draw.endY + dy };
  return { ...draw, x: draw.x + dx, y: draw.y + dy };
}

function layoutPanel(id: string, panel: WhiteboardDiagramPanel, issues: string[]): PanelLayout {
  const items = new Map<string, KeyLayout>();
  const title = panel.title ? drawing(`${id}:panel:${encodeURIComponent(panel.key)}:title`, panel.title, 0, 0, PANEL_WIDTH, TEXT_SIZE) : undefined;
  const start = title ? title.height! + 4 : 0;
  const bottom = panel.kind === 'converge' ? layoutConverge(id, panel, start, items, issues)
    : panel.kind === 'matrix' ? layoutMatrix(id, panel, start, items) : layoutBranches(id, panel, start, items);
  for (const item of items.values()) item.entry.panelKey = panel.key;
  for (const relation of panel.relations ?? []) {
    const from = items.get(relation.from)?.label;
    const to = items.get(relation.to)?.label;
    if (!from || !to) { issues.push(`图示关系 ${relation.key} 引用了不存在的知识节点。`); continue; }
    const horizontal = Math.abs(from.x - to.x) > Math.abs(from.y - to.y);
    const forward = horizontal ? from.x < to.x : from.y < to.y;
    const startSide = horizontal ? forward ? 'right' : 'left' : forward ? 'bottom' : 'top';
    const endSide = horizontal ? forward ? 'left' : 'right' : forward ? 'top' : 'bottom';
    const point = (box: WbDrawTextAction, side: typeof startSide) => ({
      x: box.x + (side === 'right' ? box.width! : side === 'left' ? 0 : box.width! / 2),
      y: box.y + (side === 'bottom' ? box.height! : side === 'top' ? 0 : box.height! / 2),
    });
    const source = point(from, startSide);
    const target = point(to, endSide);
    const key = whiteboardDiagramElementId(id, relation.key);
    const action: WbDrawLineAction = { id: key, elementId: key, type: 'wb_draw_line',
      startX: source.x, startY: source.y, endX: target.x, endY: target.y,
      startAnchor: { elementId: from.elementId!, side: startSide }, endAnchor: { elementId: to.elementId!, side: endSide },
      color: INK, width: 2.6, points: ['', ['supports', 'sequence'].includes(relation.kind) ? 'arrow' : ''] };
    items.set(relation.key, { entry: { key: relation.key, kind: 'relation', panelKey: panel.key }, draws: [action] });
  }
  return { panel, items, ...(title ? { title } : {}), height: bottom + 8 };
}

/** On an otherwise indivisible continuation, reuse empty space above its hub
 * for the panel heading instead of reserving a whole-width heading row. */
function placeContinuationTitleAboveHub(layout: PanelLayout, focus: WhiteboardDiagramNode, capacity: number): PanelLayout {
  if (!layout.title || layout.height <= capacity) return layout;
  const offset = layout.title.height! + 4;
  if (layout.height - offset > capacity) return layout;
  const title = { ...layout.title, x: 0, y: 0, width: 194 };
  title.height = minimumWhiteboardTextHeight(title, title.width);
  const focusKeys = [focus.key, ...(focus.lines ?? []).map((line) => line.key)];
  const focusTop = Math.min(...focusKeys.flatMap((key) => layout.items.get(key)?.draws
    .flatMap((draw) => draw.type === 'wb_draw_line' ? [] : [draw.y - offset]) ?? []));
  if (!Number.isFinite(focusTop) || title.height + ROW_GAP > focusTop) return layout;
  const items = new Map([...layout.items].map(([key, item]) => {
    const draws = item.draws.map((draw) => translate(draw, 0, -offset));
    return [key, { ...item, draws,
      ...(item.label ? { label: draws.find((draw): draw is WbDrawTextAction => draw.type === 'wb_draw_text')! } : {}) }] as const;
  }));
  return { ...layout, title, items, height: layout.height - offset };
}

/** Split only independent hub branches, retaining each complete child row.
 * A chain, cycle, or relationship between children is never cut to fit a board.
 * Existing layouts that already fit remain byte-for-byte unchanged. */
function continueHubBranches(id: string, layout: PanelLayout, capacity: number, issues: string[]): PanelLayout[] {
  const { panel } = layout;
  if (layout.height <= capacity || panel.kind !== 'branches') return [layout];
  const focuses = panel.nodes.filter((node) => node.role === 'focus');
  if (focuses.length !== 1) return [layout];
  const focus = focuses[0];
  const children = panel.nodes.filter((node) => node !== focus);
  if (children.length < 2 || (panel.relations ?? []).some((relation) => relation.from !== focus.key && relation.to !== focus.key)) return [layout];
  const titleHeight = layout.title ? layout.title.height! + 4 : 0;
  const available = capacity - titleHeight - 8;
  const focusHeight = nodeCard(id, focus, 0, 0, 194, new Map());
  const heights = children.map((node) => nodeRow(id, node, 280, 0, PANEL_WIDTH - 280, new Map(), 200, true));
  // An oversized hub cannot be repaired by repeating it. An oversized child
  // remains intact on its own board, retaining the real capacity diagnostic.
  if (focusHeight > available) return [layout];
  const chunks: WhiteboardDiagramNode[][] = [];
  let chunk: WhiteboardDiagramNode[] = [];
  let height = 0;
  children.forEach((child, index) => {
    if (chunk.length && height + ROW_GAP + heights[index] > available) {
      chunks.push(chunk);
      chunk = [];
      height = 0;
    }
    height += (chunk.length ? ROW_GAP : 0) + heights[index];
    chunk.push(child);
  });
  if (chunk.length) chunks.push(chunk);
  const focusKeys = new Set([focus.key, ...(focus.lines ?? []).map((line) => line.key)]);
  return chunks.map((children, index) => {
    const nodeKeys = new Set([focus.key, ...children.map((child) => child.key)]);
    const measured = layoutPanel(id, { ...panel, nodes: [focus, ...children],
      relations: panel.relations?.filter((relation) => nodeKeys.has(relation.from) && nodeKeys.has(relation.to)) }, issues);
    const continuation = children.length === 1 ? placeContinuationTitleAboveHub(measured, focus, capacity) : measured;
    return { ...continuation, ...(index ? { contextKeys: focusKeys } : {}) };
  });
}

/** A complete semantic diagram is laid out before any of its objects appear.
 * Text remains native/editable; SVGs contain only deterministic pen strokes. */
export function compileWhiteboardDiagram(input: {
  id: string;
  title: string;
  diagram: WhiteboardDiagram;
  steps: WhiteboardDiagramStep[];
  exit: WhiteboardDiagramBinding;
}): { actions: BoundWhiteboardDiagramAction[]; issues: string[]; visibleTextByKey: Record<string, string> } {
  const issues: string[] = [];
  const actions: BoundWhiteboardDiagramAction[] = [];
  const visibleTextByKey = Object.fromEntries(whiteboardDiagramKeyEntries(input.diagram)
    .filter((entry) => entry.text !== undefined).map((entry) => [entry.key, entry.text!]));
  if (!parseWhiteboardDiagram(input.diagram)) return { actions, issues: ['白板图示包含无效结构、重复标识或不存在的关系端点。'], visibleTextByKey };
  const heading = drawing(`${input.id}:title`, input.title, MARGIN, 24, PANEL_WIDTH, 30);
  const contentTop = heading.y + heading.height! + 13;
  const capacity = WHITEBOARD_HEIGHT - MARGIN - contentTop;
  const panels = input.diagram.panels.flatMap((panel) => continueHubBranches(input.id,
    layoutPanel(input.id, panel, issues), capacity, issues));
  const boards: BoardLayout[] = [];
  for (const panel of panels) {
    if (panel.height > capacity) issues.push(`图示 ${panel.panel.key} 在 24px 字号下超出单板容量；完整内容已保留，请按完整子图拆板。`);
    let board = boards.at(-1);
    if (!board || board.height + PANEL_GAP + panel.height > capacity) {
      board = { index: boards.length + 1, panels: [], height: 0 };
      boards.push(board);
    }
    const offsetY = contentTop + (board.panels.length ? board.height + PANEL_GAP : 0);
    for (const item of panel.items.values()) {
      item.draws = item.draws.map((draw) => translate(draw, MARGIN, offsetY));
      if (item.label) item.label = item.draws.find((draw): draw is WbDrawTextAction => draw.type === 'wb_draw_text')!;
    }
    if (panel.title) panel.title = translate(panel.title, MARGIN, offsetY) as WbDrawTextAction;
    board.height += (board.panels.length ? PANEL_GAP : 0) + panel.height;
    board.panels.push(panel);
  }
  const all = new Map<string, KeyLayout>();
  const boardFor = new Map<string, BoardLayout>();
  for (const board of boards) for (const panel of board.panels) for (const [key, item] of panel.items) {
    // The first authored occurrence retains its original speech binding. Later
    // copies are context only and never create a premature semantic reveal.
    if (!all.has(key)) { all.set(key, item); boardFor.set(key, board); }
  }
  const relationFor = new Map(input.diagram.panels.flatMap((panel) => (panel.relations ?? []).map((relation) => [relation.key, relation] as const)));
  const requested = new Set<string>();
  const visible = new Set<string>();
  const drawn = new Set<string>();
  const shownPanelTitles = new Set<string>();
  const emphasized = new Set<string>();
  let currentBoard: BoardLayout | undefined;
  let serial = 0;
  const add = (action: Action, binding: WhiteboardDiagramBinding, exactId?: string) => {
    serial += 1;
    actions.push({ ...action, id: exactId ?? `${action.id}:action-${String(serial).padStart(4, '0')}`, ...binding });
  };
  const dependenciesVisible = (key: string) => {
    const item = all.get(key)!;
    if (item.entry.parentKey && !visible.has(item.entry.parentKey)) return false;
    const relation = relationFor.get(key);
    return !relation || visible.has(relation.from) && visible.has(relation.to);
  };
  const showBoard = (board: BoardLayout, binding: WhiteboardDiagramBinding) => {
    if (currentBoard?.index === board.index) return;
    if (!currentBoard) add({ id: `${input.id}:open`, type: 'wb_open' }, binding, `${input.id}:open`);
    add({ id: `${input.id}:board-${board.index}:clear`, type: 'wb_clear' }, binding);
    add({ ...heading, groupId: `${input.id}:board-${board.index}` }, binding);
    currentBoard = board;
    drawn.clear();
    shownPanelTitles.clear();
    emphasized.clear();
  };
  const currentItem = (key: string) => currentBoard?.panels.find((panel) => panel.items.has(key))?.items.get(key) ?? all.get(key)!;
  const renderPending = (binding: WhiteboardDiagramBinding) => {
    if (!currentBoard) return;
    const groupId = `${input.id}:board-${currentBoard.index}`;
    for (const kind of ['node', 'line', 'relation']) {
      for (const [key] of all) {
        const panel = currentBoard.panels.find((panel) => panel.items.has(key));
        const item = panel?.items.get(key);
        if (!panel || !item || item.entry.kind !== kind || !requested.has(key) || drawn.has(key)
          || !dependenciesVisible(key)) continue;
        if (panel.title && !shownPanelTitles.has(panel.panel.key)) {
          add({ ...panel.title, groupId }, binding);
          shownPanelTitles.add(panel.panel.key);
        }
        item.draws.forEach((draw) => add({ ...draw, groupId }, binding));
        drawn.add(key);
        visible.add(key);
      }
    }
  };
  const removeEmphasis = (key: string, binding: WhiteboardDiagramBinding) => {
    const item = currentItem(key);
    const relation = item.draws.find((draw): draw is WbDrawLineAction => draw.type === 'wb_draw_line' && draw.elementId === whiteboardDiagramElementId(input.id, key));
    if (relation) add({ ...relation, groupId: `${input.id}:board-${currentBoard!.index}` }, binding);
    else add({ id: `${whiteboardDiagramElementId(input.id, key)}:unfocus`, type: 'wb_delete', elementId: `${whiteboardDiagramElementId(input.id, key)}:emphasis` }, binding);
    emphasized.delete(key);
  };
  for (const [index, step] of input.steps.entries()) {
    const keys = [...new Set(step.reveal)];
    for (const key of keys) if (!all.has(key)) issues.push(`白板第 ${index + 1} 步引用了未知对象 ${key}。`);
    const childTargets = [...new Set(keys.flatMap((key) => {
      const target = boardFor.get(key);
      const repeatedContext = panels.some((panel) => panel.contextKeys?.has(key));
      return target && !repeatedContext ? [target] : [];
    }))];
    const targetFor = (key: string) => {
      const contextual = childTargets.length === 1 ? childTargets[0] : currentBoard;
      return contextual?.panels.some((panel) => panel.contextKeys?.has(key)) ? contextual : boardFor.get(key);
    };
    const targets = [...new Set(keys.flatMap((key) => targetFor(key) ? [targetFor(key)!] : []))];
    if (targets.length > 1) issues.push(`白板第 ${index + 1} 步同时显示不同板面的内容，请拆为独立讲解步骤。`);
    for (const board of targets) {
      showBoard(board, step);
      for (const key of keys) if (targetFor(key)?.index === board.index) requested.add(key);
      for (const key of keys) {
        const item = all.get(key);
        const parent = item?.entry.parentKey;
        const relation = relationFor.get(key);
        if (parent && !requested.has(parent)) issues.push(`白板对象 ${key} 在所属节点 ${parent} 出现前被请求，已等待节点显示。`);
        if (relation && (!requested.has(relation.from) || !requested.has(relation.to))) issues.push(`白板关系 ${key} 在两端节点显示前被请求，已等待端点显示。`);
      }
      renderPending(step);
    }
    const focusKeys = [...new Set(step.emphasize ?? keys.filter((key) => all.get(key)?.entry.kind !== 'relation'))];
    for (const key of [...emphasized]) if (!focusKeys.includes(key)) removeEmphasis(key, step);
    for (const key of focusKeys) {
      if (!all.has(key) || !drawn.has(key)) { issues.push(`白板第 ${index + 1} 步强调的对象 ${key} 尚未显示在当前板面。`); continue; }
      if (emphasized.has(key)) continue;
      const item = currentItem(key);
      const relation = item.draws.find((draw): draw is WbDrawLineAction => draw.type === 'wb_draw_line' && draw.elementId === whiteboardDiagramElementId(input.id, key));
      const groupId = `${input.id}:board-${currentBoard!.index}`;
      if (relation) add({ ...relation, color: ACCENT, width: 3.4, groupId }, step);
      else if (item.label) {
        const label = item.label;
        const width = Math.max(20, Math.min(label.width! - 20, naturalWidth(item.entry.text!, label.fontSize!) - 20));
        // Native text has symmetric 10px padding, then paragraph alignment is
        // applied within the remaining width. A centered card label can be
        // much narrower than its reserved column; its pen mark must share the
        // text's center rather than the column's left padding.
        const centered = /text-align\s*:\s*center\b/i.test(label.content);
        const underlineX = centered ? label.x + (label.width! - width) / 2 : label.x + 10;
        const underline = svg(`${whiteboardDiagramElementId(input.id, key)}:emphasis`,
          `<path d="M2 3Q${width * 0.4} 1 ${width - 2} 3M${width * 0.12} 6Q${width * 0.6} 4 ${width * 0.9} 5"/>`,
          underlineX, label.y + label.height! + 1, width, 7, ACCENT);
        add({ ...underline, groupId }, step);
      }
      emphasized.add(key);
    }
  }
  for (const key of all.keys()) if (!visible.has(key)) issues.push(`白板对象 ${key} 没有有效显示步骤；原有完整结构已保留。`);
  if (currentBoard) add({ id: `${input.id}:close`, type: 'wb_close' }, input.exit);
  return { actions, issues: [...new Set(issues)], visibleTextByKey };
}
