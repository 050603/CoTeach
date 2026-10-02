import type { PPTElement, PPTLineElement, PPTTextElement, TeachingVisualComponent, VisualNode } from '@openmaic/dsl';
import type { DiagramPlan, TextMeasure, TextMeasureResult } from '@openmaic/generation/browser';
import { roundedVisualPanel } from './teaching-visual-primitives';
import { TEACHING_VISUAL_THEME as T } from './teaching-visual-theme';

export interface AdoptedGridRect { left: number; top: number; width: number; height: number }
export interface AdoptedGridResult {
  elements: PPTElement[];
  mapping: Record<string, string[]>;
  boxes: Map<string, AdoptedGridRect>;
  height: number;
}
type Point = [number, number];
type Edge = NonNullable<DiagramPlan['edges']>[number];
type Route = { start: Point; end: Point; controls?: [Point, Point] };
type Plan = { ids: string[]; edges: Edge[]; feedback?: Edge; branch: boolean };
const right = (box: AdoptedGridRect) => box.left + box.width;
const bottom = (box: AdoptedGridRect) => box.top + box.height;
const center = (box: AdoptedGridRect): Point => [box.left + box.width / 2, box.top + box.height / 2];
const escape = (value: string) => value.replace(/[&<>"']/gu, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);
const inside = (box: AdoptedGridRect, outer: AdoptedGridRect) => box.left >= outer.left && box.top >= outer.top
  && right(box) <= right(outer) + 0.01 && bottom(box) <= bottom(outer) + 0.01;
const overlaps = (a: AdoptedGridRect, b: AdoptedGridRect) => a.left < right(b) && b.left < right(a)
  && a.top < bottom(b) && b.top < bottom(a);

/** This candidate accepts a complete topology, never a convenient subset of it. */
function planFor(graph: DiagramPlan): Plan | null {
  const ids = graph.nodes.map((node) => node.id);
  if (ids.length !== 4 || new Set(ids).size !== 4 || graph.nodes.some((node) => !node.id || !node.label)
    || graph.sequenceGroups?.length) return null;
  const explicit = graph.edges ?? [];
  if (explicit.some((edge) => !ids.includes(edge.from) || !ids.includes(edge.to) || edge.from === edge.to)
    || new Set(explicit.map((edge) => `${edge.from}\0${edge.to}`)).size !== explicit.length) return null;
  const adjacent = ids.slice(0, -1).map((from, index) => ({ from, to: ids[index + 1]! }));
  const same = (a: Edge, b: Edge) => a.from === b.from && a.to === b.to;
  if (graph.topology === 'sequence') {
    if (explicit.some((edge) => !adjacent.some((part) => same(part, edge)))) return null;
    return { ids, edges: [...explicit, ...adjacent.filter((part) => !explicit.some((edge) => same(part, edge)))], branch: false };
  }
  if (graph.topology === 'cycle') {
    // An explicit feedback graph can have an exit. Do not infer a closing edge.
    if (explicit.length !== 4 || adjacent.some((part) => !explicit.some((edge) => same(part, edge)))) return null;
    const feedback = explicit.filter((edge) => !adjacent.some((part) => same(part, edge)));
    if (feedback.length !== 1 || ids.indexOf(feedback[0]!.from) <= ids.indexOf(feedback[0]!.to)) return null;
    return { ids, edges: explicit, feedback: feedback[0], branch: false };
  }
  if (graph.topology !== 'branch' || explicit.length !== 3) return null;
  const root = ids.find((id) => !explicit.some((edge) => edge.to === id));
  const rootEdges = explicit.filter((edge) => edge.from === root);
  if (!root || rootEdges.length !== 1) return null;
  const guard = rootEdges[0]!.to, children = explicit.filter((edge) => edge.from === guard);
  const outcomes = ids.filter((id) => id !== root && id !== guard);
  if (children.length !== 2 || outcomes.some((id) => !children.some((edge) => edge.to === id))) return null;
  return { ids: [root, guard, ...outcomes], edges: explicit, branch: true };
}

function noteHtml(node: VisualNode, originalLabel: string): { html: string; text: string } {
  const label = node.label !== originalLabel ? node.label : undefined;
  const pieces = [label, node.text].filter((value): value is string => Boolean(value));
  return { text: pieces.join('\n'), html: pieces.map((value, index) =>
    `<p style="margin:0;font-family:${T.font};font-size:20px;font-weight:${label && index === 0 ? 700 : 400};line-height:1.25;color:${T.text}">${escape(value).replace(/\n/gu, '<br>')}</p>`).join('') };
}

async function measuredText(measure: TextMeasure, html: string, text: string, width: number, fontSize: number,
  bold = false): Promise<TextMeasureResult> {
  const result = await measure({ html, text, width, fontSize, fontWeight: bold ? 700 : 400, fontFamily: T.font,
    padding: 10, lineHeight: 1.25, paragraphSpace: 0, align: 'left', preserveRichText: true });
  if (!Number.isFinite(result.height) || result.height <= 0 || !Number.isFinite(result.naturalWidth)
    || result.inkRight !== undefined && !Number.isFinite(result.inkRight)
    || result.inkBottom !== undefined && !Number.isFinite(result.inkBottom)) {
    throw new Error('Adopted grid measurement returned invalid geometry');
  }
  return result;
}

async function edgeLabel(componentId: string, edge: Edge, index: number, width: number, measure: TextMeasure): Promise<PPTTextElement | null> {
  if (!edge.label) return null;
  const content = `<p style="margin:0;font-family:${T.font};font-size:18px;font-weight:400;line-height:1.25;text-align:center;color:${T.blue}">${escape(edge.label).replace(/\n/gu, '<br>')}</p>`;
  let measured = await measuredText(measure, content, edge.label, width, 18);
  // Keep native padding plus a small font-substitution reserve. A caption
  // measured with only 2px spare wrapped in Office and obscured its own arrow.
  const tightWidth = Math.min(width, Math.ceil(measured.naturalWidth + 42));
  if (tightWidth < width) { width = tightWidth; measured = await measuredText(measure, content, edge.label, width, 18); }
  if ((measured.inkRight ?? 0) > width + 1) return null;
  return { id: `${componentId}-edge-label-${index}`, type: 'text', left: 0, top: 0, width,
    height: Math.ceil(Math.max(measured.height, measured.inkBottom ?? 0) + 1), rotate: 0, content,
    defaultFontName: T.font, defaultColor: T.blue, lineHeight: 1.25, paragraphSpace: 0, fill: T.background };
}

function pointOn(route: Route, fraction: number): Point {
  if (!route.controls) return [route.start[0] + (route.end[0] - route.start[0]) * fraction,
    route.start[1] + (route.end[1] - route.start[1]) * fraction];
  const u = 1 - fraction;
  return [0, 1].map((axis) => u ** 3 * route.start[axis]! + 3 * u ** 2 * fraction * route.controls![0][axis]!
    + 3 * u * fraction ** 2 * route.controls![1][axis]! + fraction ** 3 * route.end[axis]!) as Point;
}

function line(id: string, route: Route, feedback: boolean): PPTLineElement {
  const all = [route.start, route.end, ...(route.controls ?? [])];
  const left = Math.min(...all.map((point) => point[0])), top = Math.min(...all.map((point) => point[1]));
  const local = (point: Point): Point => [point[0] - left, point[1] - top];
  return { id, type: 'line', left, top, width: 2.4, start: local(route.start), end: local(route.end),
    ...(route.controls ? { cubic: [local(route.controls[0]), local(route.controls[1])] as [Point, Point] } : {}),
    points: ['', 'arrow'], style: feedback ? 'dashed' : 'solid', color: T.blue };
}

/** Four measured objects in an open, serpentine grid. All original labels and
 * anchored conditions remain editable native text; every edge is source-owned.
 * Unsupported topology or unavailable readable space is an ordinary null. */
export async function compileAdoptedGrid(component: TeachingVisualComponent, originalDiagram: DiagramPlan,
  bounds: AdoptedGridRect, measure: TextMeasure): Promise<AdoptedGridResult | null> {
  if (!component.useAdoptedDiagram || !Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const plan = planFor(originalDiagram);
  if (!plan) return null;
  const notes = new Map<string, VisualNode[]>();
  for (const node of component.nodes) {
    const anchor = node.anchorId ?? node.label ?? node.id;
    const matches = originalDiagram.nodes.filter((item) => item.id === anchor || item.label === anchor);
    if (matches.length !== 1 || !node.label && !node.text) return null;
    const id = matches[0]!.id;
    notes.set(id, [...(notes.get(id) ?? []), node]);
  }
  // Model-declared edges cannot quietly disappear into the adopted graph.
  for (const edge of component.edges ?? []) {
    const resolve = (id: string) => [...notes].find(([, nodes]) => nodes.some((node) => node.id === id))?.[0];
    if (!plan.edges.some((part) => part.from === resolve(edge.from) && part.to === resolve(edge.to)
      && (!edge.label || edge.label === part.label))) return null;
  }
  const labels = await Promise.all(plan.edges.map((edge, index) => edgeLabel(component.id, edge, index,
    Math.min(250, bounds.width / 3), measure)));
  if (plan.edges.some((edge, index) => edge.label && !labels[index])) return null;
  const labelFor = (from: number, to: number) => labels[plan.edges.findIndex((edge) => edge.from === plan.ids[from] && edge.to === plan.ids[to])];
  const feedbackFrom = plan.feedback ? plan.ids.indexOf(plan.feedback.from) : -1;
  const feedbackTo = plan.feedback ? plan.ids.indexOf(plan.feedback.to) : -1;
  // Diagonal feedback needs another routing family; never cross unrelated objects.
  if (plan.feedback && (feedbackFrom === 2 && feedbackTo === 0 || feedbackFrom === 3 && feedbackTo === 1)) return null;
  const feedbackLabel = plan.feedback ? labels[plan.edges.indexOf(plan.feedback)] : undefined;
  const leftLane = feedbackFrom === 3 && feedbackTo === 0 ? Math.max(58, (feedbackLabel?.width ?? 0) + 20) : 0;
  const rightLane = feedbackFrom === 2 && feedbackTo === 1 ? Math.max(58, (feedbackLabel?.width ?? 0) + 20) : 0;
  const topLane = Math.max(labelFor(0, 1) ? labelFor(0, 1)!.height + 26 : 0,
    feedbackFrom === 1 ? (feedbackLabel?.height ?? 22) + 26 : 0);
  const bottomLane = Math.max(!plan.branch && labelFor(2, 3) ? labelFor(2, 3)!.height + 26 : 0,
    feedbackFrom === 3 && feedbackTo === 2 ? (feedbackLabel?.height ?? 22) + 26 : 0);
  const gapX = 64, width = (bounds.width - leftLane - rightLane - gapX) / 2;
  if (width < 180) return null;
  // Opposite arrows must not share the same outer curve. A labeled adjacent
  // relation that cannot fit between its two objects needs another candidate.
  if (feedbackFrom === 1 && (labelFor(0, 1)?.width ?? 0) > gapX - 8
    || feedbackFrom === 3 && feedbackTo === 2 && (labelFor(2, 3)?.width ?? 0) > gapX - 8) return null;
  const measuredNodes = await Promise.all(plan.ids.map(async (id) => {
    const original = originalDiagram.nodes.find((node) => node.id === id)!;
    const noteParts = (notes.get(id) ?? []).map((node) => noteHtml(node, original.label));
    const html = `<p style="margin:0;font-family:${T.font};font-size:24px;font-weight:700;line-height:1.25;color:${T.blue}">${escape(original.label).replace(/\n/gu, '<br>')}</p>${noteParts.map((part) => part.html).join('')}`;
    const value = [original.label, ...noteParts.map((part) => part.text).filter(Boolean)].join('\n');
    const measured = await measuredText(measure, html, value, width, 24, true);
    return { id, html, height: Math.ceil(Math.max(measured.height, measured.inkBottom ?? 0) + 2), fits: (measured.inkRight ?? 0) <= width + 1 };
  }));
  if (measuredNodes.some((node) => !node.fits)) return null;
  const upperHeight = Math.max(...measuredNodes.slice(0, 2).map((node) => node.height));
  const lowerHeight = Math.max(...measuredNodes.slice(2).map((node) => node.height));
  const middleLabels = plan.branch ? [labelFor(1, 2), labelFor(1, 3)] : [labelFor(1, 2), feedbackLabel];
  const gapY = Math.max(64, ...middleLabels.map((label) => label ? label.height + 24 : 0));
  const height = topLane + upperHeight + gapY + lowerHeight + bottomLane;
  if (height > bounds.height) return null;
  const x = bounds.left + leftLane, y = bounds.top + topLane;
  const rects = [
    { left: x, top: y, width, height: upperHeight }, { left: x + width + gapX, top: y, width, height: upperHeight },
    { left: plan.branch ? x : x + width + gapX, top: y + upperHeight + gapY, width, height: lowerHeight },
    { left: plan.branch ? x + width + gapX : x, top: y + upperHeight + gapY, width, height: lowerHeight },
  ];
  const elements: PPTElement[] = [], mapping: Record<string, string[]> = {}, boxes = new Map<string, AdoptedGridRect>();
  const assign = (source: string, id: string) => { mapping[source] = [...new Set([...(mapping[source] ?? []), id])]; };
  for (const [index, node] of measuredNodes.entries()) {
    const shape = roundedVisualPanel(`${component.id}-node-${node.id}`, rects[index]!, index === 3 && !plan.branch ? T.mint : T.pale, 16);
    shape.groupId = component.id;
    shape.text = { content: node.html, defaultFontName: T.font, defaultColor: T.text, align: 'middle', lineHeight: 1.25, paragraphSpace: 0 };
    elements.push(shape); boxes.set(`original:${node.id}`, rects[index]!);
    assign(`diagram-node:${node.id}`, shape.id);
    for (const note of notes.get(node.id) ?? []) for (const source of note.sourceContentIds) assign(source, shape.id);
  }
  const labelRects: AdoptedGridRect[] = [];
  const routes: Array<{ index: number; route: Route }> = [];
  for (const [index, edge] of plan.edges.entries()) {
    const from = plan.ids.indexOf(edge.from), to = plan.ids.indexOf(edge.to);
    const a = rects[from]!, b = rects[to]!, ac = center(a), bc = center(b), label = labels[index];
    const feedback = edge === plan.feedback;
    let route: Route;
    if (feedback && from === 2 && to === 1) route = { start: [right(a), ac[1]], end: [right(b), bc[1]],
      controls: [[right(a) + rightLane - 3, ac[1]], [right(b) + rightLane - 3, bc[1]]] };
    else if (feedback && from === 3 && to === 0) route = { start: [a.left, ac[1]], end: [b.left, bc[1]],
      controls: [[a.left - leftLane + 3, ac[1]], [b.left - leftLane + 3, bc[1]]] };
    else if ((from === 0 && to === 1 && label && feedbackFrom !== 1) || feedback && from === 1 && to === 0) route = {
      start: [ac[0], a.top], end: [bc[0], b.top], controls: [[ac[0], a.top - topLane + 3], [bc[0], b.top - topLane + 3]] };
    else if ((!plan.branch && from === 2 && to === 3 && label && !(feedbackFrom === 3 && feedbackTo === 2)) || feedback && from === 3 && to === 2) route = {
      start: [ac[0], bottom(a)], end: [bc[0], bottom(b)],
      controls: [[ac[0], bottom(a) + bottomLane - 3], [bc[0], bottom(b) + bottomLane - 3]] };
    else if (from === 0 && to === 1) route = { start: [right(a), ac[1]], end: [b.left, bc[1]] };
    else if (!plan.branch && from === 2 && to === 3) route = { start: [a.left, ac[1]], end: [right(b), bc[1]] };
    else if (plan.branch && from === 1 && to === 2) route = { start: [a.left + width * 0.22, bottom(a)], end: [bc[0], b.top],
      controls: [[a.left + width * 0.22, bottom(a) + gapY / 2], [bc[0], b.top - gapY / 2]] };
    else route = { start: [ac[0] + (plan.branch ? width * 0.2 : 0), bottom(a)],
      end: [bc[0] + (plan.branch ? width * 0.2 : 0), b.top] };
    // Sample the actual rendered cubic, not its bounding control polygon.
    for (let step = 1; step < 64; step++) {
      const point = pointOn(route, step / 64);
      if (point[0] < bounds.left || point[0] > right(bounds) || point[1] < bounds.top || point[1] > bottom(bounds)
        || rects.some((rect) => point[0] > rect.left + 0.5 && point[0] < right(rect) - 0.5
          && point[1] > rect.top + 0.5 && point[1] < bottom(rect) - 0.5)) return null;
    }
    elements.push({ ...line(`${component.id}-edge-${index}`, route, feedback), groupId: component.id });
    routes.push({ index, route });
    if (label) {
      const mid = pointOn(route, 0.5);
      label.left = mid[0] - label.width / 2; label.top = mid[1] - label.height / 2; label.groupId = component.id;
      // Vertical feedback labels live outside the objects, within the measured lane.
      if (feedback && from === 2 && to === 1) label.left = right(a) + 8;
      if (feedback && from === 3 && to === 0) label.left = a.left - label.width - 8;
      if (!inside(label, bounds) || rects.some((rect) => overlaps(label, rect)) || labelRects.some((rect) => overlaps(label, rect))) return null;
      labelRects.push(label); elements.push(label); boxes.set(label.id, label);
    }
  }
  // White labels may interrupt their own arrow, but cannot mask another
  // relationship. Use the text's actual padded ink area for that distinction.
  for (const { index, route } of routes) for (const [labelIndex, label] of labels.entries()) {
    if (!label || index === labelIndex) continue;
    for (let step = 1; step < 64; step++) {
      const [px, py] = pointOn(route, step / 64);
      if (px > label.left + 10 && px < right(label) - 10 && py > label.top + 8 && py < bottom(label) - 8) return null;
    }
  }
  return { elements: [...elements.filter((element) => element.type === 'line'),
    ...elements.filter((element) => element.type === 'shape'), ...elements.filter((element) => element.type === 'text')], mapping, boxes, height };
}
