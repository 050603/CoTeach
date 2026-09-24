import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import type { DiagramPlan } from './outline-types.js';
import { TextLayoutError } from './text-layout-compiler.js';

/** A planned relationship with a slide-local container chosen during first-pass authoring. */
export interface DiagramComponent extends DiagramPlan {
  type: 'diagram';
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  accentColor?: string;
  nodeFill?: string;
  textColor?: string;
}

export interface DiagramCompilerOptions {
  fontName?: string;
  /** Host-provided font measurement; the package does not depend on a browser. */
  measureText?: (text: string, fontSize: number, fontName: string, fontWeight: number) => number;
  canvasWidth?: number;
  canvasHeight?: number;
}

interface Point { x: number; y: number }
interface Rect { left: number; top: number; width: number; height: number }
interface PositionedNode { id: string; label: string; rect: Rect; lines: string[] }
interface DirectedEdge { from: string; to: string; label?: string; feedback: boolean }

const NODE_FONT_SIZE = 20;
const ANNOTATION_FONT_SIZE = 18;
const EDGE_FONT_SIZE = 16;
const NODE_PADDING_X = 15;
const NODE_PADDING_Y = 12;
const NODE_LINE_HEIGHT = 25;
const NODE_MIN_WIDTH = 104;
const NODE_MAX_WIDTH = 174;
const NODE_MARGIN = 18;
const SHAPE_PATH = 'M 12 0 H 88 Q 100 0 100 12 V 88 Q 100 100 88 100 H 12 Q 0 100 0 88 V 12 Q 0 0 12 0 Z';

export function isDiagramComponent(value: unknown): value is DiagramComponent {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'diagram';
}

function fail(message: string): never {
  throw new Error(`Invalid diagram component: ${message}`);
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fallbackMeasure(text: string, fontSize: number): number {
  return Array.from(text).reduce((width, char) => {
    if (/\s/u.test(char)) return width + fontSize * 0.32;
    if (/[\u2E80-\u9FFF\uF900-\uFAFF]/u.test(char)) return width + fontSize * 1.12;
    if (/[A-Z0-9]/u.test(char)) return width + fontSize * 0.76;
    if (/[a-z]/u.test(char)) return width + fontSize * 0.66;
    return width + fontSize * 0.75;
  }, 0);
}

function measure(text: string, size: number, options: DiagramCompilerOptions, weight = 600): number {
  const result = options.measureText?.(text, size, options.fontName ?? 'Noto Sans SC', weight)
    ?? fallbackMeasure(text, size);
  if (!Number.isFinite(result) || result < 0) fail('text measurement returned an invalid width');
  return result;
}

function wrapLabel(label: string, maxWidth: number, options: DiagramCompilerOptions): string[] {
  const explicit = label.split('\n').map((line) => line.trim());
  if (explicit.some((line) => !line) || explicit.length > 2) fail(`node label ${JSON.stringify(label)} cannot fit in two lines`);
  if (explicit.length === 2) {
    if (explicit.some((line) => measure(line, NODE_FONT_SIZE, options) > maxWidth)) fail(`node label ${JSON.stringify(label)} exceeds its node`);
    if (Array.from(explicit[1]!).length === 1 && Array.from(label.replace(/\n/g, '')).length > 2) fail(`node label ${JSON.stringify(label)} leaves an orphan character`);
    return explicit;
  }
  if (measure(label, NODE_FONT_SIZE, options) <= maxWidth) return [label];

  const chars = Array.from(label);
  let best: { lines: [string, string]; score: number } | undefined;
  for (let split = 2; split <= chars.length - 2; split += 1) {
    // Keep Latin words and numbers intact; Chinese labels can split at a balanced character boundary.
    if (/[A-Za-z0-9]/u.test(chars[split - 1]!) && /[A-Za-z0-9]/u.test(chars[split]!)) continue;
    const first = chars.slice(0, split).join('').trim();
    const second = chars.slice(split).join('').trim();
    if (!first || !second || /^[，。；：、,.!?！？）】]/u.test(second)) continue;
    const firstWidth = measure(first, NODE_FONT_SIZE, options);
    const secondWidth = measure(second, NODE_FONT_SIZE, options);
    if (firstWidth > maxWidth || secondWidth > maxWidth) continue;
    const score = Math.max(firstWidth, secondWidth) + Math.abs(firstWidth - secondWidth) * 0.35
      - (/\s|[，。；：、,.!?！？]$/u.test(first) ? 8 : 0);
    if (!best || score < best.score) best = { lines: [first, second], score };
  }
  if (!best) fail(`node label ${JSON.stringify(label)} cannot fit without clipping`);
  return best.lines;
}

function center(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function boundaryPoint(rect: Rect, toward: Point): Point {
  const middle = center(rect);
  const dx = toward.x - middle.x;
  const dy = toward.y - middle.y;
  const divisor = Math.max(Math.abs(dx) / (rect.width / 2), Math.abs(dy) / (rect.height / 2));
  if (divisor === 0) fail('an edge connects coincident nodes');
  return { x: middle.x + dx / divisor, y: middle.y + dy / divisor };
}

function overlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.left < b.left + b.width + gap && a.left + a.width + gap > b.left
    && a.top < b.top + b.height + gap && a.top + a.height + gap > b.top;
}

function within(rect: Rect, bounds: Rect): boolean {
  const tolerance = 0.001;
  return rect.left >= bounds.left - tolerance && rect.top >= bounds.top - tolerance
    && rect.left + rect.width <= bounds.left + bounds.width + tolerance
    && rect.top + rect.height <= bounds.top + bounds.height + tolerance;
}

function makeText(
  id: string,
  value: string,
  rect: Rect,
  fontSize: number,
  color: string,
  fontName: string,
  options: { weight?: number; fill?: string } = {},
): PPTTextElement {
  const lines = value.split('\n').map(escapeHtml).join('<br>');
  return {
    id, type: 'text', ...rect, rotate: 0, defaultFontName: fontName, defaultColor: color,
    content: `<p style="margin:0;text-align:center;font-family:${escapeHtml(fontName)};font-size:${fontSize}px;font-weight:${(options.weight ?? 500) >= 600 ? 700 : 400};line-height:1.2">${lines}</p>`,
    lineHeight: 1.2, paragraphSpace: 0, vAlign: 'middle',
    ...(options.fill ? { fill: options.fill } : {}),
  };
}

function makeNode(node: PositionedNode, component: DiagramComponent, fontName: string): PPTShapeElement {
  return {
    id: `${component.id}-node-${node.id}`, type: 'shape', ...node.rect, rotate: 0,
    viewBox: [100, 100], path: SHAPE_PATH, fixedRatio: false,
    fill: component.nodeFill ?? '#FFF4E8',
    outline: { color: component.accentColor ?? '#D97706', width: 2, style: 'solid' },
    text: {
      content: `<p style="margin:0;text-align:center;font-family:${escapeHtml(fontName)};font-size:${NODE_FONT_SIZE}px;font-weight:700;line-height:1.25">${node.lines.map(escapeHtml).join('<br>')}</p>`,
      defaultFontName: fontName,
      defaultColor: component.textColor ?? '#30343A',
      align: 'middle', lineHeight: 1.25, paragraphSpace: 0,
    },
  };
}

function makeLine(id: string, start: Point, end: Point, color: string, controls?: [Point, Point], feedback = false): PPTLineElement {
  const points = [start, end, ...(controls ?? [])];
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  return {
    id, type: 'line', left, top, width: 3, style: feedback ? 'dashed' : 'solid', color,
    start: [start.x - left, start.y - top], end: [end.x - left, end.y - top], points: ['', 'arrow'],
    ...(controls ? { cubic: controls.map((point) => [point.x - left, point.y - top]) as [[number, number], [number, number]] } : {}),
  };
}

function parseEdges(component: DiagramComponent): DirectedEdge[] {
  const nodes = component.nodes;
  if (!Array.isArray(nodes) || nodes.length < (component.topology === 'cycle' ? 3 : 2) || nodes.length > 12) {
    fail('the topology requires 2–12 sequence nodes or 3–12 cycle nodes');
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || typeof node.label !== 'string' || !node.label.trim()) fail('every node needs a nonempty id and label');
    if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  if (component.edges !== undefined && !Array.isArray(component.edges)) fail('edges must be an array');
  const supplied = new Map<string, string | undefined>();
  const extra: DirectedEdge[] = [];
  for (const edge of component.edges ?? []) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) fail('an edge references an unknown or identical node');
    if (edge.label !== undefined && (typeof edge.label !== 'string' || !edge.label.trim())) fail('edge labels must be nonempty strings');
    const key = `${edge.from}\u0000${edge.to}`;
    if (supplied.has(key)) fail('duplicate directed edge');
    supplied.set(key, edge.label);
  }
  const required: DirectedEdge[] = [];
  const count = component.topology === 'cycle' ? nodes.length : nodes.length - 1;
  for (let index = 0; index < count; index += 1) {
    const from = nodes[index]!.id;
    const to = nodes[(index + 1) % nodes.length]!.id;
    const key = `${from}\u0000${to}`;
    required.push({ from, to, label: supplied.get(key), feedback: false });
    supplied.delete(key);
  }
  for (const [key, label] of supplied) {
    const [from, to] = key.split('\u0000');
    if (component.topology === 'cycle') fail('a cycle may contain only its ordered ring edges');
    if (nodes.findIndex((node) => node.id === from) <= nodes.findIndex((node) => node.id === to)) fail('sequence cross-links must point backward as feedback');
    extra.push({ from: from!, to: to!, label, feedback: true });
  }
  if (extra.length > 1) fail('one sequence component may contain at most one feedback edge');
  return [...required, ...extra];
}

function nodeSize(component: DiagramComponent, options: DiagramCompilerOptions): { width: number; height: number; lines: string[][] } {
  const maxWidth = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, component.width * 0.24));
  const width = Math.min(maxWidth, Math.max(NODE_MIN_WIDTH, Math.max(...component.nodes.map((node) => measure(node.label.replace(/\n/g, ''), NODE_FONT_SIZE, options))) + NODE_PADDING_X * 2));
  const lines = component.nodes.map((node) => wrapLabel(node.label, width - NODE_PADDING_X * 2, options));
  const height = Math.max(...lines.map((parts) => parts.length)) * NODE_LINE_HEIGHT + NODE_PADDING_Y * 2;
  return { width, height, lines };
}

function positionCycle(component: DiagramComponent, options: DiagramCompilerOptions): PositionedNode[] {
  const size = nodeSize(component, options);
  const radiusX = component.width / 2 - size.width / 2 - NODE_MARGIN;
  const radiusY = component.height / 2 - size.height / 2 - NODE_MARGIN;
  if (radiusX <= 0 || radiusY <= 0) fail('cycle nodes do not fit inside the container');
  const middle = { x: component.left + component.width / 2, y: component.top + component.height / 2 };
  const positioned = component.nodes.map((node, index) => {
    const angle = -Math.PI / 2 + index * (2 * Math.PI / component.nodes.length);
    return {
      ...node, lines: size.lines[index]!,
      rect: {
        left: middle.x + radiusX * Math.cos(angle) - size.width / 2,
        top: middle.y + radiusY * Math.sin(angle) - size.height / 2,
        width: size.width, height: size.height,
      },
    };
  });
  for (let index = 0; index < positioned.length; index += 1) {
    for (let next = index + 1; next < positioned.length; next += 1) {
      if (overlap(positioned[index]!.rect, positioned[next]!.rect, 10)) fail('cycle nodes overlap; enlarge the diagram container');
    }
  }
  return positioned;
}

function edgeLabelWidth(label: string, options: DiagramCompilerOptions): number {
  return Math.max(52, measure(label, EDGE_FONT_SIZE, options, 500) + 24);
}

function positionSequence(component: DiagramComponent, options: DiagramCompilerOptions, edges: DirectedEdge[]): { nodes: PositionedNode[]; vertical: boolean } {
  const size = nodeSize(component, options);
  const feedback = edges.some((edge) => edge.feedback);
  const labels = component.nodes.slice(0, -1).map((node, index) => edges.find((edge) => !edge.feedback
    && edge.from === node.id && edge.to === component.nodes[index + 1]!.id)?.label);
  // Labels are part of the first-pass geometry, including their padding. A fixed
  // connector gap can reject even a three-character condition after rendering.
  for (const useVertical of [false, true]) {
    const main: Rect = {
      left: component.left + NODE_MARGIN,
      top: component.top + NODE_MARGIN,
      width: component.width - NODE_MARGIN * 2 - (useVertical && feedback ? 58 : 0),
      height: component.height - NODE_MARGIN * 2 - (!useVertical && feedback ? 58 : 0),
    };
    if (main.width < size.width || main.height < size.height) continue;
    const hasLabels = labels.some(Boolean);
    if (!useVertical && hasLabels && main.height < 80) continue;
    if (useVertical && labels.some((label) => label && edgeLabelWidth(label, options) > main.width)) continue;
    const gaps = labels.map((label) => label ? (useVertical ? 48 : edgeLabelWidth(label, options) + 8) : 24);
    const nodeExtent = useVertical ? size.height : size.width;
    const available = useVertical ? main.height : main.width;
    const minimum = component.nodes.length * nodeExtent + gaps.reduce((sum, gap) => sum + gap, 0);
    if (minimum > available) continue;
    const extra = Math.min(38, (available - minimum) / gaps.length);
    const total = minimum + extra * gaps.length;
    let cursor = (useVertical ? main.top : main.left) + (available - total) / 2;
    return {
      vertical: useVertical,
      nodes: component.nodes.map((node, index) => {
        const rect = {
          left: useVertical ? main.left + (main.width - size.width) / 2 : cursor,
          top: useVertical ? cursor : main.top + (main.height - size.height) / 2,
          width: size.width, height: size.height,
        };
        cursor += nodeExtent + (gaps[index] ?? 0) + extra;
        return { ...node, lines: size.lines[index]!, rect };
      }),
    };
  }
  fail('sequence nodes and edge labels do not fit inside the container');
}

function edgeLabel(id: string, label: string, at: Point, bounds: Rect, component: DiagramComponent, options: DiagramCompilerOptions): PPTTextElement {
  const availableWidth = 2 * Math.min(at.x - bounds.left, bounds.left + bounds.width - at.x);
  const width = Math.min(availableWidth, edgeLabelWidth(label, options));
  if (measure(label, EDGE_FONT_SIZE, options, 500) > width - 20) fail(`edge label ${JSON.stringify(label)} is too long`);
  const rect = { left: at.x - width / 2, top: at.y - 20, width, height: 40 };
  if (!within(rect, bounds)) fail('edge label exceeds the diagram container');
  return makeText(id, label, rect, EDGE_FONT_SIZE, component.textColor ?? '#30343A', options.fontName ?? 'Noto Sans SC', { fill: '#FFFFFF' });
}

function outsideAnnotation(component: DiagramComponent, options: DiagramCompilerOptions): PPTTextElement {
  if (typeof component.annotation !== 'string' || !component.annotation.trim()) fail('annotation must be a nonempty string');
  const width = component.width;
  const wrapped: string[] = [];
  for (const paragraph of component.annotation.trim().split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (line && measure(line + char, ANNOTATION_FONT_SIZE, options, 700) > width - 20) {
        wrapped.push(line);
        line = '';
      }
      line += char;
    }
    if (line) wrapped.push(line);
  }
  if (!wrapped.length) fail('annotation must contain visible text');
  if ([...wrapped.at(-1)!].length === 1 && wrapped.length > 1) {
    const previous = [...wrapped[wrapped.length - 2]!];
    if (previous.length > 2) {
      wrapped[wrapped.length - 1] = previous.pop()! + wrapped.at(-1)!;
      wrapped[wrapped.length - 2] = previous.join('');
    }
  }
  return makeText(`${component.id}-annotation`, wrapped.join('\n'), {
    left: component.left, top: component.top, width, height: wrapped.length * 23 + 20,
  }, ANNOTATION_FONT_SIZE, component.textColor ?? '#30343A', options.fontName ?? 'Noto Sans SC', { weight: 700 });
}

/** Compile one first-pass diagram into editable DSL shapes, text, and directed lines. */
export function compileDiagramComponent(component: DiagramComponent, options: DiagramCompilerOptions = {}): PPTElement[] {
  if (!isDiagramComponent(component) || typeof component.id !== 'string' || !component.id.trim()) fail('type must be diagram and id must be nonempty');
  if (component.topology !== 'sequence' && component.topology !== 'cycle') fail('topology must be sequence or cycle');
  if (![component.left, component.top].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || !finitePositive(component.width) || !finitePositive(component.height)) fail('container coordinates must be finite and positive');
  const bounds: Rect = { left: component.left, top: component.top, width: component.width, height: component.height };
  if (!within(bounds, { left: 50, top: 50, width: (options.canvasWidth ?? 1000) - 100, height: (options.canvasHeight ?? 562.5) - 100 })) fail('diagram container lies outside the safe slide area');
  if (component.annotation !== undefined) {
    const annotation = outsideAnnotation(component, options);
    const reserve = annotation.height + 12;
    const diagram = compileDiagramComponent({ ...component, annotation: undefined,
      top: component.top + reserve, height: component.height - reserve }, options);
    return [...diagram, annotation];
  }
  const edges = parseEdges(component);
  const position = component.topology === 'cycle'
    ? { nodes: positionCycle(component, options), vertical: false }
    : positionSequence(component, options, edges);
  const byId = new Map(position.nodes.map((node) => [node.id, node]));
  const lines: PPTLineElement[] = [];
  const labels: PPTTextElement[] = [];
  const color = component.accentColor ?? '#D97706';

  for (const [index, edge] of edges.entries()) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    let start: Point;
    let end: Point;
    let controls: [Point, Point] | undefined;
    let labelAt: Point;
    if (component.topology === 'cycle') {
      const fromIndex = component.nodes.findIndex((node) => node.id === edge.from);
      const step = 2 * Math.PI / component.nodes.length;
      const angle = -Math.PI / 2 + fromIndex * step;
      const middle = { x: component.left + component.width / 2, y: component.top + component.height / 2 };
      const radiusX = component.width / 2 - from.rect.width / 2 - NODE_MARGIN;
      const radiusY = component.height / 2 - from.rect.height / 2 - NODE_MARGIN;
      const atAngle = (value: number): Point => ({ x: middle.x + radiusX * Math.cos(value), y: middle.y + radiusY * Math.sin(value) });
      controls = [atAngle(angle + step / 3), atAngle(angle + step * 2 / 3)];
      start = boundaryPoint(from.rect, controls[0]);
      end = boundaryPoint(to.rect, controls[1]);
      const labelPoint = atAngle(angle + step / 2);
      const dx = labelPoint.x - middle.x;
      const dy = labelPoint.y - middle.y;
      const distance = Math.hypot(dx, dy) || 1;
      labelAt = { x: labelPoint.x + dx / distance * 22, y: labelPoint.y + dy / distance * 22 };
    } else if (edge.feedback) {
      if (position.vertical) {
        start = { x: from.rect.left + from.rect.width, y: center(from.rect).y };
        end = { x: to.rect.left + to.rect.width, y: center(to.rect).y };
        const side = component.left + component.width - 18;
        controls = [{ x: side, y: start.y }, { x: side, y: end.y }];
        labelAt = { x: side - 38, y: (start.y + end.y) / 2 };
      } else {
        start = { x: center(from.rect).x, y: from.rect.top + from.rect.height };
        end = { x: center(to.rect).x, y: to.rect.top + to.rect.height };
        const bottom = component.top + component.height - 18;
        controls = [{ x: start.x, y: bottom }, { x: end.x, y: bottom }];
        labelAt = { x: (start.x + end.x) / 2, y: bottom - 20 };
      }
    } else {
      start = boundaryPoint(from.rect, center(to.rect));
      end = boundaryPoint(to.rect, center(from.rect));
      labelAt = position.vertical
        ? { x: start.x, y: (start.y + end.y) / 2 }
        : { x: (start.x + end.x) / 2, y: start.y - 20 };
    }
    if (controls?.some((point) => !within({ left: point.x, top: point.y, width: 0, height: 0 }, bounds))) fail('diagram edge exceeds the container');
    lines.push(makeLine(`${component.id}-edge-${index}`, start, end, color, controls, edge.feedback));
    if (edge.label) {
      const label = edgeLabel(`${component.id}-edge-label-${index}`, edge.label, labelAt, bounds, component, options);
      if (position.nodes.some((node) => overlap(label, node.rect))) fail('edge label overlaps a diagram node');
      labels.push(label);
    }
  }

  return [...lines, ...position.nodes.map((node) => makeNode(node, component, options.fontName ?? 'Noto Sans SC')), ...labels];
}

/** Use the host's renderer font measurements for every candidate node/annotation wrap. */
export async function compileMeasuredDiagramComponent(
  component: DiagramComponent,
  textMeasure: import('./text-layout-compiler.js').TextMeasure,
): Promise<PPTElement[]> {
  if (component.annotation !== undefined) {
    const { compileTextComponents } = await import('./text-layout-compiler.js');
    const [annotation] = await compileTextComponents([{ kind: 'textBox', role: 'body', id: `${component.id}-annotation`,
      left: component.left, top: component.top, width: component.width, maxHeight: component.height,
      text: component.annotation, fontSize: ANNOTATION_FONT_SIZE, bold: true, align: 'left',
      color: component.textColor ?? '#30343A',
    }], textMeasure);
    if (annotation.type !== 'text') fail('annotation must compile to editable text');
    const reserve = annotation.height + 12;
    const diagram = await compileMeasuredDiagramComponent({ ...component, annotation: undefined,
      top: component.top + reserve, height: component.height - reserve }, textMeasure);
    return [...diagram, annotation];
  }
  const widths = new Map<string, number>();
  const requests = new Map<string, { text: string; size: number; weight: 400 | 700 }>();
  const collect = (text: string, size: number, weight: 400 | 700) => {
    const add = (value: string) => requests.set(`${size}:${weight}:${value}`, { text: value, size, weight });
    add(text.replace(/\n/g, ''));
    for (const line of text.split('\n')) add(line.trim());
    const chars = [...text];
    for (let index = 1; index < chars.length; index += 1) {
      add(chars.slice(0, index).join('').trim());
      add(chars.slice(index).join('').trim());
    }
  };
  for (const node of component.nodes) collect(node.label, NODE_FONT_SIZE, 700);
  if (component.annotation) collect(component.annotation, ANNOTATION_FONT_SIZE, 700);
  for (const edge of component.edges ?? []) if (edge.label) collect(edge.label, EDGE_FONT_SIZE, 400);
  await Promise.all([...requests.entries()].map(async ([key, request]) => {
    const result = await textMeasure({ html: `<p>${escapeHtml(request.text)}</p>`, text: request.text, width: 10000,
      fontSize: request.size, fontWeight: request.weight, fontFamily: 'Noto Sans SC', padding: 10,
      lineHeight: 1.5, paragraphSpace: 5, align: 'center' });
    widths.set(key, result.naturalWidth);
  }));
  return compileDiagramComponent(component, { measureText: (text, size, _font, weight) => {
    const result = widths.get(`${size}:${weight >= 600 ? 700 : 400}:${text}`);
    if (result === undefined) throw new Error(`Unmeasured diagram text: ${text}`);
    return result;
  } });
}

export interface DiagramAllocation { width: number; height: number }

/** Give the page author measured local choices before its single content call. */
export async function measureDiagramAllocations(
  plan: DiagramPlan,
  textMeasure: import('./text-layout-compiler.js').TextMeasure,
): Promise<DiagramAllocation[]> {
  const allocations: DiagramAllocation[] = [];
  const heights = plan.topology === 'cycle' ? [220, 240, 260, 280, 300, 320, 340, 360] : [120, 160, 200, 240, 280, 320, 360];
  // Include full-width and side-by-side choices when the actual plan permits.
  for (const width of [900, 700, 600, 440]) {
    for (const height of heights) {
      try {
        await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: 'planned-allocation', left: 50, top: 140, width, height }, textMeasure);
        allocations.push({ width, height });
        break;
      } catch (error) {
        // The first candidate can be shorter than the outside annotation's
        // measured text. That makes this rectangle infeasible, not the whole
        // teaching plan invalid; continue through the larger candidates.
        if (!(error instanceof TextLayoutError)
          && (!(error instanceof Error) || !error.message.startsWith('Invalid diagram component:'))) throw error;
      }
    }
  }
  if (!allocations.length) fail('planned diagram has no feasible measured allocation below the page heading');
  return allocations;
}
