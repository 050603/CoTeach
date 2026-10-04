import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement, SlidePresentationItem, SlidePresentationProjection } from '@openmaic/dsl';
import { compileMeasuredDiagramComponent, DiagramAllocationError, measureDiagramAllocations, type DiagramPlan, type TextMeasure } from '@openmaic/generation';
import { slidePresentationLabel } from './slide-visual-projection';
import { presentationRichText } from './slide-presentation-text';

type Rect = { left: number; top: number; width: number; height: number };
type Link = NonNullable<SlidePresentationProjection['links']>[number];
type Options = { items: SlidePresentationItem[]; links: Link[]; rect: Rect; font: number; measure: TextMeasure };
type Block = { elements: PPTElement[]; height: number; boxes: Map<string, Rect>; mapping: Record<string, string[]> };
const PREFIX = 'infographic-authored-relations';
const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

async function pairRelation(items: SlidePresentationItem[], link: Link, rect: Rect, font: number, measure: TextMeasure): Promise<Block | null> {
  const labelFont = Math.max(20, font), labelWidth = link.label ? Math.max(180, Math.min(260, Array.from(link.label).length * labelFont + 20)) : 64;
  const gap = labelWidth + 24, width = (rect.width - gap) / 2;
  if (width < 260) return null;
  const positions = [link.from, link.to].map((id) => items.find((item) => item.id === id)!);
  const elements: PPTElement[] = [], boxes = new Map<string, Rect>(), mapping: Record<string, string[]> = {};
  const nodes: PPTShapeElement[] = [];
  for (const [index, item] of positions.entries()) {
    const label = slidePresentationLabel(item.label);
    const content = `${label ? `<p style="font-size:${Math.max(20, font)}px;font-weight:700">${escape(label)}</p>` : ''}<p style="font-size:${font}px;font-weight:400">${presentationRichText(item.text, item.emphasis, item.emphasisStyle)}</p>`;
    const geometry = await measure({ html: content, text: [label, item.text].filter(Boolean).join('\n'), width,
      fontSize: font, fontWeight: 400, fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'center', preserveRichText: true });
    const node: PPTShapeElement = { id: `${PREFIX}-node-${encodeURIComponent(item.id)}`, type: 'shape',
      left: rect.left + index * (width + gap), top: rect.top, width, height: Math.max(100, Math.ceil(geometry.height + 1)),
      rotate: 0, viewBox: [100, 100], path: 'M0 0H100V100H0Z', fixedRatio: false,
      fill: index === 0 ? '#EFF6FF' : '#FFF7ED',
      text: { content, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', align: 'middle', lineHeight: 1.5, paragraphSpace: 5 } };
    nodes.push(node);
    for (const source of item.sourceContentIds) mapping[source] = [...new Set([...(mapping[source] ?? []), node.id])];
  }
  let label: PPTTextElement | undefined;
  if (link.label) {
    const content = `<p style="font-size:${labelFont}px;text-align:center;color:#475569">${escape(link.label)}</p>`;
    const geometry = await measure({ html: content, text: link.label, width: labelWidth, fontSize: labelFont, fontWeight: 400,
      fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'center', preserveRichText: true });
    label = { id: `${PREFIX}-edge-label-0`, type: 'text', left: rect.left + width + 12, top: rect.top,
      width: labelWidth, height: Math.ceil(geometry.height + 1), rotate: 0, content,
      defaultFontName: 'Noto Sans SC', defaultColor: '#475569', lineHeight: 1.5, paragraphSpace: 5 };
  }
  const height = Math.max(...nodes.map((node) => node.height), label ? label.height * 2 + 16 : 0);
  if (height > rect.height || label && label.height > labelFont * 3 + 21) return null;
  for (const [index, node] of nodes.entries()) {
    node.top += (height - node.height) / 2;
    elements.push(node); boxes.set(positions[index]!.id, node);
  }
  const arrowY = rect.top + height / 2;
  const line: PPTLineElement = { id: `${PREFIX}-edge-0`, type: 'line', left: rect.left + width + 8, top: arrowY,
    width: 2, start: [0, 0], end: [gap - 16, 0], color: '#64748B', style: 'solid', points: ['', 'arrow'] };
  elements.push(line);
  if (label) { label.top = arrowY - label.height - 8; elements.push(label); }
  return { elements, height, boxes, mapping };
}

function validGraph(items: SlidePresentationItem[], links: Link[]): boolean {
  if (items.length < 2 || items.length > 12 || !links.length) return false;
  const known = new Set(items.map((item) => item.id)), edges = new Set<string>(), used = new Set<string>();
  if (known.size !== items.length || items.some((item) => !item.id.trim() || !item.text.trim())) return false;
  const incoming = new Map(items.map((item) => [item.id, 0])), outgoing = new Map(items.map((item) => [item.id, [] as string[]]));
  for (const link of links) {
    if (!known.has(link.from) || !known.has(link.to) || link.from === link.to
      || (link.label !== undefined && !link.label.trim())) return false;
    const key = JSON.stringify([link.from, link.to]);
    if (edges.has(key)) return false;
    edges.add(key); used.add(link.from); used.add(link.to);
    incoming.set(link.to, incoming.get(link.to)! + 1); outgoing.get(link.from)!.push(link.to);
  }
  if (used.size !== known.size) return false;
  const roots = items.filter((item) => incoming.get(item.id) === 0).map((item) => item.id);
  if (roots.length !== 1) return false;
  for (let index = 0; index < roots.length; index += 1) {
    for (const to of outgoing.get(roots[index]!)!) {
      incoming.set(to, incoming.get(to)! - 1);
      if (incoming.get(to) === 0) roots.push(to);
    }
  }
  return roots.length === items.length;
}

function extent(element: PPTElement): Rect {
  if (element.type !== 'line') {
    const padding = element.type === 'shape' ? (element.outline?.width ?? 0) / 2 : 0;
    return { left: element.left - padding, top: element.top - padding, width: element.width + 2 * padding, height: element.height + 2 * padding };
  }
  const points = [element.start, element.end, ...(element.cubic ?? []), ...(element.curve ? [element.curve] : []),
    ...(element.broken ? [element.broken] : []), ...(element.broken2 ? [element.broken2] : [])];
  // Include arrowheads and stroke, not merely the line's endpoint coordinates.
  const padding = 8, x = points.map((point) => point[0] + element.left), y = points.map((point) => point[1] + element.top);
  const left = Math.min(...x) - padding, top = Math.min(...y) - padding;
  return { left, top, width: Math.max(...x) + padding - left, height: Math.max(...y) + padding - top };
}

/** Compile only the author's explicit DAG. Branch topology never invents a
 * relationship between adjacent input items or between sibling concepts. */
export async function layoutAuthoredRelations({ items, links, rect, font, measure }: Options): Promise<Block | null> {
  if (!validGraph(items, links) || !Object.values(rect).every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(font) || font <= 0 || font > 20) return null;
  // The native compiler has a fixed 20px node font. Larger typography must use
  // another renderer, rather than silently shrinking the adopted body font.
  const cache = new Map<string, ReturnType<TextMeasure>>();
  const measured: TextMeasure = async (request) => {
    const key = JSON.stringify(request);
    if (!cache.has(key)) cache.set(key, measure(request));
    const result = await cache.get(key)!;
    if (!Number.isFinite(result.naturalWidth) || !Number.isFinite(result.height) || result.height <= 0) {
      throw new Error('Authored relation measurement returned invalid geometry');
    }
    return result;
  };
  const nodeId = (id: string) => encodeURIComponent(id);
  if (items.length === 2 && links.length === 1) {
    const pair = await pairRelation(items, links[0]!, rect, font, measured);
    if (pair) return pair;
  }
  const plan: DiagramPlan = { topology: 'branch', nodes: items.map((item) => ({ id: nodeId(item.id), label: [slidePresentationLabel(item.label), item.text].filter(Boolean).join('\n') })),
    edges: links.map((link) => ({ from: nodeId(link.from), to: nodeId(link.to), ...(link.label ? { label: link.label } : {}) })) };
  try {
    const allocations = await measureDiagramAllocations(plan, measured,
      { left: 50, top: 50, maxWidth: Math.min(900, rect.width), maxHeight: Math.min(462.5, rect.height) });
    for (const allocation of allocations.sort((a, b) => a.height - b.height || b.width - a.width)) {
      const compiled = await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: PREFIX, left: 50, top: 50,
        ...allocation, accentColor: '#64748B', nodeFill: '#EFF6FF', textColor: '#1E3A8A' }, measured, { feasibleAllocations: allocations });
      const bounds = compiled.map(extent), left = Math.min(...bounds.map((box) => box.left)), top = Math.min(...bounds.map((box) => box.top));
      const width = Math.max(...bounds.map((box) => box.left + box.width)) - left;
      const height = Math.max(...bounds.map((box) => box.top + box.height)) - top;
      if (width > rect.width || height > rect.height) continue;
      const targetLeft = rect.left + (rect.width - width) / 2;
      const elements = compiled.map((element) => ({ ...element, left: targetLeft + element.left - left, top: rect.top + element.top - top }));
      const boxes = new Map<string, Rect>(), mapping: Record<string, string[]> = {};
      for (const item of items) {
        const id = `${PREFIX}-node-${nodeId(item.id)}`, element = elements.find((candidate) => candidate.id === id);
        if (!element || element.type !== 'shape' || !element.text) return null;
        const source = !links.some((link) => link.to === item.id), sink = !links.some((link) => link.from === item.id);
        element.fill = sink ? '#FFF7ED' : '#EFF6FF';
        element.outline = { color: source ? '#1E3A8A' : sink ? '#0F766E' : '#93C5FD', width: 1.5, style: 'solid' };
        element.text.defaultColor = '#334155';
        boxes.set(item.id, { left: element.left, top: element.top, width: element.width, height: element.height });
        for (const sourceId of item.sourceContentIds) mapping[sourceId] = [...new Set([...(mapping[sourceId] ?? []), element.id])];
      }
      return { elements, height, boxes, mapping };
    }
    return null;
  } catch (error) {
    if (error instanceof DiagramAllocationError || (error instanceof Error && error.name === 'DiagramAllocationError')) return null;
    throw error;
  }
}
