import type { PPTElement, PPTImageElement, PPTLineElement, PPTShapeElement, PPTTableElement, PPTTextElement, SlidePresentationItem, SlidePresentationProjection, TableCell } from '@openmaic/dsl';
import { compileMeasuredDiagramComponent, DiagramAllocationError, measureDiagramAllocations, resolveDiagramSequenceGroups, type TextMeasure } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { slideTypography } from './slide-presentation-typography';
import { adoptedPageAuthoringContent, pagePresentationContent } from './adopted-page-content';

type Rect = { left: number; top: number; width: number; height: number };
type ImageInput = { id: string; src: string; width: number; height: number; caption?: string };
type Options = { measure: TextMeasure; images?: ImageInput[] };
type Block = { elements: PPTElement[]; height: number; boxes: Map<string, Rect>; mapping: Record<string, string[]> };
const PALETTE = { title: '#1E3A8A', text: '#334155', muted: '#64748B', pale: '#EFF6FF', line: '#CBD5E1', accent: '#ED7D31' };
const LEFT = 50, WIDTH = 900, BOTTOM = 512.5, GAP = 22;
const FONT = 'Noto Sans SC';
const escape = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/\n/gu, '<br>');

function marked(text: string, emphasis: readonly string[] = []): string {
  const terms = [...new Set(emphasis.filter((term) => term && text.includes(term)))].sort((a, b) => b.length - a.length);
  let result = '', cursor = 0;
  while (cursor < text.length) {
    const term = terms.find((term) => text.startsWith(term, cursor));
    if (term) { result += `<strong style="color:${PALETTE.title}">${escape(term)}</strong>`; cursor += term.length; }
    else { result += escape(text[cursor]!); cursor += 1; }
  }
  return result;
}

async function textElement(id: string, text: string, rect: Pick<Rect, 'left' | 'top' | 'width'>, fontSize: number,
  measure: TextMeasure, options: { bold?: boolean; color?: string; emphasis?: string[]; table?: boolean; label?: string } = {}): Promise<PPTTextElement> {
  const content = `<p style="font-size:${fontSize}px;font-weight:${options.bold ? 700 : 400};color:${options.color ?? PALETTE.text}">${options.label ? `<strong style="font-size:${Math.max(20, fontSize)}px;color:${PALETTE.title}">${escape(options.label)}：</strong>` : ''}${marked(text, options.emphasis)}</p>`;
  const measured = await measure({ html: content, text: options.label ? `${options.label}：${text}` : text, width: rect.width, fontSize, fontWeight: options.bold ? 700 : 400,
    fontFamily: FONT, padding: options.table ? 0 : 10, lineHeight: options.table ? 1 : 1.5, paragraphSpace: options.table ? 0 : 5,
    align: 'left', preserveRichText: true, ...(options.table ? { tableCell: true, paddingCss: '10px 12px' } : {}) });
  if (!Number.isFinite(measured.height) || measured.height <= 0 || !Number.isFinite(measured.naturalWidth)) {
    throw new Error('Infographic text measurement returned invalid geometry');
  }
  return { type: 'text', id, ...rect, height: Math.ceil(measured.height + 1), rotate: 0, content,
    defaultFontName: FONT, defaultColor: options.color ?? PALETTE.text, lineHeight: options.table ? 1 : 1.5, paragraphSpace: options.table ? 0 : 5 };
}

function surface(id: string, rect: Rect, fill: string): PPTShapeElement {
  return { id, type: 'shape', ...rect, rotate: 0, fixedRatio: false, viewBox: [rect.width, rect.height],
    path: `M0 0H${rect.width}V${rect.height}H0Z`, fill };
}
/** Stable targets for the existing narration contract. These transparent
 * rectangles contain no teaching text and never enter source coverage maps. */
function withSemanticTargetAliases(outline: SceneOutline, content: GeneratedSlideContent): GeneratedSlideContent {
  const projection = content.presentationProjection;
  if (!projection) return content;
  const catalog = adoptedPageAuthoringContent(outline), diagram = outline.visualIntent?.diagram;
  const aliases = pagePresentationContent(outline).flatMap((text, index) => {
    const id = `${outline.id}:visible-${index + 1}`;
    if (content.elements.some((element) => element.id === id)) return [];
    const exact = text.trim();
    const sources = [
      ...catalog.filter((item) => item.text.trim() === exact).map((item) => item.id),
      ...(diagram?.nodes.filter((node) => node.label.trim() === exact).map((node) => `diagram-node:${node.id}`) ?? []),
      ...(diagram?.annotation?.trim() === exact ? ['diagram-annotation'] : []),
    ];
    const targetIds = new Set(sources.flatMap((source) => projection.elementIdsBySource[source] ?? []));
    const targets = content.elements.filter((element) => targetIds.has(element.id)
      && ((element.type === 'text' && element.content.trim()) || (element.type === 'shape' && element.text?.content.trim())
        || (element.type === 'table' && element.data.some((row) => row.some((cell) => cell.text.trim())))));
    const rectangles = targets.filter((element) => element.type !== 'line');
    if (!rectangles.length) return [];
    const left = Math.min(...rectangles.map((element) => element.left)), top = Math.min(...rectangles.map((element) => element.top));
    const width = Math.max(...rectangles.map((element) => element.left + element.width)) - left;
    const height = Math.max(...rectangles.map((element) => element.top + element.height)) - top;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{ ...surface(id, { left, top, width, height }, 'none'), opacity: 0 }];
  });
  return aliases.length ? { ...content, elements: [...content.elements, ...aliases] } : content;
}

function addMapping(mapping: Record<string, string[]>, sources: readonly string[], ids: readonly string[]): void {
  for (const source of sources) mapping[source] = [...new Set([...(mapping[source] ?? []), ...ids])];
}
function intersect(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width - 0.5 && b.left < a.left + a.width - 0.5
    && a.top < b.top + b.height - 0.5 && b.top < a.top + a.height - 0.5;
}

async function comparison(items: SlidePresentationItem[], top: number, font: number, measure: TextMeasure, region = { left: LEFT, width: WIDTH }): Promise<Block | null> {
  if (!items.length || items.some((item) => !item.row || !item.column)) return null;
  const rows = [...new Set(items.map((item) => item.row!))], columns = [...new Set(items.map((item) => item.column!))];
  if (columns.length < 2 || items.length !== rows.length * columns.length
    || new Set(items.map((item) => JSON.stringify([item.row, item.column]))).size !== items.length) return null;
  const firstWidth = Math.max(130, Math.min(190, region.width / (columns.length + 1)));
  const widths = [firstWidth, ...columns.map(() => (region.width - firstWidth) / columns.length)];
  if (widths.some((width) => width < 140)) return null;
  const data: TableCell[][] = [], rowHeights: number[] = [], mapping: Record<string, string[]> = {};
  for (let rowIndex = 0; rowIndex <= rows.length; rowIndex += 1) {
    const cells: TableCell[] = [], heights: number[] = [];
    for (let columnIndex = 0; columnIndex <= columns.length; columnIndex += 1) {
      const item = rowIndex && columnIndex ? items.find((candidate) => candidate.row === rows[rowIndex - 1] && candidate.column === columns[columnIndex - 1])! : undefined;
      const value = item ? `${item.label ? `${item.label}：` : ''}${item.text}` : rowIndex ? rows[rowIndex - 1]! : columnIndex ? columns[columnIndex - 1]! : '比较维度';
      const id = item?.id ?? `infographic-table-heading-${rowIndex}-${columnIndex}`;
      const header = rowIndex === 0 || columnIndex === 0;
      const element = await textElement(id, value, { left: 0, top: 0, width: widths[columnIndex]! - 2 }, font, measure,
        { table: true, bold: header, color: PALETTE.text, emphasis: item?.emphasis });
      heights.push(element.height + 4);
      cells.push({ id, text: element.content, rowspan: 1, colspan: 1, padding: '10px 12px', vAlign: 'middle',
        style: { fontname: FONT, fontsize: `${font}px`, color: PALETTE.text, bold: header,
          backcolor: rowIndex === 0 ? PALETTE.pale : columnIndex === 0 ? '#F1F5F9' : '#FFFFFF' } });
      if (item) addMapping(mapping, item.sourceContentIds, ['infographic-comparison']);
    }
    data.push(cells); rowHeights.push(Math.max(44, ...heights));
  }
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + 2;
  const table: PPTTableElement = { type: 'table', id: 'infographic-comparison', left: region.left, top, width: region.width, height, rotate: 0,
    outline: { color: PALETTE.line, width: 1, style: 'solid' }, colWidths: widths.map((width) => width / region.width),
    cellMinHeight: 40, rowHeights, data };
  return { elements: [table], height, boxes: new Map(), mapping };
}

async function contentBlocks(items: SlidePresentationItem[], columns: number, top: number, font: number, measure: TextMeasure,
  links: SlidePresentationProjection['links'], region = { left: LEFT, width: WIDTH }, compact = false): Promise<Block | null> {
  const gap = links?.length ? 72 : GAP;
  const width = (region.width - (columns - 1) * gap) / columns;
  if (width < 140) return null;
  const elements: PPTElement[] = [], boxes = new Map<string, Rect>(), mapping: Record<string, string[]> = {};
  let rowTop = top;
  for (let start = 0; start < items.length; start += columns) {
    const heights: number[] = [];
    for (const [column, item] of items.slice(start, start + columns).entries()) {
      const left = region.left + column * (width + gap), children: PPTElement[] = [];
      let textTop = rowTop;
      if (item.label && !compact) {
        const label = await textElement(`${item.id}-heading`, item.label, { left: left + 8, top: textTop, width: width - 8 }, Math.max(20, font), measure, { bold: true, color: PALETTE.title });
        children.push(label); textTop += label.height + 2;
      }
      const body = await textElement(item.id, item.text, { left: left + 8, top: textTop, width: width - 8 }, font, measure, { emphasis: item.emphasis, ...(compact ? { label: item.label } : {}) });
      children.push(body);
      const height = body.top + body.height - rowTop;
      const rule = surface(`${item.id}-rule`, { left, top: rowTop + 11, width: 3, height: Math.min(28, height - 11) }, PALETTE.title);
      elements.push(rule, ...children);
      boxes.set(item.id, { left, top: rowTop, width, height });
      addMapping(mapping, item.sourceContentIds, [rule.id, ...children.map((child) => child.id)]);
      heights.push(height);
    }
    rowTop += Math.max(...heights) + gap;
  }
  for (const [index, link] of (links ?? []).entries()) {
    const from = boxes.get(link.from), to = boxes.get(link.to);
    if (!from || !to) return null;
    let start: [number, number], end: [number, number], corridor: Rect;
    if (Math.abs(from.top - to.top) < 1) {
      const forward = to.left > from.left;
      const y = from.top + Math.min(from.height, to.height) / 2;
      start = [forward ? from.left + from.width + 8 : from.left - 8, y];
      end = [forward ? to.left - 8 : to.left + to.width + 8, y];
      corridor = { left: Math.min(start[0], end[0]), top: y - 12, width: Math.abs(end[0] - start[0]), height: 24 };
    } else if (Math.abs(from.left - to.left) < 1) {
      const forward = to.top > from.top, x = from.left + from.width / 2;
      start = [x, forward ? from.top + from.height + 8 : from.top - 8];
      end = [x, forward ? to.top - 8 : to.top + to.height + 8];
      corridor = { left: x - 12, top: Math.min(start[1], end[1]), width: 24, height: Math.abs(end[1] - start[1]) };
    } else return null;
    if ([...boxes.entries()].some(([id, box]) => id !== link.from && id !== link.to && intersect(corridor, box))) return null;
    const line: PPTLineElement = { type: 'line', id: `infographic-link-${index}`, left: Math.min(start[0], end[0]), top: Math.min(start[1], end[1]),
      width: 2, start: [start[0] - Math.min(start[0], end[0]), start[1] - Math.min(start[1], end[1])],
      end: [end[0] - Math.min(start[0], end[0]), end[1] - Math.min(start[1], end[1])], style: 'solid', color: PALETTE.title, points: ['', 'arrow'] };
    elements.push(line);
    const linkedSources = items.filter((item) => item.id === link.from || item.id === link.to).flatMap((item) => item.sourceContentIds);
    addMapping(mapping, linkedSources, [line.id]);
    if (link.label) {
      const horizontal = start[1] === end[1];
      const labelWidth = horizontal ? corridor.width : Math.min(width / 2 - 15, 180);
      if (labelWidth < 40) return null;
      const label = await textElement(`${line.id}-label`, link.label, { left: horizontal ? corridor.left : start[0] + 8,
        top: horizontal ? start[1] - 42 : corridor.top, width: labelWidth }, font, measure, { color: PALETTE.muted });
      if ((horizontal && label.height > 40) || (!horizontal && label.height > corridor.height)
        || [...boxes.values()].some((box) => intersect(label, box))) return null;
      elements.push(label);
      addMapping(mapping, linkedSources, [label.id]);
    }
  }
  return { elements, height: items.length ? rowTop - gap - top : 0, boxes, mapping };
}

function matchingNodeLabel(item: SlidePresentationItem, labels: readonly string[]): string | undefined {
  if (!item.label) return undefined;
  const matches = labels.filter((label) => item.label === label || item.label!.startsWith(`${label}·`) || item.label!.startsWith(`${label}：`));
  return matches.length === 1 ? matches[0] : undefined;
}

async function nodeExplanations(items: SlidePresentationItem[], nodes: PPTShapeElement[], top: number, font: number, measure: TextMeasure): Promise<Block | null> {
  if (!items.length || !nodes.length || new Set(nodes.map((node) => node.top)).size !== 1) return null;
  const elements: PPTElement[] = [], mapping: Record<string, string[]> = {}, boxes = new Map<string, Rect>();
  const labels = nodes.map((node) => node.text?.content.replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&') ?? '');
  const groups = nodes.flatMap((node, index) => {
    const label = labels[index]!;
    const members = items.filter((item) => matchingNodeLabel(item, labels) === label);
    return members.length ? [{ node, label, members }] : [];
  }).sort((a, b) => a.node.left - b.node.left);
  if (groups.reduce((total, group) => total + group.members.length, 0) !== items.length) return null;
  // Only annotated nodes need explanation columns. Their actual positions set
  // shared boundaries, leaving room around stages with no adopted explanation.
  const centres = groups.map(({ node }) => node.left + node.width / 2);
  for (const [index, group] of groups.entries()) {
    const singleWidth = Math.min(440, WIDTH);
    const left = groups.length === 1 ? Math.max(LEFT, Math.min(LEFT + WIDTH - singleWidth, centres[index]! - singleWidth / 2))
      : index === 0 ? LEFT : (centres[index - 1]! + centres[index]!) / 2 + 8;
    const right = groups.length === 1 ? left + singleWidth
      : index === groups.length - 1 ? LEFT + WIDTH : (centres[index]! + centres[index + 1]!) / 2 - 8;
    let cursor = top;
    for (const item of group.members) {
      const detail = item.label === group.label ? undefined : item.label!.slice(group.label.length + 1);
      const text = await textElement(item.id, item.text, { left, top: cursor, width: right - left }, font, measure,
        { emphasis: item.emphasis, label: detail });
      if ([...boxes.values()].some((box) => intersect(text, box))) return null;
      elements.push(text); boxes.set(item.id, text); cursor += text.height + 2;
      addMapping(mapping, item.sourceContentIds, [group.node.id, text.id]);
    }
  }
  return { elements, mapping, boxes, height: Math.max(...elements.map((element) => element.type === 'text' ? element.top + element.height - top : 0)) };
}

/** Tighten only an already compiled straight horizontal graph, using its real
 * native geometry. Complex topology retains its full measured allocation. */
function diagramRegion(elements: PPTElement[], top: number, allocatedHeight: number): { elements: PPTElement[]; height: number } {
  const nodes = elements.filter((element) => element.type === 'shape');
  const straight = nodes.length > 0 && new Set(nodes.map((node) => node.top)).size === 1
    && elements.every((element) => element.type !== 'line' || (!element.cubic && !element.curve && !element.broken && !element.broken2
      && element.start[1] === element.end[1]));
  if (!straight) return { elements, height: allocatedHeight };
  const geometry = elements.map((element) => element.type === 'line'
    ? { top: element.top + Math.min(element.start[1], element.end[1]) - 6, bottom: element.top + Math.max(element.start[1], element.end[1]) + 6 }
    : { top: element.top, bottom: element.top + element.height });
  const first = Math.min(...geometry.map((box) => box.top)) - 4;
  const last = Math.max(...geometry.map((box) => box.bottom)) + 4;
  return { elements: elements.map((element) => ({ ...element, top: element.top + top - first })), height: last - first };
}

function moveBlock(block: { elements: PPTElement[]; height: number }, offset: number): { elements: PPTElement[]; height: number } {
  return { ...block, elements: block.elements.map((element) => ({ ...element, top: element.top + offset })) };
}

async function imageBand(images: ImageInput[], top: number, available: number, font: number, measure: TextMeasure,
  region = { left: LEFT, width: WIDTH }, vertical = false): Promise<Block | null> {
  const width = vertical ? region.width : (region.width - GAP * (images.length - 1)) / images.length;
  const slotHeight = vertical ? (available - GAP * (images.length - 1)) / images.length : available;
  if (width < 180 || slotHeight < 120 || images.some((item) => !item.src || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0)) return null;
  const elements: PPTElement[] = [], mapping: Record<string, string[]> = {};
  for (const [index, item] of images.entries()) {
    const left = region.left + (vertical ? 0 : index * (width + GAP));
    const slotTop = top + (vertical ? index * (slotHeight + GAP) : 0);
    const caption = item.caption ? await textElement(`${item.id}-caption`, item.caption, { left, top: slotTop, width }, font, measure, { color: PALETTE.muted }) : undefined;
    const imageHeight = slotHeight - (caption ? caption.height + 6 : 0);
    const scale = Math.min(width / item.width, imageHeight / item.height);
    const renderedWidth = item.width * scale, renderedHeight = item.height * scale;
    if (renderedWidth < 120 || renderedHeight < 100) return null;
    const image: PPTImageElement = { type: 'image', id: item.id, src: item.src, fixedRatio: true, rotate: 0,
      left: left + (width - renderedWidth) / 2, top: slotTop + (imageHeight - renderedHeight) / 2, width: renderedWidth, height: renderedHeight };
    elements.push(image);
    if (caption) elements.push({ ...caption, top: slotTop + imageHeight + 6 });
    addMapping(mapping, [item.id, `image:${item.id}`], [item.id, ...(caption ? [caption.id] : [])]);
  }
  return { elements, height: available, boxes: new Map(), mapping };
}

async function composedContent(items: SlidePresentationItem[], columns: number, top: number, font: number, measure: TextMeasure,
  links: SlidePresentationProjection['links'], region: { left: number; width: number }, compact: boolean): Promise<Block | null> {
  if (items.some((item) => Boolean(item.row) !== Boolean(item.column))) return null;
  const cells = items.filter((item) => item.row && item.column), ordinary = items.filter((item) => !item.row && !item.column);
  // A table describes comparisons, not the directed links between narrative
  // statements. Keep every declared link in a region that can actually draw it.
  if (links?.some((link) => !ordinary.some((item) => item.id === link.from) || !ordinary.some((item) => item.id === link.to))) return null;
  const prose = await contentBlocks(ordinary, columns, top, font, measure, links, region, compact || cells.length > 0);
  if (!prose) return null;
  if (!cells.length) return prose;
  const table = await comparison(cells, top + prose.height + (prose.height ? GAP : 0), font, measure, region);
  if (!table) return null;
  const mapping = { ...prose.mapping };
  for (const [source, ids] of Object.entries(table.mapping)) addMapping(mapping, [source], ids);
  return { elements: [...prose.elements, ...table.elements], boxes: prose.boxes, mapping,
    height: prose.height + (prose.height ? GAP : 0) + table.height };
}

/** Compiles wording accepted by the host source contract. A capacity miss returns null; real measurement failures propagate. */
export async function compileSlideInfographic(outline: SceneOutline, projection: SlidePresentationProjection, options: Options): Promise<GeneratedSlideContent | null> {
  if (!projection.verified || projection.schemaVersion !== 1 || projection.layoutVersion !== 'teaching-infographic-v1' || !projection.items.length
    || projection.items.some((item) => !item.id || !item.text.trim() || !item.sourceContentIds.length)
    || new Set(projection.items.map((item) => item.id)).size !== projection.items.length) return null;
  const font = slideTypography(outline).bodyFontSize;
  const title = await textElement('infographic-title', outline.title, { left: LEFT, top: 50, width: WIDTH }, 32, options.measure, { bold: true, color: PALETTE.title });
  const top = Math.max(126, title.top + title.height + 18);
  if (top >= BOTTOM) return null;
  const originalDiagram = outline.visualIntent?.diagram;
  const linkedIds = new Set(projection.links?.flatMap((link) => [link.from, link.to]) ?? []);
  const annotationItems = originalDiagram ? projection.items.filter((item) => !linkedIds.has(item.id) && item.sourceContentIds.every((source) => source === 'diagram-annotation')) : [];
  const items = projection.items.filter((item) => !annotationItems.includes(item));
  const sharedAnnotation = items.some((item) => item.sourceContentIds.includes('diagram-annotation'));
  const diagram = originalDiagram ? { ...originalDiagram, accentColor: PALETTE.title, nodeFill: PALETTE.pale, textColor: PALETTE.text,
    ...(annotationItems.length ? { annotation: annotationItems.map((item) => `${item.label ? `${item.label}：` : ''}${item.text}`).join('；') }
      : sharedAnnotation ? { annotation: undefined } : {}) } : undefined;
  let diagramElements: PPTElement[] = [], diagramHeight = 0;
  if (diagram) {
    try {
      const allocations = await measureDiagramAllocations(diagram, options.measure, { left: LEFT, top, maxWidth: WIDTH, maxHeight: BOTTOM - top });
      const allocation = allocations.find((item) => item.width === WIDTH);
      if (!allocation) return null;
      diagramHeight = allocation.height;
      diagramElements = await compileMeasuredDiagramComponent({ ...diagram, type: 'diagram', id: 'infographic-diagram', left: LEFT, top, ...allocation }, options.measure);
      if (annotationItems.length === 1) diagramElements = diagramElements.map((element) => element.id === 'infographic-diagram-annotation' ? { ...element, id: annotationItems[0]!.id } : element);
    } catch (error) {
      if (error instanceof DiagramAllocationError) return null;
      throw error;
    }
  }
  const diagramLabels = diagram?.nodes.map((node) => node.label) ?? [];
  const matching = diagram ? items.filter((item) => !linkedIds.has(item.id) && !item.row && !item.column
    && matchingNodeLabel(item, diagramLabels)) : [];
  const remainingItems = items.filter((item) => !matching.includes(item));
  const finish = (content: Block, graph: PPTElement[], explanations: Block | null, images?: Block | null): GeneratedSlideContent | null => {
    const mapping = { ...content.mapping };
    for (const [source, ids] of Object.entries(explanations?.mapping ?? {})) addMapping(mapping, [source], ids);
    if (diagram) {
      for (const node of diagram.nodes) addMapping(mapping, [`diagram-node:${node.id}`], [`infographic-diagram-node-${node.id}`]);
      const annotationId = annotationItems.length === 1 ? annotationItems[0]!.id : 'infographic-diagram-annotation';
      if (diagram.annotation) addMapping(mapping, ['diagram-annotation'], [annotationId]);
      for (const item of annotationItems) addMapping(mapping, item.sourceContentIds, [annotationId]);
    }
    for (const [source, ids] of Object.entries(images?.mapping ?? {})) addMapping(mapping, [source], ids);
    const elements = [title, ...content.elements, ...graph, ...(explanations?.elements ?? []), ...(images?.elements ?? [])];
    if (new Set(elements.map((element) => element.id)).size !== elements.length) return null;
    return withSemanticTargetAliases(outline, { elements, background: { type: 'solid', color: '#FFFFFF' }, presentationProjection: { ...projection, elementIdsBySource: mapping } });
  };
  if (diagram) {
    const graph = diagramRegion(diagramElements, top, diagramHeight);
    const linked = remainingItems.filter((item) => linkedIds.has(item.id));
    const ordinary = remainingItems.filter((item) => !linkedIds.has(item.id));
    const count = linked.length || ordinary.length;
    const firstColumns = count === 3 ? 3 : count <= 1 ? 1 : 2;
    for (const columns of [...new Set([firstColumns, 1, 3])].slice(0, 3)) {
      const relation = await composedContent(linked.length ? linked : ordinary, columns, top, font, options.measure,
        projection.links, { left: LEFT, width: WIDTH }, true);
      if (!relation) continue;
      let content = relation;
      if (linked.length && ordinary.length) {
        const facts = await composedContent(ordinary, Math.min(3, ordinary.length), top + relation.height + 8, font, options.measure,
          [], { left: LEFT, width: WIDTH }, true);
        if (!facts) continue;
        const mapping = { ...relation.mapping };
        for (const [source, ids] of Object.entries(facts.mapping)) addMapping(mapping, [source], ids);
        content = { elements: [...relation.elements, ...facts.elements], boxes: new Map([...relation.boxes, ...facts.boxes]), mapping,
          height: relation.height + 8 + facts.height };
      }
      const graphTop = top + content.height + (content.height ? 18 : 0);
      const placed = moveBlock(graph, graphTop - top);
      const nodes = placed.elements.filter((element): element is PPTShapeElement => element.type === 'shape');
      const explanations = matching.length ? await nodeExplanations(matching, nodes, graphTop + graph.height + 4, font, options.measure) : null;
      if (matching.length && !explanations) continue;
      const bottom = graphTop + graph.height + (explanations ? explanations.height + 4 : 0);
      if (bottom > BOTTOM) continue;
      const images = options.images?.length ? await imageBand(options.images, bottom + GAP, BOTTOM - bottom - GAP, font, options.measure) : undefined;
      if (options.images?.length && !images) continue;
      const divider = content.height ? [surface('infographic-process-divider', { left: LEFT, top: graphTop - 9, width: WIDTH, height: 1 }, PALETTE.line)] : [];
      return finish(content, [...divider, ...placed.elements], explanations, images);
    }
    return null;
  }
  const contentTop = top;
  const ordinaryCount = remainingItems.filter((item) => !item.row && !item.column).length;
  const initialColumns = ordinaryCount === 3 ? 3 : ordinaryCount <= 1 ? 1 : 2;
  const columnCandidates = [...new Set([initialColumns, 1, 3])].slice(0, 3);
  const candidates = options.images?.length
    ? [{ sideImage: true, columns: 1 }, { sideImage: false, columns: initialColumns }, { sideImage: false, columns: initialColumns === 1 ? 2 : 1 }]
    : columnCandidates.map((columns) => ({ sideImage: false, columns }));
  for (const candidate of candidates) {
    const textRegion = { left: LEFT, width: candidate.sideImage ? 530 : WIDTH };
    const content = await composedContent(remainingItems, candidate.columns, contentTop, font, options.measure,
      projection.links, textRegion, candidate.sideImage);
    if (!content || contentTop + content.height > BOTTOM) continue;
    const imagesTop = candidate.sideImage ? contentTop : contentTop + content.height + (content.height && options.images?.length ? GAP : 0);
    if (imagesTop > BOTTOM) continue;
    const images = options.images?.length ? await imageBand(options.images, imagesTop, BOTTOM - imagesTop, font, options.measure,
      candidate.sideImage ? { left: LEFT + 530 + GAP, width: WIDTH - 530 - GAP } : { left: LEFT, width: WIDTH }, candidate.sideImage) : undefined;
    if (options.images?.length && !images) continue;
    return finish(content, [], null, images);
  }
  return null;
}


/** Last resort for a new page with no saved draft. This keeps the complete
 * original source in editable elements; diagnostics never certify an overflow
 * as visible or feasible. No model call, summarization, resizing or pagination. */
export async function compileOriginalSlideDraft(outline: SceneOutline, sourceContent: readonly { id: string; text: string }[], options: Options): Promise<GeneratedSlideContent> {
  if (sourceContent.some((item) => !item.id || !item.text.trim()) || new Set(sourceContent.map((item) => item.id)).size !== sourceContent.length) {
    throw new Error('Original slide source needs unique IDs and nonempty text');
  }
  const font = slideTypography(outline).bodyFontSize;
  const title = await textElement('original-title', outline.title, { left: LEFT, top: 50, width: WIDTH }, 32, options.measure, { bold: true, color: PALETTE.title });
  const top = title.top + title.height + 18;
  const original = outline.visualIntent?.diagram;
  const annotation = original ? sourceContent.find((item) => item.id === 'diagram-annotation')?.text ?? original.annotation : undefined;
  const points = sourceContent.filter((item) => !original || item.id !== 'diagram-annotation');
  const items: SlidePresentationItem[] = points.map((item) => ({ ...item, sourceContentIds: [item.id] }));
  const diagnostics: string[] = [];
  let graph: { elements: PPTElement[]; height: number } = { elements: [], height: 0 };
  if (original) {
    const groups = resolveDiagramSequenceGroups(original);
    const implicit = original.topology === 'branch' ? [] : groups
      ? groups.flatMap((group) => group.nodeIds.slice(0, -1).map((from, index) => ({ from, to: group.nodeIds[index + 1]! })))
      : original.nodes.slice(0, original.topology === 'cycle' ? undefined : -1).map((node, index) => ({ from: node.id, to: original.nodes[(index + 1) % original.nodes.length]!.id }));
    const edges = [...(original.edges ?? [])];
    for (const edge of implicit) if (!edges.some((existing) => existing.from === edge.from && existing.to === edge.to)) edges.push(edge);
    const plan = { ...original, edges, annotation: undefined, accentColor: PALETTE.title, nodeFill: PALETTE.pale, textColor: PALETTE.text };
    let allocation = { width: WIDTH, height: 260 }, elements: PPTElement[];
    try {
      const allocations = await measureDiagramAllocations(plan, options.measure, { left: LEFT, top: 50, maxWidth: WIDTH, maxHeight: 462.5 });
      allocation = allocations.find((item) => item.width === WIDTH) ?? allocations[0]!;
      elements = await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: 'original-diagram', left: LEFT, top: 50, ...allocation }, options.measure);
    } catch (error) {
      if (!(error instanceof DiagramAllocationError)) throw error;
      diagnostics.push(error.message);
      // The existing review fallback retains the full topology. Track measure
      // errors separately because the package's diagnostic mode also catches
      // arbitrary errors; infrastructure failure must still escape this host.
      let measurementError: unknown, measurementFailed = false;
      const measured: TextMeasure = async (input) => {
        try { return await options.measure(input); }
        catch (cause) { measurementFailed = true; measurementError = cause; throw cause; }
      };
      elements = await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: 'original-diagram', left: LEFT, top: 50, ...allocation }, measured,
        { onDiagnostic: (detail) => diagnostics.push(detail) });
      if (measurementFailed) throw measurementError;
      for (const element of elements) if (element.type === 'shape' && element.text) {
        const node = original.nodes.find((node) => element.id === `original-diagram-node-${node.id}`)!;
        const actual = await options.measure({ html: element.text.content, text: node.label, width: element.width, fontSize: 20, fontWeight: 700,
          fontFamily: FONT, padding: 10, lineHeight: 1.25, paragraphSpace: 0, align: 'center', preserveRichText: true });
        if (!Number.isFinite(actual.height) || actual.height <= 0) throw new Error('Original diagram text measurement returned invalid geometry');
        if (actual.height > element.height + 0.5) diagnostics.push(`Original diagram node ${node.id}: text needs ${actual.height}px; node provides ${element.height}px`);
      }
      for (const element of elements) if (element.type === 'text') {
        const actual = await options.measure({ html: element.content, text: element.content.replace(/<[^>]+>/gu, ''), width: element.width,
          fontSize: Number(element.content.match(/font-size:(\d+)px/u)?.[1] ?? 16), fontWeight: 400,
          fontFamily: FONT, padding: 10, lineHeight: element.lineHeight ?? 1.2, paragraphSpace: element.paragraphSpace ?? 0, align: 'center', preserveRichText: true });
        if (!Number.isFinite(actual.height) || actual.height <= 0) throw new Error('Original diagram label measurement returned invalid geometry');
        if (actual.height > element.height + 0.5) diagnostics.push(`Original diagram label ${element.id}: text needs ${actual.height}px; allocation provides ${element.height}px`);
      }
    }
    graph = { elements, height: allocation.height };
    if (annotation) {
      const note = await textElement('original-diagram-annotation', annotation, { left: LEFT, top: 50, width: WIDTH }, font, options.measure);
      graph = { elements: [note, ...moveBlock(graph, note.height + GAP).elements], height: note.height + GAP + graph.height };
    }
  }
  if (!items.length && !graph.elements.length && !options.images?.length) throw new Error('Original slide has no renderable source content');
  let best: { elements: PPTElement[]; mapping: Record<string, string[]>; bottom: number; diagnostics: string[] } | undefined;
  for (const columns of [1, 2, 3]) {
    const content = await contentBlocks(items, columns, top, font, options.measure, []);
    if (!content) continue;
    const graphTop = top + content.height + (content.height && graph.height ? GAP : 0);
    const placed = moveBlock(graph, graphTop - 50);
    const elements = [title, ...content.elements, ...placed.elements], mapping = { ...content.mapping }, localDiagnostics = [...diagnostics];
    let bottom = graphTop + graph.height;
    if (original) {
      for (const node of original.nodes) addMapping(mapping, [`diagram-node:${node.id}`], [`original-diagram-node-${node.id}`]);
      if (annotation) addMapping(mapping, ['diagram-annotation'], ['original-diagram-annotation']);
    }
    const images = options.images ?? [], imageColumns = Math.min(columns, images.length);
    const width = imageColumns ? (WIDTH - GAP * (imageColumns - 1)) / imageColumns : 0;
    for (let start = 0; start < images.length; start += imageColumns) {
      const imageTop = bottom + GAP, heights: number[] = [];
      for (const [column, input] of images.slice(start, start + imageColumns).entries()) {
        if (!input.src || !Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) throw new Error(`Original image ${input.id} has invalid dimensions or source`);
        const left = LEFT + column * (width + GAP), scale = Math.min(width / input.width, 220 / input.height);
        const image: PPTImageElement = { type: 'image', id: input.id, src: input.src, left: left + (width - input.width * scale) / 2,
          top: imageTop, width: input.width * scale, height: input.height * scale, rotate: 0, fixedRatio: true };
        elements.push(image);
        let height = image.height;
        const ids = [image.id];
        if (input.caption) {
          const caption = await textElement(`${input.id}-caption`, input.caption, { left, top: imageTop + height + 6, width }, font, options.measure);
          elements.push(caption); ids.push(caption.id); height += caption.height + 6;
        }
        if (image.width < 120 || image.height < 100) localDiagnostics.push(`Original image ${input.id}: contained size ${image.width}×${image.height}px is below the 120×100px reading allocation`);
        addMapping(mapping, [input.id, `image:${input.id}`], ids); heights.push(height);
      }
      bottom = imageTop + Math.max(...heights);
    }
    if (!best || bottom < best.bottom) best = { elements, mapping, bottom, diagnostics: localDiagnostics };
  }
  if (!best) throw new Error('Original source could not be compiled into editable elements');
  if (new Set(best.elements.map((element) => element.id)).size !== best.elements.length) throw new Error('Original source produces conflicting element IDs');
  if (best.bottom > BOTTOM) best.diagnostics.push(`Original slide capacity: measured content reaches y=${best.bottom}px beyond the safe bottom ${BOTTOM}px; complete source retained without reducing fonts or changing page count`);
  return withSemanticTargetAliases(outline, { elements: best.elements, background: { type: 'solid', color: '#FFFFFF' }, qualityDiagnostics: [...new Set(best.diagnostics)],
    presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items: sourceContent.map((item) => ({ ...item, sourceContentIds: [item.id] })), elementIdsBySource: best.mapping } });
}
