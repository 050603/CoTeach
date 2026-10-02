/** Browser-safe semantic visual compiler. All text is measured with the same
 * fonts and box model as playback. A layout miss is not a technical failure. */
import type { PPTElement, PPTTextElement, PPTShapeElement, PPTLineElement, PPTImageElement,
  PPTTableElement, PPTChartElement, TableCell, SlidePresentationProjection,
  TeachingVisualComponent, TeachingVisualComponentKind, TeachingVisualPage,
  TeachingVisualScene, TeachingVisualMetadata, VisualNode, VisualEdge } from '@openmaic/dsl';
import { compileMeasuredDiagramComponent, DiagramAllocationError, measureDiagramAllocations,
  type TextMeasure, type DiagramPlan } from '@openmaic/generation/browser';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { TEACHING_VISUAL_THEME as T, TEACHING_VISUAL_COMPILER_VERSION,
  TEACHING_VISUAL_THEME_VERSION, teachingVisualSlideTheme } from './teaching-visual-theme';
import { roundedVisualPanel, semanticVisualIcon, visualCircle, visualIcon, visualLearner } from './teaching-visual-primitives';
import { balanceTeachingText } from './teaching-visual-text-wrap';
import { renderableAdoptedDiagramPlan } from './adopted-diagram-plan';
import { compileAdoptedGrid } from './teaching-visual-adopted-grid';

export type VisualRect = { left: number; top: number; width: number; height: number };
export type TeachingVisualImage = { id: string; src: string; width: number; height: number; caption?: string };
export type TeachingVisualCompilerOptions = {
  measure: TextMeasure;
  images?: TeachingVisualImage[];
  sourceCatalog?: Array<{ id: string; text: string }>;
  previous?: GeneratedSlideContent;
  preferredCandidateId?: string;
  allowedCandidateIds?: readonly string[];
  recentCandidateIds?: readonly string[];
  allowSplit?: boolean;
};
type Context = TeachingVisualCompilerOptions & { outline: SceneOutline; page?: TeachingVisualPage; variant: number };
type Block = { elements: PPTElement[]; mapping: Record<string, string[]>; boxes: Map<string, VisualRect>; height: number };
export interface VisualComponentDefinition {
  kind: TeachingVisualComponentKind;
  layout(component: TeachingVisualComponent, bounds: VisualRect, variant: number): VisualRect;
  measure(component: TeachingVisualComponent, bounds: VisualRect, context: Context): Promise<Block | null>;
  compile(measured: Block): PPTElement[];
}
const empty = (): Block => ({ elements: [], mapping: {}, boxes: new Map(), height: 0 });
const escape = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/\n/gu, '<br>');
const right = (r: VisualRect) => r.left + r.width;
const bottom = (r: VisualRect) => r.top + r.height;
const overlap = (a: VisualRect, b: VisualRect) => a.left < right(b) - 1 && b.left < right(a) - 1 && a.top < bottom(b) - 1 && b.top < bottom(a) - 1;
const inside = (a: VisualRect, b: VisualRect) => a.left >= b.left - 1 && a.top >= b.top - 1 && right(a) <= right(b) + 1 && bottom(a) <= bottom(b) + 1;
function map(block: Block, sources: readonly string[], ids: readonly string[]) {
  for (const source of sources) block.mapping[source] = [...new Set([...(block.mapping[source] ?? []), ...ids])];
}
function merge(target: Block, source: Block) {
  target.elements.push(...source.elements);
  for (const [id, box] of source.boxes) target.boxes.set(id, box);
  for (const [id, elements] of Object.entries(source.mapping)) map(target, [id], elements);
  target.height = Math.max(target.height, source.height);
}
function shape(id: string, box: VisualRect, fill: string, path?: string, outline?: string): PPTShapeElement {
  return { id, type: 'shape', ...box, rotate: 0, fixedRatio: false, viewBox: [box.width, box.height],
    path: path ?? `M0 0H${box.width}V${box.height}H0Z`, fill,
    ...(outline ? { outline: { color: outline, width: 1.5, style: 'solid' as const } } : {}) };
}
function line(id: string, a: [number, number], b: [number, number], color: string = T.blue,
  arrow = true, dashed = false): PPTLineElement {
  const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
  return { id, type: 'line', left, top, width: 2, start: [a[0] - left, a[1] - top],
    end: [b[0] - left, b[1] - top], points: ['', arrow ? 'arrow' : ''], color, style: dashed ? 'dashed' : 'solid' };
}
function marked(text: string, terms: readonly string[] = []) {
  const selected = [...new Set(terms.filter((term) => term && text.includes(term)))].sort((a, b) => b.length - a.length);
  let result = '', i = 0;
  while (i < text.length) {
    const term = selected.find((value) => text.startsWith(value, i));
    if (term) { result += `<strong style="color:${T.teal}">${escape(term)}</strong>`; i += term.length; }
    else { result += escape(text[i]!); i++; }
  }
  return result;
}
async function text(id: string, value: string, box: Pick<VisualRect, 'left' | 'top' | 'width'>,
  context: Context, options: { size?: number; bold?: boolean; color?: string; align?: 'left' | 'center'; emphasis?: string[]; html?: string; lineHeight?: number; fitWidth?: boolean } = {}): Promise<PPTTextElement> {
  const size = options.size ?? T.body, color = options.color ?? T.text, align = options.align ?? 'left';
  const lineHeight = options.lineHeight ?? 1.25;
  const render = (display: string) => `<p style="margin:0;font-family:${T.font};font-size:${size}px;font-weight:${options.bold ? 700 : 400};line-height:${lineHeight};color:${color};text-align:${align}">${marked(display, options.emphasis)}</p>`;
  let content = options.html ?? render(value);
  const input = { html: content, text: value, width: box.width, fontSize: size,
    fontWeight: options.bold ? 700 : 400, fontFamily: T.font, padding: 10, lineHeight,
    paragraphSpace: 0, align, preserveRichText: true } as const;
  let measured = await context.measure(input);
  if (!Number.isFinite(measured.height) || measured.height <= 0 || !Number.isFinite(measured.naturalWidth)) throw new Error('Teaching visual measurement returned invalid geometry');
  if (!options.html) {
    const balanced = await balanceTeachingText(value, input, measured, context.measure, render);
    content = balanced.html; measured = balanced.measurement;
  }
  if ((measured.inkRight ?? 0) > box.width + 1) throw new VisualCapacityMiss();
  if (options.fitWidth && measured.naturalWidth + 21 < box.width) return text(id, value,
    { ...box, width: Math.ceil(measured.naturalWidth + 21) }, context, { ...options, fitWidth: false });
  return { id, type: 'text', ...box, height: Math.ceil(Math.max(measured.height, measured.inkBottom ?? 0) + 1),
    rotate: 0, content, defaultColor: color, defaultFontName: T.font, lineHeight, paragraphSpace: 0 };
}
class VisualCapacityMiss extends Error {}
// Native text boxes include 10px side padding. Neighbouring padding may
// overlap; the measured teaching text must remain inside its own column.
const textInkBox = (element: PPTTextElement): VisualRect => ({ ...element,
  left: element.left + 10, width: Math.max(0, element.width - 20),
  top: element.top + 8, height: Math.max(0, element.height - 16) });
function recordText(block: Block, element: PPTTextElement) {
  block.elements.push(element); block.boxes.set(element.id, textInkBox(element));
}

/** An explicit simple sequence gets one reading axis. Branches, loops and
 * parallel tracks continue through their topology-specific compiler. */
async function iconSequence(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const original = component.useAdoptedDiagram ? context.outline.visualIntent?.diagram : undefined;
  if (component.useAdoptedDiagram && (!original || original.topology !== 'sequence'
    || (original.sequenceGroups?.length ?? 0) > 1)) return null;
  const nodes = original?.nodes ?? component.nodes;
  const edges: VisualEdge[] = original ? nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1]!.id,
    ...original.edges?.find((edge) => edge.from === node.id && edge.to === nodes[index + 1]!.id) })) : component.edges ?? [];
  if (nodes.length < 2 || nodes.length > 6 || edges.length !== nodes.length - 1
    || !nodes.slice(1).every((node, index) => edges.some((edge) => edge.from === nodes[index]!.id && edge.to === node.id))
    || original?.edges?.some((edge) => !edges.some((actual) => actual.from === edge.from && actual.to === edge.to))) return null;
  const cell = box.width / nodes.length;
  if (cell < 145) return null;
  const block = empty(), plates: PPTShapeElement[] = [];
  const plateTop = box.top + 12, diameter = 72, notesTop = plateTop + diameter + 6;
  let occupiedBottom = notesTop;
  for (const [index, node] of nodes.entries()) {
    const cx = box.left + cell * (index + 0.5);
    const notes = original ? component.nodes.filter((note) => (note.anchorId ?? note.label ?? note.id) === node.id
      || (note.anchorId ?? note.label ?? note.id) === node.label) : [node as VisualNode];
    if (original && component.nodes.some((note) => !original.nodes.some((item) =>
      [item.id, item.label].includes(note.anchorId ?? note.label ?? note.id)))) return null;
    const semantic = notes[0], accent = notes.some((note) => note.emphasis?.includes(node.label ?? ''));
    const color = accent ? T.teal : T.blue;
    const objectId = original ? `${component.id}-node-${node.id}` : `${node.id}:object`;
    const plate = visualCircle(objectId, cx - diameter / 2, plateTop, diameter, accent ? T.mint : T.pale);
    block.elements.push(plate); plates.push(plate); block.boxes.set(`${node.id}:visual`, plate);
    const icon = semantic?.icon ?? semanticVisualIcon(node.label ?? '');
    if (icon) block.elements.push(visualIcon(`${objectId}:icon`, icon, cx - 23, plateTop + 13, 46, color));
    else block.elements.push(visualCircle(`${objectId}:dot`, cx - 5, plateTop + 31, 10, color));
    const caption = await text(original ? `${objectId}:label` : `${node.id}:label`, node.label ?? '',
      { left: cx - cell / 2 - 10, top: notesTop, width: cell + 20 }, context,
      { size: T.label, bold: true, color, align: 'center' });
    if (caption.height > T.label * 2.5 + 24) return null;
    recordText(block, caption);
    if (original) map(block, [`diagram-node:${node.id}`], [plate.id, caption.id]);
    let y = bottom(caption) + 2;
    for (const note of notes) {
      const value = [note.label && note.label !== node.label ? note.label : undefined, note.text].filter(Boolean).join('\n');
      const ids = [caption.id];
      if (value) {
        const description = await text(note.id, value,
          { left: cx - cell / 2 - 10, top: y, width: cell + 20 }, context,
          { align: 'center', emphasis: note.emphasis });
        recordText(block, description); ids.push(description.id); y = bottom(description) + 4;
      }
      map(block, note.sourceContentIds, ids);
    }
    // Long explanations belong to another composition, never a tiny font or
    // a paragraph squeezed beneath every icon.
    if (y - bottom(caption) > T.body * 2.5 + 30 || y > bottom(box) + 1) return null;
    occupiedBottom = Math.max(occupiedBottom, y);
  }
  for (const [index, edge] of edges.entries()) {
    const from = plates[index]!, to = plates[index + 1]!, y = plateTop + diameter / 2;
    const id = original ? `${component.id}-edge-${index}` : `${component.id}:edge-${index}`;
    block.elements.unshift(line(id, [right(from) + 2, y], [to.left - 2, y], T.blue));
    if (edge.label) {
      const label = await text(original ? `${component.id}-edge-label-${index}` : `${id}:label`, edge.label,
        { left: right(from) - 10, top: plateTop, width: to.left - right(from) + 20 }, context,
        { size: T.minimum, align: 'center', fitWidth: true });
      label.top = y - label.height - 8;
      if (!inside(label, box) || [...block.boxes.values()].some((rect) => overlap(rect, textInkBox(label)))) return null;
      recordText(block, label);
    }
  }
  block.height = occupiedBottom - box.top;
  return block;
}

/** Support is adjacent explanatory text, not an invented arrow into a graph.
 * All labels/conditions remain visible native text and retain their source IDs. */
async function supportPanel(component: TeachingVisualComponent, box: VisualRect, context: Context,
  alignRow = false): Promise<Block | null> {
  if (component.kind !== 'text' || component.edges?.length) return null;
  const block = empty(), takeaway = component.role === 'takeaway';
  let y = box.top + 4;
  if (!takeaway && component.title && component.title !== context.page?.title) {
    const heading = await text(`${component.id}:title`, component.title,
      { left: box.left + 14, top: y, width: box.width - 28 }, context,
      { size: T.body, bold: true, color: takeaway ? T.warm : T.teal });
    recordText(block, heading); y = bottom(heading) - 10;
  }
  // Two named properties use the width of a broad panel instead of reserving
  // two full-height rows below the primary object. Narrow owned panels keep
  // their original stacked reading order (for example, who/what assessment).
  if (!takeaway && component.nodes.length === 2 && box.width >= 650
    && component.nodes.every((node) => node.label)) {
    const width = (box.width - 48) / 2;
    const labels = await Promise.all(component.nodes.map((node, index) => {
      const value = [node.label, node.text].filter(Boolean).join('：');
      const html = `<p style="margin:0;font-family:${T.font};font-size:${T.body}px;line-height:1.25;color:${T.text}"><strong>${escape(node.label!)}</strong>${node.text ? `：${marked(node.text, node.emphasis)}` : ''}</p>`;
      return text(node.id, value, { left: box.left + 14 + index * (width + 20), top: y, width }, context, { html });
    }));
    block.height = Math.max(...labels.map(bottom)) - box.top + 4;
    if (block.height > box.height) return null;
    if (alignRow) block.height = box.height;
    for (const [index, element] of labels.entries()) {
      recordText(block, element); map(block, component.nodes[index]!.sourceContentIds, [element.id]);
    }
    block.elements.unshift(roundedVisualPanel(`${component.id}:panel`, { ...box, height: block.height }, T.mint));
    return block;
  }
  // Three or more adjacent conditions share a native text frame. This removes
  // repeated textbox padding, keeping the full paragraphs and all source maps.
  if (component.nodes.length >= 3) {
    const paragraphs: string[] = [];
    for (const node of component.nodes) {
      const value = [node.label, node.text].filter(Boolean).join('：');
      const render = (display: string) => `<p style="margin:0;font-family:${T.font};font-size:${T.body}px;line-height:1.25;color:${T.text}">${node.label && display.startsWith(node.label)
        ? `<strong>${escape(node.label)}</strong>${marked(display.slice(node.label.length), node.emphasis)}` : marked(display, node.emphasis)}</p>`;
      const input = { html: render(value), text: value, width: box.width - 28, fontSize: T.body,
        fontWeight: 400, fontFamily: T.font, padding: 10, lineHeight: 1.25,
        paragraphSpace: 0, align: 'left', preserveRichText: true } as const;
      const measured = await context.measure(input);
      if (!Number.isFinite(measured.height) || measured.height <= 0 || !Number.isFinite(measured.naturalWidth)) throw new Error('Teaching visual measurement returned invalid geometry');
      paragraphs.push((await balanceTeachingText(value, input, measured, context.measure, render)).html);
    }
    const html = paragraphs.join('');
    const value = component.nodes.map((node) => [node.label, node.text].filter(Boolean).join('：')).join('\n');
    const element = await text(component.nodes[0]!.id, value,
      { left: box.left + 14, top: y, width: box.width - 28 }, context, { html });
    recordText(block, element);
    for (const node of component.nodes) {
      map(block, node.sourceContentIds, [element.id]);
      if (node.id !== element.id) block.elements.push({ ...shape(node.id, {
        left: element.left, top: element.top, width: element.width, height: element.height }, 'none'), opacity: 0 });
    }
    block.height = bottom(element) - box.top + 4;
    if (block.height > box.height) return null;
    if (alignRow) block.height = box.height;
    block.elements.unshift(roundedVisualPanel(`${component.id}:panel`, { ...box, height: block.height }, T.mint));
    return block;
  }
  for (const [index, node] of component.nodes.entries()) {
    const color = takeaway && index === 0 ? T.warm : T.text;
    const size = takeaway && index === 0 ? 22 : T.body;
    const label = node.label ? `<strong style="font-size:${size}px;color:${color}">${escape(node.label)}</strong>` : '';
    const body = node.text ? marked(node.text, node.emphasis) : '';
    const html = `<p style="margin:0;font-family:${T.font};font-size:${size}px;line-height:1.25;color:${color};${takeaway && index === 0 ? 'font-weight:700;' : ''}">${label}${label && body ? '：' : ''}${body}</p>`;
    const element = await text(node.id, [node.label, node.text].filter(Boolean).join('：'),
      { left: box.left + 14, top: y, width: box.width - 28 }, context, { size, html });
    recordText(block, element); map(block, node.sourceContentIds, [element.id]); y = bottom(element) - 10;
  }
  block.height = y - box.top + 14;
  if (block.height > box.height) return null;
  if (alignRow) block.height = box.height;
  block.elements.unshift(roundedVisualPanel(`${component.id}:panel`, { ...box, height: block.height }, takeaway ? T.warmPale : T.mint));
  return block;
}
async function nodeText(node: VisualNode, box: VisualRect, context: Context, compact = false, align: 'left' | 'center' = 'left'): Promise<Block | null> {
  const block = empty();
  const labelSize = T.label;
  // Models often repeat the entire label verbatim at the start of the prose.
  // Display the exact prose once with that same label emphasized inside it.
  const included = node.label && node.text?.includes(node.label) ? node.text.indexOf(node.label) : -1;
  const content = included >= 0
    ? `${marked(node.text!.slice(0, included), node.emphasis)}<strong style="font-size:${labelSize}px;color:${T.blue}">${escape(node.label!)}</strong>${marked(node.text!.slice(included + node.label!.length), node.emphasis)}`
    : `${node.label
    ? `<strong style="font-size:${labelSize}px;color:${T.blue}">${escape(node.label)}</strong>${node.text ? compact ? ' · ' : '<br>' : ''}` : ''}${node.text ? marked(node.text, node.emphasis) : ''}`;
  const html = `<p style="font-size:${T.body}px;color:${T.text};text-align:${align}">${content}</p>`;
  const element = await text(node.text ? node.id : `${node.id}:label`, [node.label, node.text].filter(Boolean).join(compact ? ' · ' : '\n'), box, context,
    { size: node.text ? T.body : labelSize, html, align, lineHeight: 1.25 });
  if (bottom(element) > bottom(box) + 1) return null;
  block.elements.push(element); block.boxes.set(element.id, element);
  map(block, node.sourceContentIds, [element.id]);
  block.height = element.height;
  return block;
}

async function prose(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const block = empty(); let y = box.top, lastGap = 10;
  const gutter = component.edges?.length ? 18 : 0;
  for (const node of component.nodes) {
    const child = await nodeText(node, { ...box, width: box.width - gutter, top: y, height: bottom(box) - y }, context, true);
    if (!child) return null;
    lastGap = await relationGap(component, node.id, box.width - gutter, context);
    merge(block, child); y += child.height + lastGap;
  }
  block.height = component.nodes.length ? y - box.top - (lastGap === 10 ? 10 : 4) : 0;
  if (block.height > box.height) return null;
  return block;
}

async function relationGap(component: TeachingVisualComponent, from: string, width: number, context: Context): Promise<number> {
  const targets = new Set(component.nodes.map((node) => node.id));
  let height = 0;
  for (const edge of component.edges ?? []) if (edge.from === from && targets.has(edge.to) && edge.label) {
    const label = await text('measure-relation', edge.label, { left: 0, top: 0, width: Math.min(220, width) }, context,
      { size: T.minimum, fitWidth: true, lineHeight: 1.2 });
    height += label.height + 8;
  }
  return Math.max(10, height);
}

/** Explicit associations between annotations use the reserved outer gutter.
 * A matrix cell needs a cell-specific route; its table box cannot stand in for it. */
async function connectAnnotations(component: TeachingVisualComponent, block: Block, box: VisualRect, context: Context): Promise<boolean> {
  const labelOffsets = new Map<string, number>();
  for (const [index, edge] of (component.edges ?? []).entries()) {
    if (component.nodes.some((node) => (node.id === edge.from || node.id === edge.to) && (node.row || node.column))) return false;
    const from = block.boxes.get(edge.from) ?? block.boxes.get(`${edge.from}:label`);
    const to = block.boxes.get(edge.to) ?? block.boxes.get(`${edge.to}:label`);
    if (!from || !to) return false;
    const x = Math.max(right(from), right(to)) + 8 + index % 2 * 4;
    if (x > right(box)) return false;
    const a: [number, number] = [right(from), from.top + from.height / 2], b: [number, number] = [right(to), to.top + to.height / 2];
    block.elements.unshift(line(`${component.id}:edge-${index}:leg-1`, a, [x, a[1]], T.blue, false),
      line(`${component.id}:edge-${index}:leg-2`, [x, a[1]], [x, b[1]], T.blue, false),
      line(`${component.id}:edge-${index}`, [x, b[1]], b, T.blue, edge.kind !== 'containment'));
    if (edge.label) {
      const label = await text(`${component.id}:edge-${index}:label`, edge.label,
        { left: from.left, top: bottom(from) + 4 + (labelOffsets.get(edge.from) ?? 0), width: Math.min(220, from.width) }, context,
        { size: T.minimum, fitWidth: true, lineHeight: 1.2, color: T.muted });
      label.left = right(from) - label.width;
      if (!inside(label, box) || [...block.boxes.values()].some((rect) => overlap(rect, label))) return false;
      labelOffsets.set(edge.from, (labelOffsets.get(edge.from) ?? 0) + label.height + 8);
      block.elements.push(label); block.boxes.set(label.id, label);
      block.elements.unshift(line(`${component.id}:edge-${index}:label-guide`,
        [right(label), label.top + label.height / 2], [x, label.top + label.height / 2], T.line, false));
    }
  }
  return true;
}

async function titledProse(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const block = empty(), titleWidth = Math.min(220, box.width / 4);
  const heading = await text(`${component.id}:title`, component.title!, { ...box, width: titleWidth - 10 }, context,
    { size: T.label, bold: true, color: T.blue, lineHeight: 1.25 });
  block.elements.push(heading); block.boxes.set(heading.id, heading);
  let y = box.top, lastGap = 10;
  const gutter = component.edges?.length ? 18 : 0;
  for (const [index, node] of component.nodes.entries()) {
    const child = await nodeText(node, { left: box.left + (index ? 0 : titleWidth), top: y,
      width: box.width - (index ? 0 : titleWidth) - gutter, height: bottom(box) - y }, context, true);
    if (!child) return null;
    merge(block, child);
    lastGap = await relationGap(component, node.id, box.width - (index ? 0 : titleWidth) - gutter, context);
    y += Math.max(child.height, index ? 0 : heading.height) + lastGap;
  }
  block.height = Math.max(heading.height, y - box.top - (lastGap === 10 ? 10 : 4));
  if (block.height > box.height) return null;
  return block;
}

/** Qualitative state changes have no invented axes or measured curve. */
async function states(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  if (!component.nodes.length) return null;
  // The other candidates use measured connected states rather than repeating
  // the same fixed icon strip at three slightly narrower widths.
  if (context.variant > 0) return network(component, box, context);
  // A return transition is a real cycle, rather than a left-to-right progression.
  if (component.edges?.some((edge) => component.nodes.findIndex((node) => node.id === edge.to)
    !== component.nodes.findIndex((node) => node.id === edge.from) + 1)) return network(component, box, context);
  const block = empty(), columns = component.nodes.length, gap = 24;
  const subject = component.nodes.map((node) => [node.label, node.text].filter(Boolean).join(' ')).join(' ');
  const learningSupport = /支架|scaffold/iu.test(subject) && /学生|学习者|learner|student/iu.test(subject)
    && /独立解决|自主学习|潜在水平|学习能力|independent|learning/iu.test(subject);
  const supportLevels = component.nodes.map((node) => node.supportLevel ?? (learningSupport
    ? /在场|需要支持|尚需帮助|supported|with support|still needs (?:help|support)/iu.test([node.label, node.text].join(' ')) ? 'present'
      : /撤离|撤出|withdrawn|removed/iu.test(node.label ?? '') ? 'withdrawn'
        : /渐退|渐消|逐渐减少|fading|fade/iu.test([node.label, node.text].join(' ')) ? 'fading'
          : undefined : undefined));
  const width = (box.width - gap * (columns - 1)) / columns;
  if (width < 145 || box.height < 200) return null;
  const labelElements: PPTTextElement[] = [];
  for (const [i, node] of component.nodes.entries()) {
    const label = await text(`${node.id}:label`, node.label ?? node.text ?? '',
      { left: box.left + i * (width + gap), top: box.top, width }, context,
      { size: T.label, bold: true, color: T.blue, align: 'center' });
    labelElements.push(label);
  }
  const labelsBottom = Math.max(...labelElements.map(bottom));
  const graphicTop = labelsBottom + 8, graphicHeight = 100;
  let descriptionsBottom = graphicTop + graphicHeight;
  for (const [i, node] of component.nodes.entries()) {
    const x = box.left + i * (width + gap), cx = x + width / 2;
    const label = labelElements[i]!;
    block.elements.push(label); block.boxes.set(label.id, label);
    const supportLevel = supportLevels[i];
    if (supportLevel || learningSupport) block.elements.push(...visualLearner(node.id, cx + 26, graphicTop));
    else if (node.icon) {
      block.elements.push(visualCircle(`${node.id}:state-object`, cx - 40, graphicTop + 8, 80, T.pale),
        visualIcon(`${node.id}:icon`, node.icon, cx - 26, graphicTop + 22, 52));
    } else block.elements.push(roundedVisualPanel(`${node.id}:state-object`,
      { left: cx - 55, top: graphicTop + 12, width: 110, height: 76 }, T.pale));
    if (supportLevel && supportLevel !== 'withdrawn') {
      const support = roundedVisualPanel(`${node.id}:support`,
        { left: cx - 70, top: graphicTop + 36, width: 55, height: 52 }, T.pale, 8);
      support.outline = { color: T.blue, width: 1.5, style: 'solid' };
      if (supportLevel === 'fading') { support.opacity = 0.4; support.outline.style = 'dashed'; }
      block.elements.push(support);
      for (let clue = 0; clue < 3; clue++) block.elements.push(line(`${node.id}:clue-${clue}`,
        [cx - 59, graphicTop + 51 + clue * 11], [cx - 28 - clue * 6, graphicTop + 51 + clue * 11],
        supportLevel === 'fading' ? T.line : T.blue, false));
    }
    const graphicBox = { left: x + 10, top: graphicTop, width: width - 20, height: graphicHeight };
    block.boxes.set(`${node.id}:visual`, graphicBox);
    const descriptionTop = graphicTop + graphicHeight + 8;
    const description = node.text ? await text(node.id, node.text,
      { left: x, top: descriptionTop, width }, context, { emphasis: node.emphasis, align: 'center' }) : undefined;
    if (description && bottom(description) > bottom(box) - 44) return null;
    if (description) { block.elements.push(description); block.boxes.set(description.id, description); }
    descriptionsBottom = Math.max(descriptionsBottom, description ? bottom(description) : descriptionTop);
    map(block, node.sourceContentIds, [label.id, ...(description ? [description.id] : [])]);
  }
  // Only authored transitions become arrows. Adjacent states need not be causal.
  for (const [i, edge] of (component.edges ?? []).entries()) {
    const from = component.nodes.findIndex((node) => node.id === edge.from), to = component.nodes.findIndex((node) => node.id === edge.to);
    if (from < 0 || to < 0) return null;
    const y = graphicTop + graphicHeight / 2;
    const inset = Math.min(110, width * 0.4);
    block.elements.push(line(`${component.id}:edge-${i}`, [box.left + from * (width + gap) + width / 2 + inset, y],
      [box.left + to * (width + gap) + width / 2 - inset, y], T.blue));
    if (edge.label) {
      const label = await text(`${component.id}:edge-${i}:label`, edge.label,
        { left: 0, top: 0, width: Math.min(220, width) }, context, { size: T.minimum, align: 'center', fitWidth: true, lineHeight: 1.2 });
      label.left = box.left + (Math.min(from, to) + 1) * (width + gap) - gap / 2 - label.width / 2;
      label.top = y - label.height - 8;
      if (label.top < graphicTop || !inside(label, box)) return null;
      block.elements.push(label); block.boxes.set(label.id, label);
    }
  }
  const note = await text(`${component.id}:qualitative`, supportLevels.some(Boolean)
    ? '状态示意 · 非固定发展阶段' : '状态示意',
    { left: box.left, top: box.top, width: box.width }, context, { size: T.minimum, color: T.muted });
  note.top = descriptionsBottom + 4;
  if (bottom(note) > bottom(box)) return null;
  if ([...block.boxes.values()].some((rect) => overlap(rect, note))) return null;
  block.elements.push(note); block.boxes.set(note.id, note); block.height = bottom(note) - box.top;
  return block;
}

async function diagram(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const original = context.outline.visualIntent?.diagram;
  if (component.useAdoptedDiagram && !original) return null;
  const sequence = await iconSequence(component, box, context);
  if (sequence) return sequence;
  const block = empty();
  if (component.useAdoptedDiagram && original) {
    const grid = await compileAdoptedGrid(component, original, box, context.measure);
    if (grid) return grid;
    // The legacy graph compiler has its own 50px safe frame. Respect that
    // measured contract when a complex topology cannot use the open strip.
    const left = Math.max(50, box.left), top = Math.max(50, box.top);
    box = { left, top, width: Math.min(950, right(box)) - left,
      height: Math.min(512.5, bottom(box)) - top };
    if (box.width <= 0 || box.height <= 0) return null;
    const notes = component.nodes;
    const anchor = (key: string) => original.nodes.find((node) => node.id === key || node.label === key);
    // A tall branch or feedback graph is read beside its anchored conditions.
    // Reserving two full prose bands above/below the graph needlessly squeezed
    // its actual decision paths. The three layout candidates remain bounded.
    if (context.variant === 0 && notes.length && (original.topology === 'branch' || original.topology === 'cycle')) {
      const graphWidth = Math.floor(box.width * 0.52), gap = 28;
      const noteBox = { ...box, left: box.left + graphWidth + gap, width: box.width - graphWidth - gap };
      const side = empty(); let y = box.top, valid = true;
      const ordered = [...notes].sort((a, b) => original.nodes.indexOf(anchor(a.anchorId ?? a.label ?? a.id)!)
        - original.nodes.indexOf(anchor(b.anchorId ?? b.label ?? b.id)!));
      for (const node of ordered) {
        const adopted = anchor(node.anchorId ?? node.label ?? node.id);
        if (!adopted) { valid = false; break; }
        const body = [node.label && node.label !== adopted.label ? node.label : undefined, node.text].filter(Boolean).join('\n');
        const html = `<p style="margin:0;font-family:${T.font};font-size:${T.body}px;line-height:1.25;color:${T.text}"><strong style="color:${T.blue}">${escape(adopted.label)}</strong>${body ? `<br>${marked(body, node.emphasis)}` : ''}</p>`;
        const detail = await text(node.id, [adopted.label, body].filter(Boolean).join('\n'),
          { ...noteBox, top: y }, context, { html });
        if (bottom(detail) > bottom(box)) { valid = false; break; }
        recordText(side, detail); map(side, node.sourceContentIds, [detail.id]); y = bottom(detail) + 8;
      }
      if (valid) {
        const plan: DiagramPlan = { ...renderableAdoptedDiagramPlan(original), annotation: undefined };
        const typography = { nodeFontSize: T.label, edgeFontSize: T.minimum };
        try {
          const allocations = await measureDiagramAllocations(plan, context.measure, { left: box.left, top: box.top,
            maxWidth: graphWidth, maxHeight: box.height }, typography);
          const allocation = allocations.find((candidate) => Math.abs(candidate.width - graphWidth) < 1);
          if (allocation) {
            const graph = await compileMeasuredDiagramComponent({ ...plan, id: component.id, type: 'diagram', left: box.left, top: box.top,
              ...allocation, accentColor: T.blue, nodeFill: T.pale, textColor: T.text }, context.measure, typography);
            side.elements.unshift(...graph);
            for (const node of original.nodes) {
              const rendered = graph.find((element) => element.id === `${component.id}-node-${node.id}`);
              if (rendered && rendered.type !== 'line') side.boxes.set(`original:${node.id}`, rendered);
              map(side, [`diagram-node:${node.id}`], rendered ? [rendered.id] : []);
            }
            side.height = Math.max(allocation.height, y - box.top - 8);
            return side;
          }
        } catch (error) {
          if (!(error instanceof DiagramAllocationError || error instanceof VisualCapacityMiss)) throw error;
        }
      }
    }
    const groups = [...new Set(notes.map((node) => node.anchorId ?? node.label ?? node.id))]
      .sort((a, b) => original.nodes.indexOf(anchor(a)!) - original.nodes.indexOf(anchor(b)!));
    // A five-stage graph stays whole. Put three explanations above and two
    // below the original diagram, rather than squeezing five prose columns.
    const topCount = groups.length > 3 ? context.variant === 1 ? Math.floor(groups.length / 2) : Math.ceil(groups.length / 2)
      : context.variant === 2 ? groups.length : 0;
    const topKeys = groups.slice(0, topCount), bottomKeys = groups.slice(topCount);
    const measureRow = async (keys: string[]) => {
      const width = (box.width - 18 * Math.max(0, keys.length - 1)) / Math.max(1, keys.length);
      if (keys.length && width < 175) return null;
      const members: Array<{ key: string; block: Block }> = [];
      for (const [index, key] of keys.entries()) {
        const nodes = notes.filter((node) => (node.anchorId ?? node.label ?? node.id) === key);
        const measured = await prose({ ...component, nodes }, { left: box.left + index * (width + 18), top: 0,
          width, height: box.height }, context);
        if (!measured) return null;
        members.push({ key, block: measured });
      }
      return { members, height: Math.max(0, ...members.map((member) => member.block.height)) };
    };
    const upper = await measureRow(topKeys), lower = await measureRow(bottomKeys);
    if (!upper || !lower) return null;
    const gap = 18, topReserve = upper.members.length ? upper.height + gap : 0;
    const bottomReserve = lower.members.length ? lower.height + gap : 0;
    const graphHeight = box.height - topReserve - bottomReserve;
    if (graphHeight < 80) return null;
    const plan: DiagramPlan = { ...renderableAdoptedDiagramPlan(original), annotation: undefined };
    const typography = { nodeFontSize: T.label, edgeFontSize: T.minimum };
    try {
      const graphTop = box.top + topReserve;
      const allocations = await measureDiagramAllocations(plan, context.measure, { left: box.left, top: graphTop,
        maxWidth: box.width, maxHeight: graphHeight }, typography);
      const allocation = allocations.find((candidate) => Math.abs(candidate.width - box.width) < 1);
      if (!allocation) return null;
      const graph = await compileMeasuredDiagramComponent({ ...plan, id: component.id, type: 'diagram', left: box.left, top: graphTop,
        width: allocation.width, height: allocation.height, accentColor: T.blue, nodeFill: T.pale, textColor: T.text }, context.measure, typography);
      block.elements.push(...graph);
      for (const node of original.nodes) {
        const rendered = graph.find((element) => element.id === `${component.id}-node-${node.id}`);
        if (rendered && rendered.type !== 'line') block.boxes.set(`original:${node.id}`, rendered);
        map(block, [`diagram-node:${node.id}`], rendered ? [rendered.id] : []);
      }
      for (const [row, above] of [[upper, true], [lower, false]] as const) {
        for (const member of row.members) {
          const dy = above ? graphTop - gap - member.block.height : graphTop + allocation.height + gap;
          const moved: Block = { ...member.block,
            elements: member.block.elements.map((element) => ({ ...element, top: element.top + dy })),
            boxes: new Map([...member.block.boxes].map(([id, rect]) => [id, { ...rect, top: rect.top + dy }])) };
          merge(block, moved);
          // Proximity and the native labels express annotation ownership.
          // Diagonal guide lines into entire prose boxes confused the process
          // arrows and obscured text without adding a teaching relationship.
        }
      }
      block.height = topReserve + allocation.height + bottomReserve;
      return block;
    } catch (error) {
      if (error instanceof DiagramAllocationError || error instanceof VisualCapacityMiss) return null;
      throw error;
    }
  }
  return network(component, box, context);
}

/** Native relation objects, laid out by actual graph connections. */
async function network(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const block = empty();
  const declaredEdges: VisualEdge[] = [...(component.edges ?? []), ...component.nodes.filter((node) => node.parentId)
    .map((node) => ({ from: node.parentId!, to: node.id, kind: 'containment' as const }))]
  ;
  const edges: VisualEdge[] = [...new Map(declaredEdges.map((edge) => [`${edge.from}\0${edge.to}\0${edge.label ?? ''}`, edge])).values()];
  const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const annotations = edges.length ? component.nodes.filter((node) => !connected.has(node.id)) : [];
  const nodes = component.nodes.filter((node) => !annotations.includes(node));
  if (!nodes.length) return null;
  const originalBox = box;
  const annotation = annotations.length ? await prose({ ...component, nodes: annotations }, { ...box, top: 0 }, context) : undefined;
  if (annotations.length && !annotation) return null;
  if (annotation) box = { ...box, height: box.height - annotation.height - 12 };
  if (box.height < 80) return null;
  const levels = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  // For a DAG this is its actual dependency depth. Cycles retain the authored
  // order around a ring, without inventing an adjacent cross-flow transition.
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const from = levels.get(edge.from), to = levels.get(edge.to);
      if (from === undefined || to === undefined) return null;
      if (from + 1 > to) { levels.set(edge.to, from + 1); changed = true; }
    }
    if (!changed) break;
  }
  const cycle = [...levels.values()].some((level) => level >= nodes.length);
  const sequence = ['process', 'state-change', 'worked-example'].includes(component.kind) && edges.length === nodes.length - 1
    && nodes.slice(1).every((node, index) => edges.some((edge) => edge.from === nodes[index]!.id && edge.to === node.id));
  const staggered = sequence && nodes.length > 3 && context.variant !== 1;
  const grid = cycle || staggered;
  const tree = component.kind === 'structure';
  if (tree) for (let pass = 0; pass < nodes.length; pass++) for (const node of nodes) {
    if (node.parentId && levels.has(node.parentId)) levels.set(node.id, Math.min(nodes.length - 1, levels.get(node.parentId)! + 1));
  }
  const distinct = [...new Set(levels.values())].sort((a, b) => a - b);
  const vertical = tree ? context.variant !== 1 : context.variant === 2 && !(sequence && nodes.length <= 3);
  const lanes = Math.max(1, ...distinct.map((level) => nodes.filter((node) => levels.get(node.id) === level).length));
  const columns = grid ? cycle && nodes.length === 4 ? 2 : context.variant === 2 ? Math.ceil(nodes.length / 2) : Math.min(3, nodes.length) : vertical ? lanes : distinct.length;
  const rows = grid ? Math.ceil(nodes.length / columns) : vertical ? distinct.length : lanes;
  const nodeAlign = tree || vertical && !grid && component.kind === 'causal' ? 'center' : 'left';
  const measuredEdgeLabels = new Map<number, PPTTextElement>();
  for (const [index, edge] of edges.entries()) if (edge.label) measuredEdgeLabels.set(index,
    await text(`${component.id}:edge-${index}:label`, edge.label, { left: 0, top: 0, width: Math.min(220, box.width / 2) },
      context, { size: T.minimum, align: 'center', color: T.muted, fitWidth: true, lineHeight: 1.2 }));
  const labelRowHeight = measuredEdgeLabels.size ? Math.max(...[...measuredEdgeLabels.values()].map((element) => element.height)) + 8 : 0;
  const labelBand = cycle ? labelRowHeight * (measuredEdgeLabels.size > 1 ? 2 : 1) : !vertical || grid ? labelRowHeight : 0;
  const gapX = 24, gapY = cycle ? 54 : Math.max(20, labelRowHeight);
  const width = (box.width - gapX * (columns - 1)) / columns;
  if (width < 72) return null;
  const measuredNodes = new Map<string, Block>();
  const rowHeights = Array.from({ length: rows }, () => 0);
  for (const [index, node] of nodes.entries()) {
    const depth = distinct.indexOf(levels.get(node.id)!);
    const peers = nodes.filter((peer) => levels.get(peer.id) === levels.get(node.id));
    const row = grid ? Math.floor(index / columns) : vertical ? depth : peers.findIndex((peer) => peer.id === node.id);
    const rowCount = staggered ? Math.min(columns, nodes.length - row * columns) : vertical && !grid ? peers.length : columns;
    const nodeWidth = staggered || vertical && !grid ? (box.width - gapX * (rowCount - 1)) / rowCount : width;
    const measured = await nodeText(node, { left: 0, top: 0, width: nodeWidth, height: box.height }, context, true, nodeAlign);
    if (!measured) return null;
    measuredNodes.set(node.id, measured); rowHeights[row] = Math.max(rowHeights[row]!, measured.height + 5);
  }
  const totalHeight = rowHeights.reduce((sum, height) => sum + height, 0) + gapY * (rows - 1);
  if (totalHeight + labelBand > box.height) return null;
  const initialY = box.top + labelBand + (box.height - totalHeight - labelBand) / 2;
  const positions = new Map<string, VisualRect>();
  for (const [index, node] of nodes.entries()) {
    const depth = distinct.indexOf(levels.get(node.id)!);
    const peers = nodes.filter((peer) => levels.get(peer.id) === levels.get(node.id));
    const peerIndex = peers.findIndex((peer) => peer.id === node.id);
    const col = grid ? index % columns : vertical ? peerIndex : depth;
    const row = grid ? Math.floor(index / columns) : vertical ? depth : peerIndex;
    const rowCount = staggered ? Math.min(columns, nodes.length - row * columns) : vertical && !grid ? peers.length : columns;
    const nodeWidth = staggered || vertical && !grid ? (box.width - gapX * (rowCount - 1)) / rowCount : width;
    const y = initialY + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gapY, 0);
    const rect = { left: box.left + col * (nodeWidth + gapX), top: y, width: nodeWidth, height: rowHeights[row]! };
    const measured = measuredNodes.get(node.id)!;
    const child: Block = { ...measured, elements: measured.elements.map((element) => ({ ...element, left: element.left + rect.left, top: element.top + rect.top })),
      boxes: new Map([...measured.boxes].map(([id, box]) => [id, { ...box, left: box.left + rect.left, top: box.top + rect.top }])) };
    const actual = { ...rect, height: child.height + 5 };
    if (component.kind === 'worked-example' && edges.some((edge) => edge.to === node.id)
      && !edges.some((edge) => edge.from === node.id)) {
      block.elements.unshift(shape(`${node.id}:result-background`, { ...rect, height: child.height }, T.mint));
    }
    positions.set(node.id, actual); merge(block, child);
    const markerWidth = Math.min(36, nodeWidth / 4);
    block.elements.unshift(shape(`${node.id}:marker`, { left: nodeAlign === 'center'
      ? rect.left + (nodeWidth - markerWidth) / 2 : rect.left + 10, top: rect.top, width: markerWidth, height: 3 }, T.teal));
  }
  const relations = edges;
  const renderedSharedLabels = new Set<string>();
  for (const [index, edge] of relations.entries()) {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    if (!from || !to) return null;
    const downward = to.top >= bottom(from) + 3;
    const upward = bottom(to) <= from.top;
    const backward = !downward && !upward && to.left < from.left;
    const a: [number, number] = downward ? [from.left + from.width / 2, bottom(from) + 3]
      : upward ? [from.left + from.width / 2, from.top - 5]
        : backward ? [from.left + from.width / 2, from.top - 5] : [right(from) + 3, from.top + from.height / 2];
    const b: [number, number] = downward ? [to.left + to.width / 2, to.top - 9]
      : upward ? [right(to) + 7, to.top + to.height / 2]
        : backward ? [to.left + to.width / 2, to.top - 9] : [to.left - 3, to.top + to.height / 2];
    let points: Array<[number, number]> = [a, b];
    if (backward) {
      const routeY = Math.min(from.top, to.top) - 14;
      points = [a, [a[0], routeY], [b[0], routeY], b];
    } else if (upward) {
      const routeX = Math.min(right(box) - 4, Math.max(right(from), right(to)) + 15);
      points = [a, [routeX, a[1]], [routeX, b[1]], b];
    } else if (downward && Math.abs(a[0] - b[0]) > 3) {
      const routeY = (a[1] + b[1]) / 2;
      points = [a, [a[0], routeY], [b[0], routeY], b];
    }
    for (let leg = 1; leg < points.length; leg++) block.elements.unshift(line(
      leg === points.length - 1 ? `${component.id}:edge-${index}` : `${component.id}:edge-${index}:leg-${leg}`,
      points[leg - 1]!, points[leg]!, T.blue, leg === points.length - 1 && edge.kind !== 'containment'));
    const measuredLabel = measuredEdgeLabels.get(index);
    if (measuredLabel) {
      const sharedKey = `${edge.from}\0${edge.kind ?? ''}\0${edge.label}`;
      const shared = relations.filter((relation) => relation.from === edge.from && relation.kind === edge.kind && relation.label === edge.label).length > 1;
      if (shared && renderedSharedLabels.has(sharedKey)) continue;
      const centerX = shared ? from.left + from.width / 2 : (a[0] + b[0]) / 2, centerY = (a[1] + b[1]) / 2;
      const possible = [
        { left: centerX - measuredLabel.width / 2, top: centerY - measuredLabel.height / 2 },
        { left: centerX - measuredLabel.width / 2, top: centerY - measuredLabel.height - 8 },
        { left: centerX - measuredLabel.width / 2, top: Math.min(from.top, to.top) - measuredLabel.height - 20 },
        { left: from.left + (from.width - measuredLabel.width) / 2, top: from.top - measuredLabel.height - 8 },
        { left: to.left + (to.width - measuredLabel.width) / 2, top: to.top - measuredLabel.height - 8 },
        { left: centerX - measuredLabel.width / 2, top: initialY - labelRowHeight - measuredLabel.height - 8 },
      ].map((position) => ({ ...measuredLabel, ...position,
        left: Math.max(box.left, Math.min(position.left, right(box) - measuredLabel.width)) }));
      const label = possible.find((candidate) => inside(candidate, box)
        && ![...block.boxes.values()].some((rect) => overlap(rect, candidate)));
      if (!label) return null;
      renderedSharedLabels.add(sharedKey);
      label.fill = T.background;
      block.elements.push(label); block.boxes.set(label.id, label);
      const anchor: [number, number] = [label.left + label.width / 2, bottom(label)];
      if (Math.hypot(anchor[0] - centerX, anchor[1] - centerY) > 18) block.elements.unshift(line(
        `${component.id}:edge-${index}:label-guide`, anchor, [centerX, centerY], T.line, false));
    }
  }
  if (annotation) {
    const dy = bottom(originalBox) - annotation.height;
    merge(block, { ...annotation, elements: annotation.elements.map((element) => ({ ...element, top: element.top + dy })),
      boxes: new Map([...annotation.boxes].map(([id, rect]) => [id, { ...rect, top: rect.top + dy }])) });
  }
  block.height = originalBox.height;
  return block;
}

async function comparison(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const rows = [...new Set(component.nodes.map((node) => node.row).filter((value): value is string => Boolean(value)))];
  const columns = [...new Set(component.nodes.map((node) => node.column).filter((value): value is string => Boolean(value)))];
  if (!rows.length || columns.length < 2) return prose(component, box, context);
  const block = empty();
  // Give long semantic dimension names their measured width before assigning
  // the equal comparison columns. They are teaching text, not a narrow gutter.
  const measuredDimensions = await Promise.all(rows.map((row) => text(`${component.id}:dimension-measure`, row,
    { left: 0, top: 0, width: Math.min(box.width * 0.3, 260) }, context, { size: T.body, bold: true, fitWidth: true })));
  const firstWidth = Math.max(Math.min(155, box.width * 0.2), ...measuredDimensions.map((item) => item.width));
  const extraNodes = component.nodes.filter((node) => !node.row && !node.column);
  const notes = extraNodes.length ? await prose({ ...component, nodes: extraNodes }, { ...box, top: 0 }, context) : undefined;
  if (extraNodes.length && !notes) return null;
  const notesHeight = notes ? notes.height + 14 : 0;
  const widths = [firstWidth, ...columns.map(() => (box.width - firstWidth) / columns.length)];
  if (widths.slice(1).some((width) => width < 140)) return null;
  const data: TableCell[][] = [], rowHeights: number[] = [];
  for (let row = 0; row <= rows.length; row++) {
    const cells: TableCell[] = [], heights: number[] = [];
    for (let col = 0; col <= columns.length; col++) {
      const node = row && col ? component.nodes.find((node) => node.row === rows[row - 1] && node.column === columns[col - 1]) : undefined;
      if (row && col && !node) return null;
      const value = row === 0 ? col === 0 ? '' : columns[col - 1]! : col === 0 ? rows[row - 1]! : [node!.label, node!.text].filter(Boolean).join('：');
      const measured = await text(node?.id ?? `${component.id}:heading-${row}-${col}`, value,
        { left: 0, top: 0, width: widths[col]! }, context, { size: T.body, bold: !row || !col, color: !row ? T.blue : T.text });
      heights.push(measured.height + 4);
      cells.push({ id: measured.id, text: measured.content, colspan: 1, rowspan: 1, padding: '10px', vAlign: 'middle',
        style: { fontname: T.font, fontsize: `${T.body}px`, color: T.text, bold: !row || !col,
          backcolor: row === 0 ? T.pale : col === 0 ? '#F5F7F8' : T.background },
        borders: { bottom: { color: T.line, style: 'solid', width: 1 } } });
      if (node) map(block, node.sourceContentIds, [component.id]);
    }
    data.push(cells); rowHeights.push(Math.max(...heights));
  }
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + 2;
  if (height + notesHeight > box.height) return null;
  const table: PPTTableElement = { id: component.id, type: 'table', ...box,
    top: box.top + (box.height - height - notesHeight) / 2, height, rotate: 0,
    data, rowHeights, cellMinHeight: 42, colWidths: widths.map((width) => width / box.width),
    outline: { color: T.line, width: 1, style: 'solid' } };
  block.elements.push(table); block.height = height + notesHeight; block.boxes.set(table.id, table);
  if (notes) {
    const dy = bottom(table) + 14;
    merge(block, { ...notes, elements: notes.elements.map((element) => ({ ...element, top: element.top + dy })),
      boxes: new Map([...notes.boxes].map(([id, rect]) => [id, { ...rect, top: rect.top + dy }])) });
  }
  return block;
}

async function annotated(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  const asset = context.images?.find((image) => image.id === component.resourceId);
  if (!asset || !Number.isFinite(asset.width) || asset.width <= 0 || !Number.isFinite(asset.height) || asset.height <= 0) return null;
  const block = empty();
  const hasNotes = component.nodes.length > 0;
  const leftNotes = hasNotes && context.variant === 1;
  const noteWidth = hasNotes ? box.width * (context.variant === 2 ? 0.46 : 0.34) : 0, gap = hasNotes ? 24 : 0;
  const imageColumnWidth = box.width - noteWidth - gap;
  const measuredCaption = asset.caption ? await text(`${asset.id}-caption`, asset.caption,
    { left: box.left, top: 0, width: imageColumnWidth }, context, { size: T.minimum, color: T.muted }) : undefined;
  const captionHeight = measuredCaption ? measuredCaption.height + 8 : 0;
  const area = { left: box.left + (leftNotes ? noteWidth + gap : 0), top: box.top,
    width: box.width - noteWidth - gap, height: box.height - captionHeight };
  if (area.width < 220 || hasNotes && noteWidth < 160) return null;
  const ratio = asset.width / asset.height;
  const width = Math.min(area.width, area.height * ratio), height = width / ratio;
  const image: PPTImageElement = { id: asset.id, type: 'image', left: area.left + (area.width - width) / 2,
    top: area.top + (area.height - height) / 2, width, height, rotate: 0, fixedRatio: true, src: asset.src };
  block.elements.push(image); block.boxes.set(image.id, image);
  const noteLeft = leftNotes ? box.left : area.left + area.width + gap;
  let y = box.top;
  const annotations = [...component.nodes].sort((a, b) => (a.anchor?.y ?? 0.5) - (b.anchor?.y ?? 0.5));
  for (const [i, node] of annotations.entries()) {
    // The caption is under the image. It does not consume the neighboring
    // annotation column's vertical space.
    const gutter = component.edges?.length ? 18 : 0;
    const child = await nodeText(node, { left: noteLeft, top: y, width: noteWidth - gutter, height: bottom(box) - y }, context, true);
    if (!child) return null;
    merge(block, child);
    if (node.anchor) {
      const point: [number, number] = [image.left + image.width * node.anchor.x, image.top + image.height * node.anchor.y];
      const endpoint: [number, number] = [leftNotes ? noteLeft + noteWidth : noteLeft, y + Math.min(24, child.height / 2)];
      const connector = line(`${component.id}:anchor-${i}`, point, endpoint, T.blue, false);
      connector.points = ['dot', '']; block.elements.push(connector);
      map(block, node.sourceContentIds, [image.id, connector.id]);
    }
    y += child.height + Math.max(12, await relationGap(component, node.id, noteWidth - gutter, context));
  }
  if (asset.caption) {
    const caption = await text(`${asset.id}-caption`, asset.caption,
      { left: area.left, top: bottom(image) + 3, width: area.width }, context, { size: T.minimum, color: T.muted });
    if (bottom(caption) > bottom(box)) return null;
    block.elements.push(caption); block.boxes.set(caption.id, caption);
  }
  block.height = box.height; return block;
}

async function evidence(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  if (!component.data) return null;
  const block = empty();
  const unit = component.data.unit ? await text(`${component.id}:unit`, component.data.unit,
    { left: box.left, top: box.top, width: Math.min(200, box.width) }, context,
    { size: T.minimum, color: T.muted }) : undefined;
  const unitHeight = unit ? unit.height + 8 : 0;
  const sideNotes = context.variant !== 2;
  const chartFraction = context.variant === 1 ? 0.5 : 0.62;
  const noteBox = sideNotes ? { left: box.left + box.width * chartFraction + 24, top: box.top, width: box.width * (1 - chartFraction) - 24, height: box.height }
    : { left: box.left, top: 0, width: box.width, height: box.height };
  const notes = await prose(component, noteBox, context);
  if (!notes) return null;
  const notesHeight = notes.height, chartHeight = (sideNotes ? box.height : box.height - notesHeight - 18) - unitHeight;
  const chartWidth = sideNotes ? box.width * chartFraction : box.width;
  if (chartHeight < 175 || component.data.labels.length > Math.floor(chartWidth / 65)) return null;
  const chart: PPTChartElement = { id: `${component.id}:data`, type: 'chart', ...box, top: box.top + unitHeight,
    width: chartWidth, height: chartHeight, rotate: 0,
    chartType: component.data.chartType, data: { labels: [...component.data.labels], legends: component.data.series.map((series) => series.name),
      series: component.data.series.map((series) => [...series.values]) }, options: { fontSize: T.minimum },
    themeColors: [T.blue, T.teal, T.warm], textColor: T.text, lineColor: T.line };
  block.elements.push(chart); block.boxes.set(chart.id, chart);
  for (const node of component.nodes) map(block, node.sourceContentIds, [chart.id]);
  const dy = sideNotes ? 0 : bottom(chart) + 18;
  merge(block, { ...notes, elements: notes.elements.map((element) => ({ ...element, top: element.top + dy })),
    boxes: new Map([...notes.boxes].map(([id, rect]) => [id, { ...rect, top: rect.top + dy }])) });
  // Units are semantic and must be native text, even if the chart renderer
  // does not expose an axis-name API.
  if (unit) { block.elements.push(unit); map(block, component.nodes.flatMap((node) => node.sourceContentIds), [unit.id]); }
  block.height = box.height; return block;
}

async function worked(component: TeachingVisualComponent, box: VisualRect, context: Context): Promise<Block | null> {
  // Worked derivations may branch (two givens feed a formula). Preserve those
  // authored edges instead of always drawing a sequence through array order.
  if (component.edges?.length) return network(component, box, context);
  const block = empty(); let y = box.top;
  const left = box.left + 50, width = box.width - 50;
  for (const [i, node] of component.nodes.entries()) {
    const last = i === component.nodes.length - 1;
    const child = await nodeText(node, { left, top: y, width, height: bottom(box) - y }, context, !last);
    if (!child) return null;
    const marker = shape(`${node.id}:step-dot`, { left: box.left + 13, top: y + 14, width: 12, height: 12 }, i === component.nodes.length - 1 ? T.teal : T.blue,
      'M6 0A6 6 0 1 1 5.99 0Z');
    if (last) block.elements.push(shape(`${node.id}:result-background`, { left: left - 2, top: y,
      width: width + 2, height: child.height }, T.mint));
    block.elements.push(marker); merge(block, child);
    const next = y + child.height + 14;
    if (i < component.nodes.length - 1) block.elements.unshift(line(`${node.id}:step-guide`, [box.left + 19, y + 31], [box.left + 19, next + 6], T.line, false));
    y = next;
  }
  block.height = y - box.top - 14;
  const dy = (box.height - block.height) / 2;
  block.elements = block.elements.map((element) => ({ ...element, top: element.top + dy }));
  block.boxes = new Map([...block.boxes].map(([id, rect]) => [id, { ...rect, top: rect.top + dy }]));
  return block;
}

const measuring: Record<TeachingVisualComponentKind, VisualComponentDefinition['measure']> = {
  'state-change': states, process: diagram, causal: network, structure: network,
  comparison, 'annotated-image': annotated, data: evidence, 'worked-example': worked, text: prose,
};
export const TEACHING_VISUAL_COMPONENTS: Readonly<Record<TeachingVisualComponentKind, VisualComponentDefinition>> =
  Object.fromEntries(Object.entries(measuring).map(([kind, measure]) => [kind,
    { kind: kind as TeachingVisualComponentKind, layout: (_component: TeachingVisualComponent, bounds: VisualRect) => bounds, measure,
      compile: (measured: Block) => measured.elements }])) as unknown as Record<TeachingVisualComponentKind, VisualComponentDefinition>;

function mainComponentIndex(components: TeachingVisualComponent[]): number {
  const importance = (component: TeachingVisualComponent) => component.role === 'primary' ? 10
    : component.role === 'support' || component.role === 'takeaway' ? -1 : component.useAdoptedDiagram ? 5
    : component.kind === 'text' ? 0 : component.kind === 'worked-example' ? 2 : 4;
  return components.reduce((best, component, index) => importance(component) > importance(components[best]!) ? index : best, 0);
}
async function componentRects(components: TeachingVisualComponent[], box: VisualRect, variant: number, context: Context): Promise<VisualRect[]> {
  const count = components.length;
  const prioritize = (rects: VisualRect[]) => {
    const main = mainComponentIndex(components);
    if (main > 0) [rects[0], rects[main]] = [rects[main]!, rects[0]!];
    return rects;
  };
  if (count === 1) return [{ ...box, left: box.left + variant * 10, width: box.width - variant * 20 }];
  const main = mainComponentIndex(components), supplements = components.filter((_, index) => index !== main);
  if (variant === 0 && components[main]!.kind !== 'text' && supplements.every((component) => component.kind === 'text' && !component.edges?.length)) {
    const primary = components[main]!;
    const primaryNodes = primary.useAdoptedDiagram ? context.outline.visualIntent?.diagram?.nodes ?? primary.nodes : primary.nodes;
    const anchorOrder = (component: TeachingVisualComponent) => {
      const key = primary.nodes.find((node) => node.id === component.anchorNodeId)?.anchorId ?? component.anchorNodeId;
      const index = primaryNodes.findIndex((node) => node.id === key);
      const local = component.nodes.map((node) => primaryNodes.findIndex((candidate) => candidate.id === node.anchorId))
        .filter((position) => position >= 0);
      return index >= 0 ? index : local.length ? Math.min(...local) : primaryNodes.length;
    };
    const supporters = supplements.filter((component) => component.role !== 'takeaway')
      .sort((a, b) => anchorOrder(a) - anchorOrder(b));
    const takeaways = supplements.filter((component) => component.role === 'takeaway');
    if (supporters.length <= 2 && takeaways.length <= 1) {
      const rects: VisualRect[] = new Array(count), gap = 20;
      let floor = bottom(box);
      for (const component of takeaways) {
        const measured = await supportPanel(component, { ...box, top: 0 }, context);
        if (!measured) throw new VisualCapacityMiss();
        const rect = { ...box, top: floor - measured.height, height: measured.height };
        rects[components.indexOf(component)] = rect; floor = rect.top - gap;
      }
      if (supporters.length) {
        const width = (box.width - gap * (supporters.length - 1)) / supporters.length;
        const heights = await Promise.all(supporters.map(async (component) => {
          const measured = await supportPanel(component, { left: 0, top: 0, width, height: box.height }, context);
          if (!measured) throw new VisualCapacityMiss();
          return measured.height;
        }));
        const height = Math.max(...heights);
        supporters.forEach((component, index) => { rects[components.indexOf(component)] = {
          left: box.left + index * (width + gap), top: floor - height, width, height }; });
        floor -= height + gap;
      }
      rects[main] = { ...box, height: floor - box.top };
      return rects;
    }
  }
  const gap = 24;
  if (count === 2 && variant === 2 && components.filter((component) => component.kind === 'text').length === 1) {
    const index = components.findIndex((component) => component.kind === 'text'), caption = components[index]!;
    const measured = await (caption.title ? titledProse : prose)(caption, box, context);
    if (measured) {
      const height = measured.height;
      const rects = [{ ...box, height: box.height - height - 8 }, { ...box, top: bottom(box) - height, height }];
      return index === 1 ? rects : rects.reverse();
    }
  }
  if (count === 2 && variant !== 2) {
    const fraction = variant === 0 ? 0.64 : 0.5, width = (box.width - gap) * fraction;
    return prioritize([{ ...box, width }, { ...box, left: box.left + width + gap, width: box.width - gap - width }]);
  }
  if (count === 3 && variant === 0) {
    const width = (box.width - gap) * 0.57, side = { left: box.left + width + gap, width: box.width - gap - width };
    return prioritize([{ ...box, width }, { ...box, ...side, height: (box.height - gap) / 2 },
      { ...box, ...side, top: box.top + (box.height + gap) / 2, height: (box.height - gap) / 2 }]);
  }
  if (variant === 1) {
    const width = (box.width - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => ({ ...box, left: box.left + i * (width + gap), width }));
  }
  const height = (box.height - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ ...box, top: box.top + i * (height + gap), height }));
}

/** All scores describe measured native objects, not a preferred template ID. */
export function scoreTeachingVisualCandidate(page: TeachingVisualPage, elements: PPTElement[], allocations: VisualRect[],
  body: VisualRect, candidateId: string, recentCandidateIds: readonly string[] = []) {
  const bounds = (rectangles: VisualRect[]): VisualRect | undefined => {
    if (!rectangles.length) return undefined;
    const left = Math.min(...rectangles.map((rect) => rect.left)), top = Math.min(...rectangles.map((rect) => rect.top));
    return { left, top, width: Math.max(...rectangles.map(right)) - left, height: Math.max(...rectangles.map(bottom)) - top };
  };
  const area = (rect: VisualRect | undefined) => rect ? rect.width * rect.height : 0;
  const separation = (a: VisualRect, b: VisualRect) => Math.hypot(Math.max(0, a.left - right(b), b.left - right(a)),
    Math.max(0, a.top - bottom(b), b.top - bottom(a)));
  const visible = elements.filter((element) => element.type !== 'line' && (!('opacity' in element) || element.opacity !== 0)) as Array<PPTElement & VisualRect>;
  const visuals = page.components.map((component) => bounds(visible.filter((element) => element.groupId === component.id
    && (component.kind === 'data' ? element.type === 'chart' : component.kind === 'annotated-image' ? element.type === 'image'
      : component.kind === 'comparison' ? element.type === 'table' : component.useAdoptedDiagram ? element.id.startsWith(`${component.id}-node-`)
        : component.kind !== 'text' && !element.id.endsWith(':title')))));
  const primary = mainComponentIndex(page.components), mainVisualArea = Math.min(1, area(visuals[primary]) / area(body));
  const hierarchy = visuals[primary] ? area(allocations[primary]) / Math.max(1, allocations.reduce((sum, rect) => sum + area(rect), 0)) : 0;
  const distances: number[] = [], reading: number[] = [];
  const nodeBox = (id: string) => visible.find((element) => element.id === id || element.id === `${id}:label`);
  const primaryComponent = page.components[primary]!;
  const anchorBox = (id: string) => {
    const key = primaryComponent.nodes.find((node) => node.id === id)?.anchorId ?? id;
    return visible.find((element) => element.groupId === primaryComponent.id
      && (element.id === `${primaryComponent.id}-node-${key}` || element.id === `${key}:object`
        || element.id === `${key}:state-object` || element.id === `${key}:learner`)) ?? nodeBox(key);
  };
  for (const [index, component] of page.components.entries()) {
    for (const node of component.nodes) {
      const note = nodeBox(node.id);
      const related = component.anchorNodeId ? anchorBox(component.anchorNodeId)
        : component.useAdoptedDiagram && node.anchorId
        ? visible.find((element) => element.id === `${component.id}-node-${node.anchorId}`)
        : component.kind === 'data' || component.kind === 'annotated-image' ? visuals[index]
          : component.kind === 'text' ? visuals.filter((rect): rect is VisualRect => Boolean(rect))
            .sort((a, b) => note ? separation(note, a) - separation(note, b) : 0)[0] : undefined;
      if (note && related) distances.push(separation(note, related));
    }
    for (const edge of component.edges ?? []) {
      if (component.nodes.findIndex((node) => node.id === edge.to) <= component.nodes.findIndex((node) => node.id === edge.from)) continue;
      const from = nodeBox(edge.from), to = nodeBox(edge.to);
      if (from && to) reading.push(to.top >= bottom(from) - 4 || to.left >= right(from) - 4 ? 1 : 0);
    }
  }
  const proximity = distances.length ? distances.reduce((sum, distance) => sum + 1 / (1 + distance / 100), 0) / distances.length : 1;
  const readingDirection = reading.length ? reading.reduce((sum, forward) => sum + forward, 0) / reading.length : 1;
  const objects = primaryComponent.kind === 'process' ? visible.filter((element) => element.type === 'shape'
    && element.groupId === primaryComponent.id && element.fill !== '#00000000'
    && (element.id.startsWith(`${primaryComponent.id}-node-`) || element.id.endsWith(':object'))) : [];
  const axisConsistency = objects.length > 1 ? Math.max(...objects.map((object) =>
    objects.filter((other) => Math.abs(other.top - object.top) < 1).length)) / objects.length : 1;
  const learnerSubject = primaryComponent.nodes.map((node) => [node.label, node.text].join(' ')).join(' ');
  const expectedLearners = primaryComponent.kind === 'state-change' && (primaryComponent.nodes.some((node) => node.supportLevel)
    || /支架|scaffold/iu.test(learnerSubject) && /学生|学习者|learner|student/iu.test(learnerSubject));
  const objectIdentity = expectedLearners && primaryComponent.nodes.length ? primaryComponent.nodes.filter((node) =>
    visible.some((element) => element.id === `${node.id}:learner`)).length / primaryComponent.nodes.length : 0;
  const repetitionPenalty = recentCandidateIds.slice(-3).reduce((sum, previous, index, recent) =>
    sum + (previous === candidateId ? (index + 1) / recent.length : 0), 0) * 1.5;
  return { mainVisualArea, hierarchy, proximity, readingDirection, axisConsistency, objectIdentity, repetitionPenalty,
    total: mainVisualArea * 18 + hierarchy * 4 + proximity * 6 + readingDirection * 6 + axisConsistency * 10
      + objectIdentity * 20 - repetitionPenalty };
}

function pageProjection(page: TeachingVisualPage): SlidePresentationProjection {
  const items = page.components.flatMap((component) => {
    const nodes = component.nodes.map((node) => ({ id: node.id, sourceContentIds: node.sourceContentIds,
      text: node.text ?? node.label!, ...(node.text && node.label ? { label: node.label } : {}),
      ...(node.row ? { row: node.row } : {}), ...(node.column ? { column: node.column } : {}),
      ...(node.sourceEvidenceIds ? { sourceEvidenceIds: node.sourceEvidenceIds } : {}) }));
    if (component.data) nodes.push({ id: `${component.id}:data`, sourceContentIds: [...new Set(component.nodes.flatMap((node) => node.sourceContentIds))],
      text: `${component.data.unit ? `单位：${component.data.unit}；` : ''}${component.data.series.map((series) => `${series.name}：${component.data!.labels.map((label, i) => `${label} ${series.values[i]}${component.data!.unit ?? ''}`).join('；')}`).join('。')}` });
    return nodes;
  });
  return { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true, items,
    links: page.components.flatMap((component) => component.edges ?? []), elementIdsBySource: {} };
}
function semanticAliases(outline: SceneOutline, content: GeneratedSlideContent, sources: Array<{ id: string; text: string }>) {
  const plan = outline.teachingBrief?.teachingPlan;
  const display = plan?.presentationItems?.map((item) => item.text) ?? plan?.presentationContent ?? plan?.visibleContent ?? outline.keyPoints;
  const graph = outline.visualIntent?.diagram;
  for (const [i, wording] of [...new Set(display.map((value) => value.trim()).filter(Boolean))].entries()) {
    const id = `${outline.id}:visible-${i + 1}`;
    if (content.elements.some((element) => element.id === id)) continue;
    const sourceIds = [...sources.filter((source) => source.text.trim() === wording).map((source) => source.id),
      ...(graph?.nodes.filter((node) => node.label.trim() === wording).map((node) => `diagram-node:${node.id}`) ?? []),
      ...(graph?.annotation?.trim() === wording ? ['diagram-annotation'] : [])];
    const ids = new Set(sourceIds.flatMap((source) => content.presentationProjection?.elementIdsBySource[source] ?? []));
    const boxes = content.elements.filter((element) => ids.has(element.id) && element.type !== 'line') as Array<PPTElement & VisualRect>;
    if (!boxes.length) continue;
    const left = Math.min(...boxes.map((box) => box.left)), top = Math.min(...boxes.map((box) => box.top));
    content.elements.push({ ...shape(id, { left, top, width: Math.max(...boxes.map(right)) - left,
      height: Math.max(...boxes.map(bottom)) - top }, 'none'), opacity: 0 });
  }
}

async function compilePage(outline: SceneOutline, scene: TeachingVisualScene, page: TeachingVisualPage,
  options: TeachingVisualCompilerOptions): Promise<GeneratedSlideContent | null> {
  const candidates: Array<{ content: GeneratedSlideContent; score: number }> = [];
  for (let variant = 0; variant < 3; variant++) {
    const candidateId = `visual-${variant + 1}`;
    if (options.allowedCandidateIds && !options.allowedCandidateIds.includes(candidateId)) continue;
    const context: Context = { ...options, outline, page, variant };
    try {
      const title = await text('teaching-visual-title', page.title, { left: 50, top: 28, width: 900 }, context,
        { size: T.title, bold: true, color: T.text });
      const bodyTop = Math.max(112, bottom(title) + 14);
      const body: VisualRect = { left: 44, top: bodyTop, width: 912, height: 532.5 - bodyTop };
      if (body.height < 170 || page.components.length > 4) continue;
      const rects = await componentRects(page.components, body, variant, context), block = empty();
      const main = mainComponentIndex(page.components);
      const metadata: TeachingVisualMetadata['components'] = [];
      let failed = false;
      // Measure the subject before its owned panels so their shared row can
      // move towards the subject regardless of model component array order.
      const compilationOrder = [main, ...page.components.map((_, index) => index).filter((index) => index !== main)];
      for (const index of compilationOrder) {
        const component = page.components[index]!;
        const previousComponent = options.previous?.teachingVisual?.components.find((item) => item.id === component.id);
        if (previousComponent?.locked || previousComponent?.modified) {
          const ids = new Set(previousComponent.elementIds);
          const retained = structuredClone(options.previous!.elements.filter((element) => ids.has(element.id)));
          block.elements.push(...retained); metadata.push(structuredClone(previousComponent));
          const rectangles = retained.filter((element) => element.type !== 'line') as Array<PPTElement & VisualRect>;
          if (rectangles.length) {
            const left = Math.min(...rectangles.map((box) => box.left)), top = Math.min(...rectangles.map((box) => box.top));
            block.boxes.set(`protected:${component.id}`, { left, top, width: Math.max(...rectangles.map(right)) - left, height: Math.max(...rectangles.map(bottom)) - top });
          }
          for (const source of previousComponent.sourceContentIds) map(block, [source],
            options.previous!.presentationProjection?.elementIdsBySource[source]?.filter((id) => ids.has(id)) ?? []);
          continue;
        }
        const definition = TEACHING_VISUAL_COMPONENTS[component.kind];
        if (!definition) { failed = true; break; }
        let bounds = definition.layout(component, rects[index]!, variant);
        const panel = component.kind === 'text' && !component.edges?.length
          && (component.role === 'support' || component.role === 'takeaway'
            || variant === 0 && index !== main && page.components[main]!.kind !== 'text');
        const showHeading = !panel && component.role !== 'primary' && component.title && component.title !== page.title;
        const inlineHeading = showHeading && component.kind === 'text' && bounds.width >= 600;
        if (showHeading && !inlineHeading) {
          const heading = await text(`${component.id}:title`, component.title!, bounds, context,
            { size: T.label, bold: true, color: T.blue, lineHeight: 1.25 });
          block.elements.push(heading); block.boxes.set(heading.id, heading);
          bounds = { ...bounds, top: bottom(heading) + 8, height: bottom(bounds) - bottom(heading) - 8 };
        }
        // Allocation already measures the tallest sibling. Keep both panel
        // backgrounds on that grid; only their text has intrinsic height.
        // This applies to the shared support row, not standalone panels or a
        // teacher-modified component whose geometry must remain untouched.
        const rowPeers = variant === 0 && panel && index !== main && component.role !== 'takeaway'
          ? page.components.flatMap((part, position) => position !== main && part.kind === 'text'
            && !part.edges?.length && part.role !== 'takeaway'
            && Math.abs(rects[position]!.top - rects[index]!.top) < 1
            && Math.abs(rects[position]!.height - rects[index]!.height) < 1
            ? [part] : []) : [];
        const alignRow = rowPeers.length > 1 && rowPeers.every((part) => {
          const previous = options.previous?.teachingVisual?.components.find((item) => item.id === part.id);
          return !previous?.locked && !previous?.modified;
        });
        const measured = await (panel ? supportPanel(component, bounds, context, alignRow)
          : inlineHeading ? titledProse(component, bounds, context) : definition.measure(component, bounds, context));
        if (measured && ['text', 'data', 'annotated-image', 'comparison'].includes(component.kind)
          && !await connectAnnotations(component, measured, bounds, context)) { failed = true; break; }
        if (!measured || measured.elements.some((element) => element.type !== 'line'
          && (!inside(element.type === 'text' ? textInkBox(element) : element, body)
            || !inside(element, { left: 0, top: 0, width: 1000, height: 562.5 })))) { failed = true; break; }
        // Keep owned explanation panels close to an open icon/learner strip.
        // Their full measured height is retained; unused space need not turn
        // into a large gap between an object and its explanation.
        if (variant === 0 && index === main && measured.elements.some((element) =>
          element.id.endsWith(':icon') || element.id.endsWith(':learner'))
          && page.components.every((part) => part === component || part.kind === 'text'
            && !part.edges?.length && (part.role === 'support' || part.role === 'takeaway'))) {
          const supports = page.components.flatMap((part, position) => part.role === 'support' ? [position] : []);
          const floor = Math.min(...supports.map((position) => rects[position]!.top));
          const nearby = bounds.top + measured.height + 20;
          if (supports.length && nearby < floor) for (const position of supports) {
            rects[position] = { ...rects[position]!, top: rects[position]!.top - (floor - nearby) };
          }
        }
        const elements = definition.compile(measured);
        for (const element of elements) element.groupId = component.id;
        metadata.push({ id: component.id, kind: component.kind,
          elementIds: [...(showHeading && !inlineHeading ? [`${component.id}:title`] : []), ...elements.map((element) => element.id)],
          sourceContentIds: [...new Set(component.nodes.flatMap((node) => node.sourceContentIds))] });
        merge(block, measured);
      }
      if (failed) continue;
      const assets = options.images ?? [];
      // A resource omitted by the semantic scene must never vanish in a new
      // generation. Host callers attach required resources as visual components.
      if (assets.some((asset) => !block.elements.some((element) => element.type === 'image' && element.id === asset.id))) continue;
      const labelBoxes = [...block.boxes.entries()].filter(([id]) => !id.startsWith('original:') && !id.endsWith(':visual') && !assets.some((asset) => asset.id === id));
      if (labelBoxes.some(([id, box], i) => labelBoxes.slice(i + 1).some(([other, rect]) => id !== other && overlap(box, rect)))) continue;
      const projection = pageProjection(page); projection.elementIdsBySource = block.mapping;
      // Every authored display object must really survive compilation. Shared
      // source IDs or invisible cue aliases cannot mask a dropped explanation.
      const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
      const plain = (html: string) => html.replace(/<[^>]*>/gu, '')
        .replace(/&(amp|lt|gt|quot|apos|#39);/gu, (_match, entity: string) => entities[entity]!).replace(/\s+/gu, '');
      const visibleText = block.elements.filter((element) => !('opacity' in element) || element.opacity !== 0)
        .flatMap((element) => element.type === 'text' ? [plain(element.content)]
          : element.type === 'shape' && element.text ? [plain(element.text.content)]
            : element.type === 'table' ? element.data.flat().map((cell) => plain(cell.text)) : []);
      if (page.components.some((component) => !metadata.find((item) => item.id === component.id)?.locked
        && !metadata.find((item) => item.id === component.id)?.modified
        && component.nodes.some((node) => [node.label, node.text].filter((value): value is string => Boolean(value))
          .some((value) => !visibleText.some((actual) => actual.includes(value.replace(/\s+/gu, ''))))))) continue;
      const sourceCatalog = options.sourceCatalog ?? options.previous?.teachingVisual?.sourceCatalog ?? [];
      const responsibilityIds = [...new Set(page.components.flatMap((component) => component.nodes.flatMap((node) => node.sourceContentIds)))];
      const teachingText = sourceCatalog.filter((source) => responsibilityIds.includes(source.id)).map((source) => source.text);
      const graph = page.components.some((component) => component.useAdoptedDiagram) ? outline.visualIntent?.diagram : undefined;
      const figureGoals = page.components.filter((component) => component.resourceId).map((component) =>
        outline.visualIntent?.resourceRefs?.find((ref) => ref.resourceId === component.resourceId)?.observationGoal
          || outline.visualIntent?.observationGoal || outline.title);
      // A retained figure can own observation time without invented prose or
      // fabricated source IDs. Only adopted observation goals enter narration.
      const completeTeachingText = [...new Set([...teachingText, ...(graph?.nodes.map((node) => node.label) ?? []),
        ...(!teachingText.length && !graph ? figureGoals : [])])];
      const content: GeneratedSlideContent = { elements: [title, ...block.elements], background: { type: 'solid', color: T.background },
        theme: teachingVisualSlideTheme(), presentationProjection: projection,
        teachingText: completeTeachingText, sourceGroupIds: responsibilityIds,
        paginationVersion: 'balanced-v1',
        teachingVisual: { scene, pageId: page.id, candidateId, components: metadata, compilerVersion: TEACHING_VISUAL_COMPILER_VERSION,
          themeVersion: TEACHING_VISUAL_THEME_VERSION, sourceCatalog: sourceCatalog.map(({ id, text }) => ({ id, text })),
          ...(outline.visualIntent?.diagram ? { adoptedDiagram: outline.visualIntent.diagram } : {}) },
        layoutMeasurement: { bodyCapacity: body.height, occupiedHeight: body.height,
          contentLoad: Math.max(1, completeTeachingText.join('').length + (graph?.nodes.length ?? 0) * 20),
          pageIndex: scene.pages.findIndex((candidate) => candidate.id === page.id) + 1, pageCount: scene.pages.length, sourceGroupIds: responsibilityIds },
      };
      semanticAliases(outline, content, sourceCatalog);
      if (new Set(content.elements.map((element) => element.id)).size !== content.elements.length) continue;
      const measuredScore = scoreTeachingVisualCandidate(page, block.elements, rects, body, candidateId, options.recentCandidateIds);
      const score = measuredScore.total
        + (options.preferredCandidateId === candidateId ? 100 : 0);
      candidates.push({ content, score });
    } catch (error) { if (!(error instanceof VisualCapacityMiss)) throw error; }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.content ?? null;
}

/** One bounded structural replan. An adopted original graph stays whole;
 * an authored chain repeats its boundary node so no directed edge is lost. */
function splitIndependentComponents(scene: TeachingVisualScene, failedPageId: string, outline: SceneOutline): TeachingVisualScene | null {
  if (scene.pages.length >= 3) return null;
  const failed = scene.pages.find((page) => page.id === failedPageId);
  if (!failed) return null;
  let replacements: TeachingVisualPage[];
  if (failed.components.length > 1) replacements = failed.components.map((component, i) => ({
    id: i === 0 ? failed.id : `${failed.id}:part-${i + 1}`, title: component.title ?? failed.title, focus: failed.focus, components: [component],
  }));
  else {
    const component = failed.components[0];
    if (!component || component.nodes.length < 2) return null;
    const makePage = (part: TeachingVisualComponent, second: boolean): TeachingVisualPage => ({ ...failed,
      id: second ? `${failed.id}:part-2` : failed.id, components: [part] });
    if (component.useAdoptedDiagram && outline.visualIntent?.diagram) {
      // Keep the entire adopted graph on one host. Move only its long prose to
      // the immediately following explanation page; its original annotation
      // remains visible on the graph host and keeps its real source identity.
      const annotation = outline.visualIntent.diagram.annotation;
      const hostNodes = [component.nodes[0]!, ...(annotation ? [{ id: `${component.id}:adopted-annotation`,
        text: annotation, sourceContentIds: ['diagram-annotation'] }] : [])];
      const notes = component.nodes.slice(1).map((node) => { const copy = { ...node }; delete copy.anchorId; return copy; });
      replacements = [makePage({ ...component, nodes: hostNodes }, false),
        makePage({ id: `${component.id}:explanation`, kind: 'text', nodes: notes }, true)];
    } else {
      // A continuous authored chain can cross a slide boundary by repeating
      // its boundary node. Every original directed edge remains on one page.
      const chain = component.edges?.length === component.nodes.length - 1 && component.nodes.slice(1).every((node, index) =>
        component.edges!.some((edge) => edge.from === component.nodes[index]!.id && edge.to === node.id));
      if (!chain || !['process', 'state-change', 'causal', 'worked-example'].includes(component.kind) || component.nodes.length < 4) return null;
      const cut = Math.ceil(component.nodes.length / 2);
      const partition = (nodes: VisualNode[], second: boolean) => {
        const ids = new Set(nodes.map((node) => node.id));
        const renamed = (id: string) => second && id === component.nodes[cut - 1]!.id ? `${id}:continued` : id;
        return makePage({ ...component, id: second ? `${component.id}:continued` : component.id,
          nodes: nodes.map((node) => ({ ...node, id: renamed(node.id) })),
          edges: component.edges!.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
            .map((edge) => ({ ...edge, from: renamed(edge.from), to: renamed(edge.to) })) }, second);
      };
      replacements = [partition(component.nodes.slice(0, cut), false), partition(component.nodes.slice(cut - 1), true)];
    }
  }
  const pages = scene.pages.flatMap((page) => page === failed ? replacements : [page]);
  if (pages.length > 3) return null;
  return { ...scene, pages };
}

/** Give an adopted picture and its full observation legend one readable page.
 * Existing explanatory companions follow together. Model-only point hints
 * become a nearby legend rather than asserted positions inside source pixels;
 * the original picture, every word and any real teaching edge are retained. */
function splitImageCompanions(scene: TeachingVisualScene, failedPageId: string, outline: SceneOutline): TeachingVisualScene | null {
  const failed = scene.pages.find((page) => page.id === failedPageId);
  if (!failed || scene.pages.length >= 3) return null;
  const pictures = failed.components.filter((component) => component.kind === 'annotated-image' && component.resourceId);
  if (pictures.length !== 1 || pictures[0]!.edges?.length) return null;
  const picture = pictures[0]!, companions = failed.components.filter((component) => component !== picture);
  if (!companions.length || companions.some((component) => component.kind !== 'text' || component.resourceId
    || component.edges?.length || component.role === 'primary')) return null;
  const legend: TeachingVisualComponent = { ...picture, nodes: picture.nodes.map((node) => {
    const copy = { ...node }; delete copy.anchor; return copy;
  }) };
  const detached = companions.map((component): TeachingVisualComponent => {
    const copy = { ...component, nodes: component.nodes.map((node) => {
      const note = { ...node }; delete note.anchor; delete note.anchorId; return note;
    }) };
    delete copy.anchorNodeId;
    return copy;
  });
  const supporting = detached.filter((component) => component.role !== 'takeaway');
  const takeaways = detached.filter((component) => component.role === 'takeaway');
  const explanations: TeachingVisualComponent[] = supporting.length ? [{
    id: supporting[0]!.id, kind: 'text', role: 'primary', nodes: supporting.flatMap((component) => component.nodes),
  }, ...takeaways] : takeaways;
  const occupied = new Set(scene.pages.map((page) => page.id));
  let explanationId = `${failed.id}:image-explanation`;
  while (occupied.has(explanationId)) explanationId += ':continued';
  const replacements = [{ ...failed, components: [legend] }, {
    ...failed, id: explanationId, title: outline.title, components: explanations,
  }];
  return { ...scene, pages: scene.pages.flatMap((page) => page === failed ? replacements : [page]) };
}

/** A complete four-object graph can need the whole reading area. Keep all of
 * its original anchored notes with it, and carry the existing text companions
 * onto one following page rather than making one page per short condition. */
async function splitAdoptedCompanions(scene: TeachingVisualScene, failedPageId: string,
  outline: SceneOutline, options: TeachingVisualCompilerOptions): Promise<TeachingVisualScene | null> {
  const failed = scene.pages.find((page) => page.id === failedPageId), graph = outline.visualIntent?.diagram;
  if (!failed || !graph || scene.pages.length >= 3) return null;
  const adopted = failed.components.filter((component) => component.useAdoptedDiagram);
  if (adopted.length !== 1) return null;
  const primary = adopted[0]!, companions = failed.components.filter((component) => component !== primary);
  if (!companions.length || companions.some((component) => component.kind !== 'text'
    || component.edges?.length || component.role === 'primary' || component.resourceId)) return null;
  const context: Context = { ...options, outline, page: failed, variant: 0 };
  const title = await text('companion-heading-measure', failed.title, { left: 50, top: 28, width: 900 }, context,
    { size: T.title, bold: true, color: T.text });
  const top = Math.max(112, bottom(title) + 14);
  const body = { left: 44, top, width: 912, height: 532.5 - top };
  if (!await compileAdoptedGrid(primary, graph, body, options.measure)) return null;
  const continuations = companions.map((component) => {
    const anchor = graph.nodes.find((node) => node.id === component.anchorNodeId);
    const copy = { ...component, ...(component.title || !anchor ? {} : { title: anchor.label }) };
    // The visible original object label carries ownership on the continuation;
    // there is no invisible same-page object for a cross-page pointer to target.
    delete copy.anchorNodeId;
    return copy;
  });
  const followingId = `${failed.id}:conditions`;
  if (scene.pages.some((page) => page.id === followingId)) return null;
  const replacements = [{ ...failed, components: [primary] }, { ...failed, id: followingId, components: continuations }];
  return { ...scene, pages: scene.pages.flatMap((page) => page === failed ? replacements : [page]) };
}

/** Reflow long annotations beside their original objects before adding pages.
 * Whole authored nodes move unchanged; only existing graph labels identify
 * their ownership. No sentence is shortened and no graph edge is modified. */
async function reflowAdoptedAnnotations(scene: TeachingVisualScene, failedPageId: string,
  outline: SceneOutline, options: TeachingVisualCompilerOptions): Promise<TeachingVisualScene | null> {
  const page = scene.pages.find((candidate) => candidate.id === failedPageId), graph = outline.visualIntent?.diagram;
  const primary = page?.components.find((component) => component.useAdoptedDiagram);
  if (!page || !graph || !primary?.nodes.length || graph.topology !== 'sequence'
    || graph.nodes.length < 2 || graph.nodes.length > 6 || (graph.sequenceGroups?.length ?? 0) > 1) return null;
  const companions = page.components.filter((component) => component !== primary);
  if (companions.some((component) => component.kind !== 'text' || component.edges?.length
    || component.role === 'primary')) return null;
  const takeaways = companions.filter((component) => component.role === 'takeaway');
  if (takeaways.length > 1) return null;
  const anchor = (key: string | undefined) => graph.nodes.find((node) => node.id === key || node.label === key);
  const resolve = (key: string | undefined) => anchor(primary.nodes.find((node) => node.id === key)?.anchorId ?? key);
  const buckets: VisualNode[][] = [[], []], split = Math.ceil(graph.nodes.length / 2);
  const add = (node: VisualNode, key: string | undefined, fromPrimary: boolean) => {
    const adopted = resolve(key);
    if (!adopted) return false;
    const siblings = primary.nodes.filter((item) => resolve(item.anchorId ?? item.label ?? item.id)?.id === adopted.id);
    const copy = { ...node, anchorId: adopted.id,
      ...(!node.label && (fromPrimary ? siblings.length === 1 : true) ? { label: adopted.label } : {}) };
    if (!copy.label && /自(?:我)?评|互评|教师评价|self[- ]assess|peer[- ](?:review|assess)/iu.test(copy.text ?? '')) {
      copy.label = /\p{Script=Han}/u.test(copy.text ?? '') ? '谁来评' : 'Who assesses';
    }
    else if (!copy.label && /自主学习能力|协作贡献|意义建构/iu.test(copy.text ?? '')) copy.label = '评什么';
    buckets[graph.nodes.indexOf(adopted) < split ? 0 : 1]!.push(copy);
    return true;
  };
  for (const node of primary.nodes) if (!add(node, node.anchorId ?? node.label ?? node.id, true)) return null;
  for (const component of companions.filter((candidate) => candidate.role !== 'takeaway')) {
    for (const node of component.nodes) if (!add(node, node.anchorId ?? component.anchorNodeId, false)) return null;
  }
  for (const nodes of buckets) nodes.sort((a, b) => graph.nodes.findIndex((node) => node.id === a.anchorId)
    - graph.nodes.findIndex((node) => node.id === b.anchorId));
  const usedIds = new Set(scene.pages.flatMap((candidate) => candidate.components.map((component) => component.id)));
  const supplements = buckets.flatMap((nodes, index): TeachingVisualComponent[] => {
    if (!nodes.length) return [];
    let id = `${primary.id}:annotations-${index + 1}`;
    while (usedIds.has(id)) id += ':reflow';
    usedIds.add(id);
    const owners = [...new Set(nodes.map((node) => node.anchorId))];
    return [{ id, kind: 'text', role: 'support', nodes,
      ...(owners.length === 1 ? { anchorNodeId: owners[0], title: anchor(owners[0])!.label } : {}) }];
  });
  if (!supplements.length) return null;
  const replacement = { ...page, components: [{ ...primary, nodes: [] }, ...supplements, ...takeaways] };
  // Choose the one bounded replan from real panel/label measurements. When
  // these complete notes cannot fit, retain the established split-page option.
  const context: Context = { ...options, outline, page: replacement, variant: 0 };
  try {
    const title = await text('reflow-heading-measure', page.title, { left: 50, top: 28, width: 900 }, context,
      { size: T.title, bold: true, color: T.text });
    const top = Math.max(112, bottom(title) + 14);
    const body = { left: 44, top, width: 912, height: 532.5 - top };
    const rects = await componentRects(replacement.components, body, 0, context);
    if (!await iconSequence(replacement.components[0]!, rects[0]!, context)) return null;
  } catch (error) {
    if (error instanceof VisualCapacityMiss) return null;
    throw error;
  }
  return { ...scene, pages: scene.pages.map((candidate) => candidate === page ? replacement : candidate) };
}

export async function compileTeachingVisualScene(outline: SceneOutline, scene: TeachingVisualScene,
  options: TeachingVisualCompilerOptions): Promise<GeneratedSlideContent | null> {
  if (scene.schemaVersion !== 1 || scene.designVersion !== 'teaching-visual-v2' || !scene.pages.length) return null;
  if (options.allowSplit === false && scene.pages.length !== 1) return null;
  let failedPageId = '';
  const completedPages = new Map<TeachingVisualPage, GeneratedSlideContent>();
  async function compile(target: TeachingVisualScene) {
    const pages: GeneratedSlideContent[] = [];
    for (const page of target.pages) {
      const localAssets = (options.images ?? []).filter((image) => page.components.some((component) => component.resourceId === image.id));
      const compiled = completedPages.get(page) ?? await compilePage(outline, target, page, { ...options, images: localAssets,
        recentCandidateIds: [...(options.recentCandidateIds ?? []), ...pages.flatMap((prior) => prior.teachingVisual ? [prior.teachingVisual.candidateId] : [])] });
      if (!compiled) { failedPageId = page.id; return null; }
      completedPages.set(page, compiled);
      // Retained page geometry is already measured; attach the final scene so
      // every split sibling shares the same teaching contract and page count.
      if (compiled.teachingVisual?.scene !== target) {
        compiled.teachingVisual = { ...compiled.teachingVisual!, scene: target };
        if (compiled.layoutMeasurement) compiled.layoutMeasurement.pageCount = target.pages.length;
      }
      pages.push(compiled);
    }
    if ((options.images ?? []).some((image) => !pages.some((page) => page.elements.some((element) => element.type === 'image' && element.id === image.id)))) return null;
    const [first, ...continuations] = pages;
    if (!first) return null;
    return { ...first, ...(continuations.length ? { continuationPages: continuations } : {}) };
  }
  const first = await compile(scene);
  const priorVisual = options.previous?.teachingVisual;
  const hasProtectedEdits = priorVisual?.modifiedSlide || Boolean(priorVisual?.manualElementIds?.length)
    || priorVisual?.components.some((component) => component.locked || component.modified);
  // A usable legacy draft is a fallback, not a ban on bounded pagination.
  // Structural replanning must still leave teacher-owned edits in place.
  if (first || options.allowSplit === false || hasProtectedEdits) return first;
  const replanned = await reflowAdoptedAnnotations(scene, failedPageId, outline, options)
    ?? await splitAdoptedCompanions(scene, failedPageId, outline, options)
    ?? splitImageCompanions(scene, failedPageId, outline)
    ?? splitIndependentComponents(scene, failedPageId, outline);
  if (!replanned) return null;
  const result = await compile(replanned);
  return result ? { ...result, qualityDiagnostics: [...(result.qualityDiagnostics ?? []),
    'Teaching visual: one local replan retained the complete text, directed relationships and adopted original graph.',
    ...(replanned.pages.some((page) => page.id.includes(':image-explanation')) ? [
      'Teaching visual: the adopted image and full observation legend share one page; existing explanation follows without speculative pixel connectors.',
    ] : [])] } : null;
}
