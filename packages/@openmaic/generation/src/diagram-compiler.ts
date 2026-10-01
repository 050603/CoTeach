import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import type { DiagramPlan, DiagramSequenceGroup } from './outline-types.js';
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
interface SequencePosition {
  nodes: PositionedNode[];
  vertical: boolean;
  wrapped?: boolean;
  feedbackX?: number;
  feedbackSide?: 'left' | 'right';
  cycleGeometry?: { middle: Point; radiusX: number; radiusY: number };
  cyclePerimeter?: boolean;
  groupLabels?: Array<{ id: string; text: string; rect: Rect }>;
}

export interface DiagramAllocation { width: number; height: number }

/** The unoccupied slide rectangle in which the whole diagram must fit. */
export interface DiagramAllocationBounds {
  left?: number;
  top?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface MeasuredDiagramCompilerOptions {
  /** Previously measured choices for this complete plan, including annotation. */
  feasibleAllocations?: readonly DiagramAllocation[];
  /** Preserve a renderable graph when measured visual preferences cannot fit. */
  onDiagnostic?: (detail: string) => void;
}

/** A failed authored rectangle needs repositioning, not omitted graph content. */
export class DiagramAllocationError extends Error {
  readonly code = 'diagram-allocation';
  readonly authoredAllocation?: Readonly<Rect>;
  readonly availableArea?: Readonly<Rect>;
  readonly feasibleAllocations: readonly DiagramAllocation[];

  constructor(message: string, details: {
    authoredAllocation?: Rect;
    availableArea?: Rect;
    feasibleAllocations?: readonly DiagramAllocation[];
  } = {}) {
    const authored = details.authoredAllocation;
    const choices = details.feasibleAllocations ?? [];
    const allocation = authored
      ? ` (authored diagram allocation ${authored.width}×${authored.height}px at ${authored.left},${authored.top})` : '';
    const hint = choices.length
      ? `. Measured feasible allocations for all nodes, edges and annotation: ${choices.map((choice) => `${choice.width}×${choice.height}px`).join(', ')}. Reposition into the safe slide area and allocate a fitting rectangle without overlapping other content.` : '';
    super(`${message}${allocation}${hint}`);
    this.name = 'DiagramAllocationError';
    this.authoredAllocation = authored;
    this.availableArea = details.availableArea;
    this.feasibleAllocations = choices.map((choice) => ({ ...choice }));
  }
}

function isDiagramFitError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  // Dynamic ESM and CJS hosts may load separate copies of TextLayoutError.
  // Retain the stable error contract rather than depending on class identity.
  return error instanceof TextLayoutError
    || (error.name === 'TextLayoutError' && error.message.startsWith('Text layout:'))
    || error.message.startsWith('Invalid diagram component:');
}

const NODE_FONT_SIZE = 20;
const ANNOTATION_FONT_SIZE = 18;
const EDGE_FONT_SIZE = 16;
const EDGE_LABEL_HEIGHT = 40;
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

/** Normalize the local-component vocabulary before counting or compiling diagrams. */
export function normalizeDiagramComponent(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const component = value as Record<string, unknown>;
  if (component.type !== 'diagram' && component.kind !== 'diagram') return value;
  if ((component.type !== undefined && component.type !== 'diagram')
    || (component.kind !== undefined && component.kind !== 'diagram')) {
    fail('diagram component type and kind must not conflict');
  }
  return component.type === 'diagram' ? value : { ...component, type: 'diagram' };
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

/** Recognize complete explicit chains without turning partial label metadata
 * into missing steps. Legacy sequences with feedback retain adjacency rules. */
export function resolveDiagramSequenceGroups(plan: DiagramPlan): DiagramSequenceGroup[] | undefined {
  if (plan.sequenceGroups !== undefined) {
    if (plan.topology !== 'sequence' || !Array.isArray(plan.sequenceGroups) || !plan.sequenceGroups.length) fail('sequenceGroups require a sequence with nonempty independent groups');
    const known = new Set(plan.nodes.map((node) => node.id));
    const assigned = new Set<string>();
    const groupIds = new Set<string>();
    const groups = plan.sequenceGroups.map((group) => {
      if (!group || typeof group.id !== 'string' || !group.id.trim() || groupIds.has(group.id)) fail('each sequence group needs a unique nonempty id');
      groupIds.add(group.id);
      if (group.label !== undefined && (typeof group.label !== 'string' || !group.label.trim())) fail('sequence group labels must be nonempty strings');
      if (!Array.isArray(group.nodeIds) || group.nodeIds.length < 2) fail('each sequence group needs at least two ordered nodes');
      let previous = -1;
      for (const id of group.nodeIds) {
        const index = plan.nodes.findIndex((node) => node.id === id);
        if (!known.has(id) || assigned.has(id) || index <= previous) fail('sequence groups must preserve node order and assign each node exactly once');
        assigned.add(id);
        previous = index;
      }
      return { ...group, nodeIds: [...group.nodeIds] };
    });
    if (assigned.size !== known.size) fail('sequence groups must cover every diagram node');
    return groups;
  }
  if (plan.topology !== 'sequence' || !plan.edges?.length) return undefined;
  const indices = new Map(plan.nodes.map((node, index) => [node.id, index]));
  const incoming = new Map<string, string>();
  const outgoing = new Map<string, string>();
  for (const edge of plan.edges) {
    const from = indices.get(edge.from);
    const to = indices.get(edge.to);
    if (from === undefined || to === undefined || from >= to || incoming.has(edge.to) || outgoing.has(edge.from)) return undefined;
    incoming.set(edge.to, edge.from);
    outgoing.set(edge.from, edge.to);
  }
  // An uncovered node means these may be labels for only some edges of a
  // single sequence, whose unlabelled adjacent edges must still be inferred.
  if (plan.nodes.some((node) => !incoming.has(node.id) && !outgoing.has(node.id))) return undefined;
  const roots = plan.nodes.filter((node) => !incoming.has(node.id));
  if (roots.length < 2) return undefined;
  return roots.map((root, index) => {
    const nodeIds = [root.id];
    while (outgoing.has(nodeIds.at(-1)!)) nodeIds.push(outgoing.get(nodeIds.at(-1)!)!);
    return { id: `sequence-group-${index + 1}`, nodeIds };
  });
}

function parseEdges(component: DiagramComponent): DirectedEdge[] {
  const nodes = component.nodes;
  if (!Array.isArray(nodes) || nodes.length < (component.topology === 'cycle' ? 3 : 2) || nodes.length > 12) {
    fail('the topology requires 2–12 sequence/branch nodes or 3–12 cycle nodes');
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
  if (component.topology === 'branch') {
    if (!supplied.size) fail('a branch requires explicit directed edges');
    const edges = [...supplied].map(([key, label]) => {
      const [from, to] = key.split('\u0000');
      return { from: from!, to: to!, label, feedback: false };
    });
    branchLevels(component, edges);
    return edges;
  }
  const groups = resolveDiagramSequenceGroups(component);
  if (groups) {
    const required: DirectedEdge[] = groups.flatMap((group) => group.nodeIds.slice(0, -1).map((from, index) => {
      const to = group.nodeIds[index + 1]!;
      const key = `${from}\u0000${to}`;
      if (component.edges !== undefined && !supplied.has(key)) fail('parallel sequence groups require every consecutive edge');
      const label = supplied.get(key);
      supplied.delete(key);
      return { from, to, label, feedback: false };
    }));
    if (supplied.size) fail('parallel sequence edges must stay within their ordered group; cross-group edges are not allowed');
    return required;
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

/** Longest-path levels preserve every fork and merge without inventing a
 * transition between siblings. Node order only breaks ties within a level. */
function branchLevels(component: DiagramComponent, edges: readonly DirectedEdge[]): string[][] {
  const incoming = new Map(component.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(component.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const roots = component.nodes.filter((node) => incoming.get(node.id) === 0);
  if (roots.length !== 1) fail('a branch must have exactly one root');
  const queue = [roots[0]!.id];
  const depth = new Map([[queue[0]!, 0]]);
  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index]!;
    for (const to of outgoing.get(from)!) {
      depth.set(to, Math.max(depth.get(to) ?? 0, depth.get(from)! + 1));
      incoming.set(to, incoming.get(to)! - 1);
      if (incoming.get(to) === 0) queue.push(to);
    }
  }
  if (queue.length !== component.nodes.length) fail('a branch must be acyclic and every node must be reachable from its root');
  return Array.from({ length: Math.max(...depth.values()) + 1 }, (_, level) =>
    component.nodes.filter((node) => depth.get(node.id) === level).map((node) => node.id));
}

function nodeSize(component: DiagramComponent, options: DiagramCompilerOptions, widthLimit?: number, maxNodeWidth = NODE_MAX_WIDTH): { width: number; height: number; lines: string[][] } {
  if (widthLimit !== undefined && widthLimit < NODE_MIN_WIDTH) fail('readable diagram nodes do not fit inside the container');
  const maxWidth = Math.min(maxNodeWidth, Math.max(NODE_MIN_WIDTH, component.width * 0.24), widthLimit ?? Infinity);
  const width = Math.min(maxWidth, Math.max(NODE_MIN_WIDTH, Math.max(...component.nodes.map((node) => measure(node.label.replace(/\n/g, ''), NODE_FONT_SIZE, options))) + NODE_PADDING_X * 2));
  const lines = component.nodes.map((node) => wrapLabel(node.label, width - NODE_PADDING_X * 2, options));
  const height = Math.max(...lines.map((parts) => parts.length)) * NODE_LINE_HEIGHT + NODE_PADDING_Y * 2;
  return { width, height, lines };
}

function* positionCycleCandidates(component: DiagramComponent, options: DiagramCompilerOptions, edges: DirectedEdge[]): Generator<SequencePosition> {
  const size = nodeSize(component, options);
  const angles = component.nodes.map((_, index) => -Math.PI / 2 + index * (2 * Math.PI / component.nodes.length));
  const minSin = Math.min(...angles.map(Math.sin));
  const maxSin = Math.max(...angles.map(Math.sin));
  const maxCos = Math.max(...angles.map((angle) => Math.abs(Math.cos(angle))));
  const step = 2 * Math.PI / component.nodes.length;
  const controlAngles = angles.flatMap((angle) => [angle + step / 3, angle + step * 2 / 3]);
  const controlCos = Math.max(...controlAngles.map((angle) => Math.abs(Math.cos(angle))));
  const controlSin = Math.max(...controlAngles.map(Math.sin));
  // Try measured widths before rejecting a ring, including wider single-line
  // labels that leave more vertical space. Odd rings have no
  // bottom-centre node: fit their actual extent, rather than wasting the gap
  // between the lowest pair and an imaginary node at the bottom of the ellipse.
  const widths = [...new Set([size.width, Math.min(260, component.width * 0.24), ...Array.from({ length: Math.ceil((size.width - NODE_MIN_WIDTH) / 8) },
    (_, index) => Math.max(NODE_MIN_WIDTH, size.width - (index + 1) * 8))])];
  for (const width of widths) {
    let ringSize = size;
    try {
      if (width !== size.width) ringSize = nodeSize(component, options, width, 260);
    } catch (error) {
      if (!isDiagramFitError(error)) throw error;
      continue;
    }
    const radiusX = Math.min((component.width - ringSize.width - NODE_MARGIN * 2) / (maxCos * 2),
      component.width / (controlCos * 2));
    const radiusY = Math.min((component.height - ringSize.height - NODE_MARGIN * 2) / (maxSin - minSin),
      (component.height - NODE_MARGIN - ringSize.height / 2) / (controlSin - minSin));
    const middle = { x: component.left + component.width / 2,
      y: component.top + NODE_MARGIN + ringSize.height / 2 - radiusY * minSin };
    const positioned = component.nodes.map((node, index) => ({
      ...node, lines: ringSize.lines[index]!, rect: {
        left: middle.x + radiusX * Math.cos(angles[index]!) - ringSize.width / 2,
        top: middle.y + radiusY * Math.sin(angles[index]!) - ringSize.height / 2,
        width: ringSize.width, height: ringSize.height,
      },
    }));
    if (radiusX > 0 && radiusY > 0 && positioned.every((node, index) => positioned.slice(index + 1)
      .every((next) => !overlap(node.rect, next.rect, 8)))) {
      yield { nodes: positioned, vertical: false, cycleGeometry: { middle, radiusX, radiusY } };
    }
  }
  // A shallow ellipse crowds long two-line nodes near its upper/lower arcs.
  // A clockwise perimeter keeps the same ordered ring and closing edge while
  // giving those nodes two separated, readable rows inside the same rectangle.
  // An odd ring must remain a ring, not an uneven pair of rectangular rows.
  if (component.nodes.length < 4 || component.nodes.length % 2 !== 0) return;
  const topCount = Math.ceil(component.nodes.length / 2);
  const bottomCount = component.nodes.length - topCount;
  const turnIndices = new Set([topCount - 1, component.nodes.length - 1]);
  const turnLabels = edges.filter((_, index) => turnIndices.has(index)).map((edge) => edge.label);
  const horizontalLabels = edges.filter((_, index) => !turnIndices.has(index)).map((edge) => edge.label);
  const turnWidth = Math.max(0, ...turnLabels.map((label) => label ? edgeLabelWidth(label, options) : 0));
  const horizontalGap = Math.max(24, ...horizontalLabels.map((label) => label ? edgeLabelWidth(label, options) + 8 : 24));
  const rowGap = turnLabels.some(Boolean) ? 48 : 24;
  const widthLimit = Math.min(
    (component.width - NODE_MARGIN * 2 - (topCount - 1) * horizontalGap) / topCount,
    (component.width - turnWidth - 8) / (topCount - 1) - horizontalGap,
  );
  if (widthLimit < NODE_MIN_WIDTH) return;
  let perimeterSize = size;
  try {
    if (widthLimit < size.width) perimeterSize = nodeSize(component, options, widthLimit);
  } catch (error) {
    if (!isDiagramFitError(error)) throw error;
    return;
  }
  const sideMargin = Math.max(NODE_MARGIN, (turnWidth - perimeterSize.width) / 2 + 4);
  const minimumWidth = topCount * perimeterSize.width + (topCount - 1) * horizontalGap;
  const minimumHeight = perimeterSize.height * 2 + rowGap;
  const availableWidth = component.width - sideMargin * 2;
  const availableHeight = component.height - NODE_MARGIN * 2;
  if (minimumWidth > availableWidth || minimumHeight > availableHeight) return;
  const span = minimumWidth + Math.min((topCount - 1) * 38, availableWidth - minimumWidth);
  const height = minimumHeight + Math.min(38, availableHeight - minimumHeight);
  const left = component.left + (component.width - span) / 2;
  const top = component.top + (component.height - height) / 2;
  const nodes = component.nodes.map((node, index) => {
    const inTop = index < topCount;
    const rowCount = inTop ? topCount : bottomCount;
    const localIndex = inTop ? index : index - topCount;
    const column = inTop ? localIndex : rowCount - 1 - localIndex;
    return { ...node, lines: perimeterSize.lines[index]!, rect: {
      left: left + column * (span - perimeterSize.width) / (rowCount - 1),
      top: inTop ? top : top + height - perimeterSize.height,
      width: perimeterSize.width, height: perimeterSize.height,
    } };
  });
  yield { nodes, vertical: false, wrapped: true, cyclePerimeter: true };
}

function edgeLabelWidth(label: string, options: DiagramCompilerOptions): number {
  return Math.max(52, measure(label, EDGE_FONT_SIZE, options, 500) + 24);
}

function positionSequence(component: DiagramComponent, options: DiagramCompilerOptions, edges: DirectedEdge[], widthLimit?: number): SequencePosition {
  const size = nodeSize(component, options, widthLimit);
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
  // Ordinary sequences keep one reading direction. A folded return path can
  // look like a cycle even though the source has no feedback relationship.
  // Report the real allocation failure so the page can choose more room;
  // preserve the dedicated folded routing only for an actual feedback edge.
  if (!feedback || component.nodes.length < 4) fail('sequence nodes and edge labels do not fit inside the container');
  const feedbackEdge = edges.find((edge) => edge.feedback);
  const bounds: Rect = { left: component.left, top: component.top, width: component.width, height: component.height };
  for (let requestedRows = 2; requestedRows < component.nodes.length; requestedRows += 1) {
    const columns = Math.ceil(component.nodes.length / requestedRows);
    if (columns < 2) continue;
    const rowOffsets: number[] = [];
    let assigned = 0;
    const rows = Array.from({ length: requestedRows }, (_, row) => {
      rowOffsets.push(assigned);
      const count = Math.floor(component.nodes.length / requestedRows) + (row < component.nodes.length % requestedRows ? 1 : 0);
      const nodes = component.nodes.slice(assigned, assigned + count);
      assigned += count;
      return nodes;
    });
    const outerSide = (nodeId: string, side: 'left' | 'right'): boolean => {
      const nodeIndex = component.nodes.findIndex((node) => node.id === nodeId);
      const rowIndex = rowOffsets.findIndex((offset, index) => nodeIndex >= offset
        && (index === rowOffsets.length - 1 || nodeIndex < rowOffsets[index + 1]!));
      const localIndex = nodeIndex - rowOffsets[rowIndex]!;
      const lastIndex = rows[rowIndex]!.length - 1;
      return rowIndex % 2 === 0
        ? localIndex === (side === 'left' ? 0 : lastIndex)
        : localIndex === (side === 'left' ? lastIndex : 0);
    };
    const feedbackSide = feedbackEdge
      ? (outerSide(feedbackEdge.from, 'left') && outerSide(feedbackEdge.to, 'left') ? 'left'
        : outerSide(feedbackEdge.from, 'right') && outerSide(feedbackEdge.to, 'right') ? 'right' : undefined)
      : undefined;
    // A feedback line must leave from the outside of both endpoint rows;
    // otherwise it would run through intervening nodes on its way to the lane.
    if (feedbackEdge && !feedbackSide) continue;
    const turnIndices = new Set(rowOffsets.slice(1).map((offset) => offset - 1));
    const turnLabels = rowOffsets.slice(1).map((offset) => labels[offset - 1]);
    const largestTurnLabel = Math.max(0, ...turnLabels.map((label) => label ? edgeLabelWidth(label, options) : 0));
    const turnOverhang = Math.max(0, (largestTurnLabel - size.width) / 2);
    const sideMargin = Math.max(NODE_MARGIN, turnOverhang + 4);
    const feedbackLane = feedbackEdge
      ? Math.max(58, (feedbackEdge.label ? edgeLabelWidth(feedbackEdge.label, options) : 0) + turnOverhang * 2 + 8)
      : 0;
    const main: Rect = {
      left: component.left + sideMargin + (feedbackSide === 'left' ? feedbackLane : 0),
      top: component.top + NODE_MARGIN,
      width: component.width - sideMargin * 2 - feedbackLane,
      height: component.height - NODE_MARGIN * 2,
    };
    if (main.width < size.width || main.height < size.height) continue;
    const horizontalLabels = labels.filter((_, index) => !turnIndices.has(index));
    const horizontalGap = Math.max(24, ...horizontalLabels.map((label) => label ? edgeLabelWidth(label, options) + 8 : 24));
    const minimumWidth = columns * size.width + (columns - 1) * horizontalGap;
    if (minimumWidth > main.width) continue;
    const rowGaps = turnLabels.map((label) => label ? 48 : 24);
    const minimumHeight = requestedRows * size.height + rowGaps.reduce((sum, gap) => sum + gap, 0);
    if (minimumHeight > main.height) continue;
    const columnGap = horizontalGap + Math.min(38, (main.width - minimumWidth) / (columns - 1));
    const totalWidth = columns * size.width + (columns - 1) * columnGap;
    const left = main.left + (main.width - totalWidth) / 2;
    const rowExtra = Math.min(38, (main.height - minimumHeight) / (requestedRows - 1));
    const rowHeight = minimumHeight + rowExtra * (requestedRows - 1);
    let top = main.top + (main.height - rowHeight) / 2;
    const positioned: PositionedNode[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      const rightward = rowIndex % 2 === 0;
      const rowWidth = row.length * size.width + (row.length - 1) * columnGap;
      const rowLeft = left + (totalWidth - rowWidth) / 2;
      for (const [index, node] of row.entries()) {
        const column = rightward ? index : row.length - 1 - index;
        positioned.push({ ...node, lines: size.lines[rowOffsets[rowIndex]! + index]!, rect: {
          left: rowLeft + column * (size.width + columnGap), top,
          width: size.width, height: size.height,
        } });
      }
      top += size.height + (rowGaps[rowIndex] ?? 0) + rowExtra;
    }
    // Turning labels must have their full measured width within the slide.
    if (turnLabels.some((label, index) => {
      if (!label) return false;
      const from = positioned[rowOffsets[index + 1]! - 1]!;
      const to = positioned[rowOffsets[index + 1]!]!;
      const width = edgeLabelWidth(label, options);
      const x = (center(from.rect).x + center(to.rect).x) / 2;
      return x - width / 2 < bounds.left
        || x + width / 2 > bounds.left + bounds.width;
    })) continue;
    return { nodes: positioned, vertical: false, wrapped: true,
      ...(feedbackSide ? { feedbackSide,
        feedbackX: feedbackSide === 'left'
          ? component.left + sideMargin + feedbackLane / 2
          : component.left + component.width - sideMargin - feedbackLane / 2 } : {}),
    };
  }
  fail('sequence nodes and edge labels do not fit inside the container');
}

function positionParallelSequences(
  component: DiagramComponent,
  options: DiagramCompilerOptions,
  edges: DirectedEdge[],
  groups: readonly DiagramSequenceGroup[],
): SequencePosition {
  const groupGap = 20;
  const maximumBand = component.height - (groups.length - 1) * groupGap;
  const bands = groups.map((group) => {
    const nodes = group.nodeIds.map((id) => component.nodes.find((node) => node.id === id)!);
    const memberIds = new Set(group.nodeIds);
    const groupEdges = edges.filter((edge) => memberIds.has(edge.from));
    const labelHeight = group.label ? 42 : 0;
    if (group.label && measure(group.label, ANNOTATION_FONT_SIZE, options, 700) > component.width - 20) fail('sequence group label does not fit without clipping');
    const horizontalGaps = groupEdges.reduce((sum, edge) => sum + (edge.label ? edgeLabelWidth(edge.label, options) + 8 : 24), 0);
    const compactWidth = (component.width - NODE_MARGIN * 2 - horizontalGaps) / nodes.length;
    const heights = [...new Set([85, 110, 120, 160, 200, 240, 280, 320, maximumBand]
      .filter((height) => height > labelHeight && height <= maximumBand))].sort((a, b) => a - b);
    for (const height of heights) {
      // Try ordinary nodes first, then balanced two-line labels at the same
      // readable font size. This keeps independent chains out of false folds.
      for (const widthLimit of [undefined, compactWidth]) {
        try {
          const position = positionSequence({ ...component, annotation: undefined, sequenceGroups: undefined,
            nodes, edges: groupEdges, top: component.top + labelHeight, height: height - labelHeight }, options, groupEdges, widthLimit);
          return { group, height, labelHeight, position };
        } catch (error) {
          if (!isDiagramFitError(error)) throw error;
        }
      }
    }
    fail('parallel sequence nodes and edge labels do not fit inside the container');
  });
  const totalHeight = bands.reduce((sum, band) => sum + band.height, 0) + (bands.length - 1) * groupGap;
  if (totalHeight > component.height) fail('parallel sequence groups do not fit together inside the container');
  let top = component.top + (component.height - totalHeight) / 2;
  const positioned = new Map<string, PositionedNode>();
  const groupLabels: NonNullable<SequencePosition['groupLabels']> = [];
  for (const band of bands) {
    const offset = top - component.top;
    for (const node of band.position.nodes) positioned.set(node.id, { ...node, rect: { ...node.rect, top: node.rect.top + offset } });
    if (band.group.label) groupLabels.push({ id: band.group.id, text: band.group.label,
      rect: { left: component.left, top, width: component.width, height: band.labelHeight } });
    top += band.height + groupGap;
  }
  return { nodes: component.nodes.map((node) => positioned.get(node.id)!), vertical: false, wrapped: true, groupLabels };
}

function positionBranch(component: DiagramComponent, options: DiagramCompilerOptions, edges: DirectedEdge[]): SequencePosition {
  const levels = branchLevels(component, edges);
  const size = nodeSize(component, options);
  const widestLabel = Math.max(0, ...edges.map((edge) => edge.label ? edgeLabelWidth(edge.label, options) : 0));
  for (const vertical of [true, false]) {
    const main = { left: component.left + NODE_MARGIN, top: component.top + NODE_MARGIN,
      width: component.width - NODE_MARGIN * 2, height: component.height - NODE_MARGIN * 2 };
    const along = vertical ? size.height : size.width;
    const across = vertical ? size.width : size.height;
    const alongSpace = vertical ? main.height : main.width;
    const acrossSpace = vertical ? main.width : main.height;
    const levelGap = widestLabel ? (vertical ? 56 : widestLabel + 12) : 32;
    // Fork labels sit between the parent and each child. Keep enough space
    // between sibling branches for those labels at their measured font size.
    const crossLabelExtent = vertical ? widestLabel : widestLabel ? EDGE_LABEL_HEIGHT : 0;
    const siblingGap = Math.max(28, crossLabelExtent * 2 + 12 - across);
    const minimumAlong = levels.length * along + (levels.length - 1) * levelGap;
    const maximumAcross = Math.max(...levels.map((level) => level.length * across + (level.length - 1) * siblingGap));
    if (minimumAlong > alongSpace || maximumAcross > acrossSpace) continue;
    const gap = levelGap + Math.min(40, (alongSpace - minimumAlong) / (levels.length - 1));
    const totalAlong = levels.length * along + (levels.length - 1) * gap;
    const origin = (vertical ? main.top : main.left) + (alongSpace - totalAlong) / 2;
    const rects = new Map<string, Rect>();
    for (const [levelIndex, level] of levels.entries()) {
      const totalAcross = level.length * across + (level.length - 1) * siblingGap;
      const crossOrigin = (vertical ? main.left : main.top) + (acrossSpace - totalAcross) / 2;
      for (const [index, id] of level.entries()) rects.set(id, {
        left: vertical ? crossOrigin + index * (across + siblingGap) : origin + levelIndex * (along + gap),
        top: vertical ? origin + levelIndex * (along + gap) : crossOrigin + index * (across + siblingGap),
        width: size.width, height: size.height,
      });
    }
    return { vertical, nodes: component.nodes.map((node, index) => ({ ...node,
      lines: size.lines[index]!, rect: rects.get(node.id)! })) };
  }
  fail('branch nodes and edge labels do not fit inside the container');
}

function segmentIntersectsRect(start: Point, end: Point, rect: Rect): boolean {
  let low = 0;
  let high = 1;
  for (const [origin, destination, minimum, maximum] of [
    [start.x, end.x, rect.left - 4, rect.left + rect.width + 4],
    [start.y, end.y, rect.top - 4, rect.top + rect.height + 4],
  ]) {
    const delta = destination! - origin!;
    if (Math.abs(delta) < 0.0001) {
      if (origin! < minimum! || origin! > maximum!) return false;
    } else {
      const first = (minimum! - origin!) / delta;
      const last = (maximum! - origin!) / delta;
      low = Math.max(low, Math.min(first, last));
      high = Math.min(high, Math.max(first, last));
      if (low > high) return false;
    }
  }
  return high >= 0 && low <= 1;
}

function curvePoint(start: Point, end: Point, controls: [Point, Point], t: number): Point {
  const reverse = 1 - t;
  return { x: reverse ** 3 * start.x + 3 * reverse ** 2 * t * controls[0].x
    + 3 * reverse * t ** 2 * controls[1].x + t ** 3 * end.x,
  y: reverse ** 3 * start.y + 3 * reverse ** 2 * t * controls[0].y
    + 3 * reverse * t ** 2 * controls[1].y + t ** 3 * end.y };
}

function edgeIntersectsRect(start: Point, end: Point, controls: [Point, Point] | undefined, rect: Rect): boolean {
  let previous = start;
  for (let step = 1; step <= (controls ? 64 : 1); step += 1) {
    const next = controls ? curvePoint(start, end, controls, step / 64) : end;
    if (segmentIntersectsRect(previous, next, rect)) return true;
    previous = next;
  }
  return false;
}

function routeBranchEdge(component: DiagramComponent, position: SequencePosition, from: PositionedNode, to: PositionedNode): {
  start: Point; end: Point; controls?: [Point, Point]; labelAt: Point;
} {
  const obstacles = position.nodes.filter((node) => node.id !== from.id && node.id !== to.id);
  const clear = (start: Point, end: Point, controls?: [Point, Point]): boolean => {
    let previous = start;
    for (let step = 1; step <= (controls ? 64 : 1); step += 1) {
      const next = controls ? curvePoint(start, end, controls, step / 64) : end;
      if (obstacles.some((node) => segmentIntersectsRect(previous, next, node.rect))) return false;
      previous = next;
    }
    return true;
  };
  const start = boundaryPoint(from.rect, center(to.rect));
  const end = boundaryPoint(to.rect, center(from.rect));
  if (clear(start, end)) return { start, end, labelAt: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
  // An edge may skip a level in a valid DAG. Route it outside the intervening
  // nodes instead of hiding it or synthesizing a chain through those nodes.
  for (const side of [-1, 1]) {
    const lane = position.vertical
      ? component.left + (side < 0 ? 8 : component.width - 8)
      : component.top + (side < 0 ? 8 : component.height - 8);
    const controls: [Point, Point] = position.vertical
      ? [{ x: lane, y: center(from.rect).y }, { x: lane, y: center(to.rect).y }]
      : [{ x: center(from.rect).x, y: lane }, { x: center(to.rect).x, y: lane }];
    const routedStart = boundaryPoint(from.rect, controls[0]);
    const routedEnd = boundaryPoint(to.rect, controls[1]);
    if (clear(routedStart, routedEnd, controls)) return { start: routedStart, end: routedEnd, controls,
      labelAt: curvePoint(routedStart, routedEnd, controls, 0.5) };
  }
  fail('a branch edge crosses an unrelated node; enlarge the diagram container');
}

function edgeLabel(id: string, label: string, at: Point, bounds: Rect, component: DiagramComponent, options: DiagramCompilerOptions): PPTTextElement {
  const availableWidth = 2 * Math.min(at.x - bounds.left, bounds.left + bounds.width - at.x);
  const width = Math.min(availableWidth, edgeLabelWidth(label, options));
  if (measure(label, EDGE_FONT_SIZE, options, 500) > width - 20) fail(`edge label ${JSON.stringify(label)} is too long`);
  const rect = { left: at.x - width / 2, top: at.y - EDGE_LABEL_HEIGHT / 2, width, height: EDGE_LABEL_HEIGHT };
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
  if (component.topology !== 'sequence' && component.topology !== 'cycle' && component.topology !== 'branch') fail('topology must be sequence, cycle or branch');
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
  const sequenceGroups = resolveDiagramSequenceGroups(component);
  const positions = component.topology === 'cycle'
    ? positionCycleCandidates(component, options, edges)
    : [component.topology === 'branch' ? positionBranch(component, options, edges)
    : sequenceGroups ? positionParallelSequences(component, options, edges, sequenceGroups)
    : positionSequence(component, options, edges)];
  let lastError: Error | undefined;
  for (const position of positions) {
    try {
      return renderDiagramPosition(component, options, edges, position, bounds);
    } catch (error) {
      if (component.topology !== 'cycle' || !isDiagramFitError(error)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  fail('cycle nodes and edge labels do not fit inside the container');
}

function renderDiagramPosition(component: DiagramComponent, options: DiagramCompilerOptions,
  edges: DirectedEdge[], position: SequencePosition, bounds: Rect): PPTElement[] {
  const byId = new Map(position.nodes.map((node) => [node.id, node]));
  const lines: PPTLineElement[] = [];
  const labels: PPTTextElement[] = [];
  const routes: Array<{ start: Point; end: Point; controls?: [Point, Point] }> = [];
  const pendingLabels: Array<{ text: string; edgeIndex: number; points: Point[] }> = [];
  const color = component.accentColor ?? '#D97706';

  for (const [index, edge] of edges.entries()) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    let start: Point;
    let end: Point;
    let controls: [Point, Point] | undefined;
    let labelAt: Point;
    let alternateLabelPoints: Point[] = [];
    if (component.topology === 'branch') {
      ({ start, end, controls, labelAt } = routeBranchEdge(component, position, from, to));
    } else if (component.topology === 'cycle' && !position.cyclePerimeter) {
      const fromIndex = component.nodes.findIndex((node) => node.id === edge.from);
      const step = 2 * Math.PI / component.nodes.length;
      const angle = -Math.PI / 2 + fromIndex * step;
      const { middle, radiusX, radiusY } = position.cycleGeometry!;
      const atAngle = (value: number): Point => ({ x: middle.x + radiusX * Math.cos(value), y: middle.y + radiusY * Math.sin(value) });
      controls = [atAngle(angle + step / 3), atAngle(angle + step * 2 / 3)];
      start = boundaryPoint(from.rect, controls[0]);
      end = boundaryPoint(to.rect, controls[1]);
      const labelPoint = atAngle(angle + step / 2);
      const dx = labelPoint.x - middle.x;
      const dy = labelPoint.y - middle.y;
      const distance = Math.hypot(dx, dy) || 1;
      labelAt = { x: labelPoint.x + dx / distance * 22, y: labelPoint.y + dy / distance * 22 };
      // The interior of a shallow ring often has more label space than its
      // narrow outside rim. Try both sides of this edge without moving nodes.
      alternateLabelPoints = [22, 56, 96, 136, 176].map((inset) => ({
        x: labelPoint.x - dx / distance * inset, y: labelPoint.y - dy / distance * inset,
      }));
    } else if (edge.feedback) {
      if (position.wrapped) {
        const side = position.feedbackX!;
        start = { x: position.feedbackSide === 'left' ? from.rect.left : from.rect.left + from.rect.width, y: center(from.rect).y };
        end = { x: position.feedbackSide === 'left' ? to.rect.left : to.rect.left + to.rect.width, y: center(to.rect).y };
        controls = [{ x: side, y: start.y }, { x: side, y: end.y }];
        labelAt = { x: side, y: (start.y + end.y) / 2 };
      } else if (position.vertical) {
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
    } else if (position.wrapped && !position.cyclePerimeter && from.rect.top !== to.rect.top) {
      // Use the clear band between centred rows. A diagonal between their
      // centres can enter the last node or a neighbour in the shorter row.
      start = { x: center(from.rect).x, y: from.rect.top + from.rect.height };
      end = { x: center(to.rect).x, y: to.rect.top };
      const turnY = (start.y + end.y) / 2;
      controls = [{ x: start.x, y: turnY }, { x: end.x, y: turnY }];
      labelAt = { x: (start.x + end.x) / 2, y: turnY };
    } else {
      start = boundaryPoint(from.rect, center(to.rect));
      end = boundaryPoint(to.rect, center(from.rect));
      labelAt = position.vertical || (position.wrapped && from.rect.top !== to.rect.top)
        ? { x: start.x, y: (start.y + end.y) / 2 }
        : { x: (start.x + end.x) / 2, y: start.y - 20 };
    }
    if (controls?.some((point) => !within({ left: point.x, top: point.y, width: 0, height: 0 }, bounds))) fail('diagram edge exceeds the container');
    if (position.nodes.some((node) => node.id !== from.id && node.id !== to.id
        && edgeIntersectsRect(start, end, controls, node.rect))) fail('diagram edge crosses an unrelated node; enlarge the diagram container');
    routes.push({ start, end, controls });
    lines.push(makeLine(`${component.id}-edge-${index}`, start, end, color, controls, edge.feedback));
    if (edge.label) pendingLabels.push({ text: edge.label, edgeIndex: index, points: [labelAt, ...alternateLabelPoints] });
  }
  for (const pending of pendingLabels) {
    let accepted: PPTTextElement | undefined;
    let lastError: Error | undefined;
    for (const point of pending.points) {
      try {
        const label = edgeLabel(`${component.id}-edge-label-${pending.edgeIndex}`, pending.text, point, bounds, component, options);
        if (position.nodes.some((node) => overlap(label, node.rect))) fail('edge label overlaps a diagram node');
        if (labels.some((existing) => overlap(label, existing, 4))) fail(`${component.topology} edge labels overlap; enlarge the diagram container`);
        if (routes.some((route, index) => index !== pending.edgeIndex
          && edgeIntersectsRect(route.start, route.end, route.controls, label))) fail('edge label overlaps an unrelated connector; enlarge the diagram container');
        accepted = label;
        break;
      } catch (error) {
        if (!isDiagramFitError(error)) throw error;
        lastError = error;
      }
    }
    if (!accepted) throw lastError!;
    labels.push(accepted);
  }

  return [...lines, ...position.nodes.map((node) => makeNode(node, component, options.fontName ?? 'Noto Sans SC')), ...labels,
    ...(position.groupLabels ?? []).map((label) => makeText(`${component.id}-group-${label.id}`, label.text, label.rect,
      ANNOTATION_FONT_SIZE, component.textColor ?? '#30343A', options.fontName ?? 'Noto Sans SC', { weight: 700 }))];
}

/** Use the host's renderer font measurements for every candidate node/annotation wrap. */
export async function compileMeasuredDiagramComponent(
  component: DiagramComponent,
  textMeasure: import('./text-layout-compiler.js').TextMeasure,
  options: MeasuredDiagramCompilerOptions = {},
): Promise<PPTElement[]> {
  try {
    return await compileMeasuredDiagram(component, textMeasure);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (!isDiagramFitError(error) && !options.onDiagnostic) throw error;
    if (options.onDiagnostic) {
      // The fallback validates real endpoints and retains every original label,
      // edge and annotation. It does not certify the resulting layout as fitting.
      const elements = compileDiagramForReview(component);
      options.onDiagnostic(`${error instanceof Error ? error.message : String(error)}; retaining the complete graph with a basic editable layout`);
      return elements;
    }
    throw new DiagramAllocationError(error instanceof Error ? error.message : String(error), {
      authoredAllocation: { left: component.left, top: component.top, width: component.width, height: component.height },
      feasibleAllocations: options.feasibleAllocations,
    });
  }
}

function compileDiagramForReview(component: DiagramComponent): PPTElement[] {
  if (!component || component.type !== 'diagram' || typeof component.id !== 'string' || !component.id.trim()
    || !['sequence', 'cycle', 'branch'].includes(component.topology)) fail('a renderable diagram needs its type, id and topology');
  if (![component.left, component.top].every((value) => typeof value === 'number' && Number.isFinite(value))
    || !finitePositive(component.width) || !finitePositive(component.height)) fail('container coordinates must be finite and positive');
  if (!Array.isArray(component.nodes) || !component.nodes.length) fail('a renderable diagram needs nodes');
  const known = new Set<string>();
  for (const node of component.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || known.has(node.id)
      || typeof node.label !== 'string' || !node.label.trim()) fail('every node needs a unique id and nonempty label');
    known.add(node.id);
  }
  if (component.edges !== undefined && !Array.isArray(component.edges)) fail('edges must be an array');
  const edges: Array<{ from: string; to: string; label?: string }> = component.edges ?? (component.topology === 'branch' ? []
    : component.sequenceGroups?.length ? component.sequenceGroups.flatMap((group) => group.nodeIds.slice(0, -1)
        .map((from, index) => ({ from, to: group.nodeIds[index + 1]! })))
    : component.nodes.slice(0, component.topology === 'cycle' ? undefined : -1).map((node, index) => ({
        from: node.id, to: component.nodes[(index + 1) % component.nodes.length]!.id,
      })));
  for (const edge of edges) if (!edge || !known.has(edge.from) || !known.has(edge.to)
    || edge.label !== undefined && typeof edge.label !== 'string') fail('an edge needs real source and destination nodes');
  if (component.annotation !== undefined && typeof component.annotation !== 'string') fail('annotation must be text');
  const columns = component.topology === 'cycle' ? Math.ceil(Math.sqrt(component.nodes.length))
    : Math.min(3, component.nodes.length);
  const rows = Math.ceil(component.nodes.length / columns);
  const captionHeight = component.annotation ? Math.min(60, component.height / 3) : 0;
  const gap = Math.min(18, component.width / (columns * 4), (component.height - captionHeight) / (rows * 4));
  const width = (component.width - gap * (columns - 1)) / columns;
  const height = (component.height - captionHeight - gap * (rows - 1)) / rows;
  const nodes: PositionedNode[] = component.nodes.map((node, index) => ({ ...node, lines: node.label.split('\n'), rect: {
    left: component.left + (index % columns) * (width + gap),
    top: component.top + captionHeight + Math.floor(index / columns) * (height + gap), width, height,
  } }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const font = 'Noto Sans SC';
  const lines: PPTElement[] = [];
  const labels: PPTElement[] = [];
  for (const [index, edge] of edges.entries()) {
    const from = byId.get(edge.from)!.rect, to = byId.get(edge.to)!.rect;
    const origin = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
    const destination = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
    const dx = destination.x - origin.x, dy = destination.y - origin.y;
    const port = (rect: Rect, center: Point, direction: number) => {
      const scale = Math.min(dx ? rect.width / (2 * Math.abs(dx)) : Infinity,
        dy ? rect.height / (2 * Math.abs(dy)) : Infinity);
      return Number.isFinite(scale) ? { x: center.x + direction * dx * scale, y: center.y + direction * dy * scale } : center;
    };
    lines.push(makeLine(`${component.id}-edge-${index}`, port(from, origin, 1), port(to, destination, -1),
      component.accentColor ?? '#D97706'));
    if (edge.label) labels.push(makeText(`${component.id}-edge-label-${index}`, edge.label, {
      left: (origin.x + destination.x) / 2 - 80, top: (origin.y + destination.y) / 2 - 20, width: 160, height: 40,
    }, EDGE_FONT_SIZE, component.textColor ?? '#30343A', font));
  }
  for (const [index, group] of (component.sequenceGroups ?? []).entries()) if (group.label) {
    const first = byId.get(group.nodeIds[0] ?? '')?.rect;
    if (first) labels.push(makeText(`${component.id}-group-${index}`, group.label,
      { ...first, top: first.top - 36, height: 36 }, ANNOTATION_FONT_SIZE, component.textColor ?? '#30343A', font, { weight: 700 }));
  }
  return [...lines, ...nodes.map((node) => makeNode(node, component, font)), ...labels,
    ...(component.annotation ? [makeText(`${component.id}-annotation`, component.annotation,
      { left: component.left, top: component.top, width: component.width, height: captionHeight },
      ANNOTATION_FONT_SIZE, component.textColor ?? '#30343A', font, { weight: 700 })] : [])];
}

async function compileMeasuredDiagram(
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
    const diagram = await compileMeasuredDiagram({ ...component, annotation: undefined,
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
  for (const group of component.sequenceGroups ?? []) if (group.label) collect(group.label, ANNOTATION_FONT_SIZE, 700);
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

/** Give the page author measured local choices before its single content call. */
export async function measureDiagramAllocations(
  plan: DiagramPlan,
  textMeasure: import('./text-layout-compiler.js').TextMeasure,
  bounds: DiagramAllocationBounds = {},
): Promise<DiagramAllocation[]> {
  const left = bounds.left ?? 50;
  const top = bounds.top ?? 140;
  const maxWidth = Math.min(bounds.maxWidth ?? 900, 950 - left);
  const maxHeight = Math.min(bounds.maxHeight ?? 512.5 - top, 512.5 - top);
  const availableArea = { left, top, width: maxWidth, height: maxHeight };
  if (!within(availableArea, { left: 50, top: 50, width: 900, height: 462.5 })
    || !finitePositive(maxWidth) || !finitePositive(maxHeight)) fail('diagram allocation bounds must lie inside the safe slide area');
  const allocations: DiagramAllocation[] = [];
  const preferredHeights = plan.topology === 'cycle' ? [220, 240, 260, 280, 300, 320, 340, 360] : [120, 160, 200, 240, 280, 320, 360];
  // The exact remaining height is a candidate too: the old 360px ceiling
  // incorrectly rejected plans that fit between 360px and the safe bottom.
  const heights = [...new Set([...preferredHeights.filter((height) => height <= maxHeight), maxHeight])].sort((a, b) => a - b);
  // Include full-width and side-by-side choices when the actual plan permits.
  const widths = [...new Set([maxWidth, 900, 700, 600, 440, 360, 320, 280].filter((width) => width <= maxWidth))];
  for (const width of widths) {
    for (const height of heights) {
      try {
        await compileMeasuredDiagram({ ...plan, type: 'diagram', id: 'planned-allocation', left, top, width, height }, textMeasure);
        allocations.push({ width, height });
        break;
      } catch (error) {
        // The first candidate can be shorter than the outside annotation's
        // measured text. That makes this rectangle infeasible, not the whole
        // teaching plan invalid; continue through the larger candidates.
        if (!isDiagramFitError(error)) throw error;
      }
    }
  }
  if (!allocations.length) throw new DiagramAllocationError('Invalid diagram component: planned diagram has no feasible measured allocation below the page heading', { availableArea });
  return allocations;
}
