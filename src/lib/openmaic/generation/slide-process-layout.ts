import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement, SlidePresentationItem } from '@openmaic/dsl';
import { resolveDiagramSequenceGroups, type DiagramPlan, type TextMeasure } from '@openmaic/generation';
import { slidePresentationLabel } from './slide-visual-projection';
import { presentationRichText } from './slide-presentation-text';

type Rect = { left: number; top: number; width: number; height: number };
type ProcessItem = SlidePresentationItem & { diagramNodeId?: string };
type Options = { diagram: DiagramPlan; items: ProcessItem[]; measure: TextMeasure; font: number; rect: Rect };
type Result = { elements: PPTElement[]; height: number; mapping: Record<string, string[]> };
const FONT = 'Noto Sans SC';
const COLORS = { blue: '#1E3A8A', teal: '#0E7490', text: '#334155', muted: '#64748B', line: '#94A3B8', accent: '#C56A24' };
const unnumbered = (value: string) => value.trim().replace(/^(?:第\s*[一二三四五六七八九十\d]+\s*步|\d+\s*[、.．:：)）]|\d+\s+)\s*/u, '');

function matchingNode(item: ProcessItem, diagram: DiagramPlan): string | undefined {
  if (item.diagramNodeId !== undefined) return diagram.nodes.find((node) => node.id === item.diagramNodeId)?.id;
  if (!item.label) return undefined;
  const label = unnumbered(item.label);
  const matches = diagram.nodes.filter((node) => {
    const title = unnumbered(node.label);
    return label === title || label.startsWith(`${title}·`) || label.startsWith(`${title}：`);
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}

async function text(id: string, value: string, rect: Pick<Rect, 'left' | 'top' | 'width'>,
  fontSize: number, measure: TextMeasure, color: string, bold = false, emphasis: string[] = [], emphasisStyle?: SlidePresentationItem['emphasisStyle']): Promise<PPTTextElement> {
  const rich = presentationRichText(value, emphasis, emphasisStyle, color);
  const content = `<p style="font-size:${fontSize}px;font-weight:${bold ? 700 : 400};color:${color}">${rich}</p>`;
  const measured = await measure({ html: content, text: value, width: rect.width, fontSize, fontWeight: bold ? 700 : 400,
    fontFamily: FONT, padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left', preserveRichText: true });
  if (!Number.isFinite(measured.height) || measured.height <= 0 || !Number.isFinite(measured.naturalWidth)) {
    throw new Error('Teaching sequence text measurement returned invalid geometry');
  }
  return { type: 'text', id, ...rect, height: Math.ceil(measured.height + 1), rotate: 0, content,
    defaultFontName: FONT, defaultColor: color, lineHeight: 1.5, paragraphSpace: 5 };
}

function rule(id: string, rect: Rect, color: string): PPTShapeElement {
  return { type: 'shape', id, ...rect, rotate: 0, viewBox: [rect.width, rect.height],
    path: `M0 0H${rect.width}V${rect.height}H0Z`, fixedRatio: false, fill: color };
}

function line(id: string, start: [number, number], end: [number, number]): PPTLineElement {
  const left = Math.min(start[0], end[0]), top = Math.min(start[1], end[1]);
  return { type: 'line', id, left, top, width: 1.5, start: [start[0] - left, start[1] - top],
    end: [end[0] - left, end[1] - top], color: COLORS.line, style: 'solid', points: ['', 'arrow'] };
}

/** Integrate each explanation with its actual step. Unsupported relationships
 * retain the general graph renderer; no branch, feedback or group is flattened. */
export async function layoutTeachingSequence({ diagram, items, measure, font, rect }: Options): Promise<Result | null> {
  if (diagram.topology !== 'sequence' || diagram.nodes.length < 2 || diagram.nodes.length > 9
    || !Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const groups = resolveDiagramSequenceGroups(diagram);
  if (groups && (groups.length !== 1 || groups[0]!.label)) return null;
  const ordered = groups ? groups[0]!.nodeIds.map((id) => diagram.nodes.find((node) => node.id === id)!) : diagram.nodes;
  if (new Set(ordered.map((node) => node.id)).size !== ordered.length) return null;
  const indices = new Map(ordered.map((node, index) => [node.id, index]));
  const edges = new Map<string, string | undefined>();
  for (const edge of diagram.edges ?? []) {
    const from = indices.get(edge.from), to = indices.get(edge.to);
    if (from === undefined || to !== from + 1 || edges.has(edge.from)) return null;
    edges.set(edge.from, edge.label);
  }
  const itemNodes = items.map((item) => matchingNode(item, diagram));
  if (itemNodes.some((id) => !id)) return null;
  const grouped = ordered.map((node) => items.filter((_, index) => itemNodes[index] === node.id));
  const hasLabels = [...edges.values()].some(Boolean);
  if (!items.length && !hasLabels) {
    const elements: PPTElement[] = [], mapping: Record<string, string[]> = {}, headings: PPTTextElement[] = [];
    let cursor = rect.top;
    for (const node of ordered) {
      const heading = await text(`infographic-diagram-node-${node.id}`, node.label,
        { left: rect.left + 28, top: cursor, width: rect.width - 28 }, Math.max(font, 20), measure, COLORS.text, true);
      elements.push(heading); headings.push(heading); mapping[`diagram-node:${node.id}`] = [heading.id];
      cursor += heading.height + 2;
    }
    const height = cursor - 2 - rect.top;
    if (height <= rect.height) {
      for (const [index, heading] of headings.entries()) {
        const x = rect.left + 14, y = heading.top + heading.height / 2;
        elements.push(rule(`infographic-step-marker-${ordered[index]!.id}`, { left: x - 4, top: y - 4, width: 8, height: 8 }, COLORS.teal));
        if (index + 1 < headings.length) elements.push(line(`infographic-diagram-edge-${index}`,
          [x, y + 8], [x, headings[index + 1]!.top + headings[index + 1]!.height / 2 - 8]));
      }
      return { elements, height, mapping };
    }
  }
  const columnOptions = ordered.length <= 3 ? [ordered.length, 2, 1] : ordered.length === 4 ? [2, 3] : [3, 2];
  for (const columns of [...new Set(columnOptions)]) {
    const columnGap = hasLabels ? 100 : 36, rowGap = hasLabels ? 76 : 42;
    const width = (rect.width - (columns - 1) * columnGap) / columns;
    if (width < 190) continue;
    const elements: PPTElement[] = [], mapping: Record<string, string[]> = {}, boxes: Rect[] = [];
    const headings: PPTTextElement[] = [];
    let rowTop = rect.top;
    for (let start = 0; start < ordered.length; start += columns) {
      const row = Math.floor(start / columns), heights: number[] = [];
      for (let offset = 0; offset < columns && start + offset < ordered.length; offset += 1) {
        const index = start + offset, node = ordered[index]!, members = grouped[index]!;
        const column = offset, left = rect.left + column * (width + columnGap);
        const color = index === ordered.length - 1 ? COLORS.accent : row % 2 ? COLORS.teal : COLORS.blue;
        // Keep an adopted numbered title verbatim for source coverage, without
        // prepending a second decorative number to the same visible heading.
        const numberedTitle = unnumbered(node.label) !== node.label.trim();
        const number = numberedTitle ? undefined : await text(`infographic-step-${node.id}`, String(index + 1).padStart(2, '0'),
          { left, top: rowTop, width: 44 }, 18, measure, color, true);
        const headingInset = number ? 44 : 0;
        const heading = await text(`infographic-diagram-node-${node.id}`, node.label,
          { left: left + headingInset, top: rowTop, width: width - headingInset }, Math.max(font, 22), measure, COLORS.text, true);
        if (number) elements.push(number);
        elements.push(heading);
        headings.push(heading);
        let cursor = rowTop + Math.max(number?.height ?? 0, heading.height) + 4;
        const bodyIds: string[] = [];
        for (const item of members) {
          const itemLabel = slidePresentationLabel(item.label);
          const label = itemLabel && !unnumbered(node.label).includes(unnumbered(itemLabel)) ? `${itemLabel}\n` : '';
          const body = await text(item.id, `${label}${item.text}`, { left, top: cursor, width }, font, measure, COLORS.text, false, item.emphasis, item.emphasisStyle);
          elements.push(body); bodyIds.push(body.id); cursor += body.height + 2;
          for (const source of item.sourceContentIds) mapping[source] = [...new Set([...(mapping[source] ?? []), heading.id, body.id])];
        }
        const height = cursor - rowTop + 9;
        elements.push(rule(`infographic-step-rule-${node.id}`, { left: left + 10, top: cursor + 4, width: width - 20, height: 1 }, '#E2E8F0'));
        mapping[`diagram-node:${node.id}`] = [heading.id, ...bodyIds];
        boxes.push({ left, top: rowTop, width, height }); heights.push(height);
      }
      rowTop += Math.max(...heights) + rowGap;
    }
    const height = rowTop - rowGap - rect.top;
    if (height > rect.height) continue;
    let fits = true;
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const from = boxes[index]!, to = boxes[index + 1]!, edgeLabel = edges.get(ordered[index]!.id);
      const id = `infographic-diagram-edge-${index}`, sameRow = from.top === to.top;
      let start: [number, number], end: [number, number];
      let label: PPTTextElement | undefined;
      if (sameRow) {
        const forward = to.left > from.left, corridorLeft = forward ? from.left + width : to.left + width;
        if (edgeLabel) label = await text(`${id}-label`, edgeLabel, { left: corridorLeft + 2, top: from.top, width: columnGap - 4 }, font, measure, COLORS.muted);
        const y = Math.max(from.top + headings[index]!.height / 2, label ? label.top + label.height + 6 : 0);
        if (y + 6 > rect.top + height) { fits = false; break; }
        start = [forward ? from.left + width + 6 : from.left - 6, y];
        end = [forward ? to.left - 6 : to.left + width + 6, y];
      } else {
        const x = from.left + width / 2, top = from.top + from.height + 6;
        start = [x, top]; end = [to.left + width / 2, to.top - 6];
        if (edgeLabel) {
          label = await text(`${id}-label`, edgeLabel, { left: x + 6, top, width: width / 2 - 12 }, font, measure, COLORS.muted);
          if (label.top + label.height > end[1]) { fits = false; break; }
        }
      }
      const connector = line(id, start, end);
      if (!sameRow && start[0] !== end[0]) {
        const y = (start[1] + end[1]) / 2;
        connector.broken = [start[0] - connector.left, y - connector.top];
        connector.broken2 = [end[0] - connector.left, y - connector.top];
      }
      elements.push(connector);
      if (label) elements.push(label);
    }
    if (fits) return { elements, height, mapping };
  }
  return null;
}
