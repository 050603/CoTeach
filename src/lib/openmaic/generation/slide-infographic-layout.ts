import type { PPTElement, PPTImageElement, PPTLineElement, PPTShapeElement, PPTTableElement, PPTTextElement, SlidePresentationItem, SlidePresentationProjection, TableCell } from '@openmaic/dsl';
import { compileMeasuredDiagramComponent, DiagramAllocationError, measureDiagramAllocations, resolveDiagramSequenceGroups, type TextMeasure } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { slideTypography } from './slide-presentation-typography';
import { adoptedPageAuthoringContent, pagePresentationContent } from './adopted-page-content';
import { SLIDE_VISUAL_LAYOUT_VERSION, slidePresentationLabel, unchangedSlideProjection } from './slide-visual-projection';
import { layoutTeachingSequence } from './slide-process-layout';
import { layoutAuthoredGroups, minimumReadableProseWidth } from './slide-authored-layout';
import { layoutAuthoredRelations } from './slide-authored-relations';
import { presentationRichText } from './slide-presentation-text';

type Rect = { left: number; top: number; width: number; height: number };
type ImageInput = { id: string; src: string; width: number; height: number; caption?: string };
type Options = { measure: TextMeasure; images?: ImageInput[] };
type Block = { elements: PPTElement[]; height: number; boxes: Map<string, Rect>; mapping: Record<string, string[]> };
const PALETTE = { title: '#1E3A8A', text: '#334155', muted: '#64748B', pale: '#EFF6FF', line: '#CBD5E1', accent: '#ED7D31' };
const LEFT = 50, WIDTH = 900, BOTTOM = 512.5, GAP = 22;
const FONT = 'Noto Sans SC';
const escape = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/\n/gu, '<br>');

async function textElement(id: string, text: string, rect: Pick<Rect, 'left' | 'top' | 'width'>, fontSize: number,
  measure: TextMeasure, options: { bold?: boolean; color?: string; emphasis?: string[]; emphasisStyle?: SlidePresentationItem['emphasisStyle']; table?: boolean; label?: string } = {}): Promise<PPTTextElement> {
  const content = `<p style="font-size:${fontSize}px;font-weight:${options.bold ? 700 : 400};color:${options.color ?? PALETTE.text};text-wrap:pretty">${options.label ? `<strong style="font-size:${fontSize}px;color:${options.color ?? PALETTE.text}">${escape(options.label)}：</strong>` : ''}${presentationRichText(text, options.emphasis, options.emphasisStyle, options.color ?? PALETTE.text, Math.min(12, Math.floor((rect.width - (options.table ? 24 : 20)) / fontSize)))}</p>`;
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
      const value = item ? `${item.label ? `${item.label}\n` : ''}${item.text}` : rowIndex ? rows[rowIndex - 1]! : columnIndex ? columns[columnIndex - 1]! : '比较维度';
      const id = item?.id ?? `infographic-table-heading-${rowIndex}-${columnIndex}`;
      const header = rowIndex === 0 || columnIndex === 0;
      const color = rowIndex === 0 ? PALETTE.title : PALETTE.text;
      const element = await textElement(id, value, { left: 0, top: 0, width: widths[columnIndex]! - 2 }, font, measure,
        { table: true, bold: header, color, emphasis: item?.emphasis, emphasisStyle: item?.emphasisStyle });
      heights.push(element.height + 4);
      cells.push({ id, text: element.content, rowspan: 1, colspan: 1, padding: '10px 12px', vAlign: 'middle',
        style: { fontname: FONT, fontsize: `${font}px`, color, bold: header,
          backcolor: rowIndex === 0 ? PALETTE.pale : '#FFFFFF' } });
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
  links: SlidePresentationProjection['links'], region = { left: LEFT, width: WIDTH }, compact = false, editorial = false): Promise<Block | null> {
  let gap = links?.length ? 72 : GAP;
  if (columns > 1) for (const link of links ?? []) if (link.label) {
    const geometry = await measure({ html: `<p style="font-size:${Math.max(20, font)}px">${escape(link.label)}</p>`,
      text: link.label, width: 260, fontSize: Math.max(20, font), fontWeight: 400, fontFamily: FONT,
      padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left', preserveRichText: true });
    if (!Number.isFinite(geometry.naturalWidth) || !Number.isFinite(geometry.height) || geometry.height <= 0) throw new Error('Relation label measurement returned invalid geometry');
    gap = Math.max(gap, Math.min(260, Math.max(180, geometry.naturalWidth + 20)) + 16);
  }
  const width = (region.width - (columns - 1) * gap) / columns;
  if (width < 140 || items.some((item) => width - 8 < minimumReadableProseWidth(item.text, font))) return null;
  const elements: PPTElement[] = [], boxes = new Map<string, Rect>(), mapping: Record<string, string[]> = {};
  let rowTop = top;
  for (let start = 0; start < items.length; start += columns) {
    const heights: number[] = [];
    for (const [column, item] of items.slice(start, start + columns).entries()) {
      const left = region.left + column * (width + gap), children: PPTElement[] = [];
      const relationSink = editorial && Boolean(links?.length) && !links!.some((link) => link.from === item.id);
      let textTop = rowTop;
      if (item.label && !compact) {
        const label = await textElement(`${item.id}-heading`, item.label, { left: left + 8, top: textTop, width: width - 8 }, Math.max(20, font), measure, { bold: true });
        children.push(label); textTop += label.height + 2;
      }
      const body = await textElement(item.id, item.text, { left: left + 8, top: textTop, width: width - 8 }, font, measure, { emphasis: item.emphasis, emphasisStyle: item.emphasisStyle, ...(compact ? { label: item.label } : {}) });
      children.push(body);
      const height = body.top + body.height - rowTop;
      // Open editorial groups use their real labels and whitespace. Only a
      // relation node gets a surface; a repeated decorative rule adds no meaning.
      const decoration = editorial ? links?.length
        ? [surface(`${item.id}-surface`, { left, top: rowTop, width, height }, relationSink ? '#EDF8F5' : '#EFF6FF')] : []
        : [surface(`${item.id}-rule`, { left, top: rowTop + 11, width: 3, height: Math.min(28, height - 11) }, PALETTE.title)];
      elements.push(...decoration, ...children);
      boxes.set(item.id, { left, top: rowTop, width, height });
      addMapping(mapping, item.sourceContentIds, [...decoration.map((element) => element.id), ...children.map((child) => child.id)]);
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
      if (labelWidth < (link.label.length > 4 ? 140 : 60)) return null;
      const label = await textElement(`${line.id}-label`, link.label, { left: horizontal ? corridor.left : start[0] + 8,
        top: horizontal ? start[1] : corridor.top, width: labelWidth }, Math.max(20, font), measure, { color: PALETTE.muted });
      if (horizontal) label.top = start[1] - label.height - 6;
      if ((!horizontal && label.height > corridor.height)
        || [...boxes.values()].some((box) => intersect(label, box))) return null;
      elements.push(label);
      addMapping(mapping, linkedSources, [label.id]);
    }
  }
  let height = items.length ? rowTop - gap - top : 0;
  const rectangles = elements.filter((element) => element.type !== 'line');
  if (rectangles.length) {
    const first = Math.min(top, ...rectangles.map((element) => element.top));
    const last = Math.max(top + height, ...rectangles.map((element) => element.top + element.height));
    if (first < top) {
      for (const element of elements) element.top += top - first;
      for (const box of boxes.values()) box.top += top - first;
    }
    height = last - first;
  }
  return { elements, height, boxes, mapping };
}

function matchingNodeLabel(item: SlidePresentationItem, labels: readonly string[]): string | undefined {
  if (!item.label) return undefined;
  const normalize = (value: string) => value.replace(/^\s*\d+[.、．\s]*/u, '').trim();
  const matches = labels.filter((label) => normalize(item.label!) === normalize(label)
    || item.label!.startsWith(`${label}·`) || item.label!.startsWith(`${label}：`));
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
        { emphasis: item.emphasis, emphasisStyle: item.emphasisStyle, label: detail });
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
  links: SlidePresentationProjection['links'], region: { left: number; width: number }, compact: boolean, editorial = false): Promise<Block | null> {
  if (items.some((item) => Boolean(item.row) !== Boolean(item.column))) return null;
  const cells = items.filter((item) => item.row && item.column), ordinary = items.filter((item) => !item.row && !item.column);
  // A table describes comparisons, not the directed links between narrative
  // statements. Keep every declared link in a region that can actually draw it.
  if (links?.some((link) => !ordinary.some((item) => item.id === link.from) || !ordinary.some((item) => item.id === link.to))) return null;
  if (editorial && cells.length) {
    const table = await comparison(cells, top, font, measure, region);
    if (!table) return null;
    const notes = await contentBlocks(ordinary, columns, top + table.height + GAP, font, measure, links, region, true, true);
    if (!notes) return null;
    const mapping = { ...table.mapping };
    for (const [source, ids] of Object.entries(notes.mapping)) addMapping(mapping, [source], ids);
    const band = notes.height ? [surface('infographic-comparison-conclusion',
      { left: region.left, top: top + table.height + GAP, width: region.width, height: notes.height }, '#FFF7ED')] : [];
    return { elements: [...table.elements, ...band, ...notes.elements], mapping, boxes: notes.boxes,
      height: table.height + (notes.height ? GAP + notes.height : 0) };
  }
  const prose = await contentBlocks(ordinary, columns, top, font, measure, links, region, compact || cells.length > 0, editorial);
  if (!prose) return null;
  if (!cells.length) return prose;
  const table = await comparison(cells, top + prose.height + (prose.height ? GAP : 0), font, measure, region);
  if (!table) return null;
  const mapping = { ...prose.mapping };
  for (const [source, ids] of Object.entries(table.mapping)) addMapping(mapping, [source], ids);
  return { elements: [...prose.elements, ...table.elements], boxes: prose.boxes, mapping,
    height: prose.height + (prose.height ? GAP : 0) + table.height };
}

/** One authored focal idea with subordinate evidence, not an arbitrary first bullet. */
async function focusContent(items: SlidePresentationItem[], focusId: string, top: number, font: number, measure: TextMeasure): Promise<Block | null> {
  const focus = items.find((item) => item.id === focusId);
  if (!focus || items.some((item) => item.row || item.column)) return null;
  const body = await textElement(focus.id, focus.text, { left: LEFT + 14, top: top + 6, width: WIDTH - 28 }, font,
    measure, { label: focus.label, emphasis: focus.emphasis, emphasisStyle: focus.emphasisStyle });
  const height = body.height + 12;
  const support = await contentBlocks(items.filter((item) => item !== focus), 2, top + height + GAP, font, measure,
    [], { left: LEFT, width: WIDTH }, true, true);
  if (!support) return null;
  const mapping = { ...support.mapping };
  addMapping(mapping, focus.sourceContentIds, [body.id]);
  return { elements: [surface(`${focus.id}-surface`, { left: LEFT, top, width: WIDTH, height }, PALETTE.pale),
    surface(`${focus.id}-rule`, { left: LEFT, top, width: 4, height }, PALETTE.title), body, ...support.elements],
    mapping, boxes: support.boxes, height: height + (support.height ? GAP + support.height : 0) };
}

/** Keep an observed case and its explanation together, as in the adopted
 * lecture references. The matrix uses the page's planned compact table font;
 * every item and image is measured before deciding whether this page fits. */
async function observationComparison(items: SlidePresentationItem[], takeawayId: string | undefined, top: number,
  font: number, tableFont: number, images: ImageInput[], measure: TextMeasure): Promise<{ content: Block; images: Block } | null> {
  const cells = items.filter((item) => item.row && item.column);
  const observations = items.filter((item) => !item.row && !item.column && item.id !== takeawayId);
  const conclusion = items.filter((item) => item.id === takeawayId && !cells.includes(item));
  if (!cells.length || !observations.length || images.length !== 1
    || cells.length + observations.length + conclusion.length !== items.length) return null;
  const gap = 12, imageWidth = 320, textRegion = { left: LEFT + imageWidth + gap, width: WIDTH - imageWidth - gap };
  const notes = await contentBlocks(observations, Math.min(2, observations.length), top, font, measure, [],
    { left: LEFT, width: WIDTH }, true, true);
  if (!notes) return null;
  const middleTop = top + notes.height + gap;
  const table = await comparison(cells, middleTop, tableFont, measure, textRegion);
  const footer = await contentBlocks(conclusion, 1, middleTop, font, measure, [], { left: LEFT, width: WIDTH }, true, true);
  if (!table || !footer) return null;
  const available = BOTTOM - middleTop - (footer.height ? gap + footer.height : 0);
  if (table.height > available) return null;
  const pictures = await imageBand(images, middleTop, available, font, measure, { left: LEFT, width: imageWidth });
  const picture = pictures?.elements.find((element) => element.type === 'image');
  if (!pictures || !picture || picture.width < 280 || picture.height < 180) return null;
  const footerTop = middleTop + available + gap;
  const mapping = { ...notes.mapping };
  for (const block of [table, footer]) for (const [source, ids] of Object.entries(block.mapping)) addMapping(mapping, [source], ids);
  return { content: { elements: [...notes.elements, ...table.elements,
    ...(footer.height ? [surface('infographic-comparison-conclusion', { left: LEFT, top: footerTop, width: WIDTH, height: footer.height }, '#FFF7ED'),
      ...moveBlock(footer, footerTop - middleTop).elements] : [])], mapping, boxes: new Map(), height: BOTTOM - top }, images: pictures };
}

/** Compiles wording accepted by the host source contract. A capacity miss returns null; real measurement failures propagate. */
export async function compileSlideInfographic(outline: SceneOutline, projection: SlidePresentationProjection, options: Options): Promise<GeneratedSlideContent | null> {
  if (!projection.verified || projection.schemaVersion !== 1 || !['teaching-infographic-v1', SLIDE_VISUAL_LAYOUT_VERSION].includes(projection.layoutVersion) || !projection.items.length
    || projection.items.some((item) => !item.id || !item.text.trim() || !item.sourceContentIds.length)
    || new Set(projection.items.map((item) => item.id)).size !== projection.items.length) return null;
  projection = { ...projection, items: projection.items.map((item) => ({ ...item, label: slidePresentationLabel(item.label) })) };
  const font = slideTypography(outline).bodyFontSize;
  const title = await textElement('infographic-title', outline.title, { left: LEFT, top: 50, width: WIDTH }, 32, options.measure, { bold: true, color: PALETTE.title });
  const top = Math.max(126, title.top + title.height + 18);
  if (top >= BOTTOM) return null;
  const originalDiagram = outline.visualIntent?.diagram;
  const linkedIds = new Set(projection.links?.flatMap((link) => [link.from, link.to]) ?? []);
  const designed = projection.layoutVersion === SLIDE_VISUAL_LAYOUT_VERSION;
  // Bind labels and explanations before allocating the graph. Allocating a
  // separate naked graph first is what forced readable six-step pages into the
  // old duplicated text/grid fallback.
  if (designed && originalDiagram && !options.images?.length) {
    const labels = originalDiagram.nodes.map((node) => node.label);
    const steps = projection.items.filter((item) => !linkedIds.has(item.id) && !item.row && !item.column
      && (item.diagramNodeId || matchingNodeLabel(item, labels)));
    const notes = projection.items.filter((item) => !steps.includes(item));
    const annotationCovered = !originalDiagram.annotation || notes.some((item) => item.sourceContentIds.includes('diagram-annotation'))
      || steps.some((item) => item.sourceContentIds.includes('diagram-annotation'));
    if (annotationCovered) {
      // A long sequence with only a few observations is a reading spine with
      // a wide explanation area. It does not need a folded, zigzag grid.
      if (originalDiagram.nodes.length >= 5 && steps.length <= 2 && !projection.links?.length) {
        const processWidth = 420, noteLeft = LEFT + processWidth + GAP;
        const process = await layoutTeachingSequence({ diagram: originalDiagram, items: [], font, measure: options.measure,
          rect: { left: LEFT, top, width: processWidth, height: BOTTOM - top } });
        const note = await composedContent(projection.items, 1, top, font, options.measure, [],
          { left: noteLeft, width: WIDTH - processWidth - GAP }, true, true);
        if (process && note && note.height <= BOTTOM - top) {
          const mapping = { ...note.mapping, ...process.mapping };
          for (const item of steps) addMapping(mapping, item.sourceContentIds, [`infographic-diagram-node-${item.diagramNodeId
            ?? originalDiagram.nodes.find((node) => matchingNodeLabel(item, [node.label]))?.id}`]);
          const noteOffset = (BOTTOM - top - note.height) / 2;
          const processOffset = (BOTTOM - top - process.height) / 2;
          return withSemanticTargetAliases(outline, { elements: [title,
            ...process.elements.map((element) => ({ ...element, top: element.top + processOffset })),
            ...note.elements.map((element) => ({ ...element, top: element.top + noteOffset }))],
            background: { type: 'solid', color: '#FFFFFF' }, presentationProjection: { ...projection, elementIdsBySource: mapping } });
        }
      }
      const note = await composedContent(notes, Math.min(2, Math.max(1, notes.length)), top, font, options.measure,
        projection.links, { left: LEFT, width: WIDTH }, true, true);
      if (note) {
        const processTop = top + note.height + (note.height ? GAP : 0);
        const process = await layoutTeachingSequence({ diagram: originalDiagram, items: steps, font, measure: options.measure,
          rect: { left: LEFT, top: processTop, width: WIDTH, height: BOTTOM - processTop } });
        if (process && new Set([title, ...note.elements, ...process.elements].map((element) => element.id)).size
          === 1 + note.elements.length + process.elements.length) {
          const mapping = { ...note.mapping };
          for (const [source, ids] of Object.entries(process.mapping)) addMapping(mapping, [source], ids);
          return withSemanticTargetAliases(outline, { elements: [title, ...note.elements, ...process.elements],
            background: { type: 'solid', color: '#FFFFFF' }, presentationProjection: { ...projection, elementIdsBySource: mapping } });
        }
      }
    }
  }
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
  const remainingItems = items.filter((item) => !matching.includes(item))
    .sort((a, b) => Number(a.id === projection.takeawayItemId) - Number(b.id === projection.takeawayItemId));
  let spatialFallback = false;
  const finish = (content: Block, graph: PPTElement[], explanations: Block | null, images?: Block | null): GeneratedSlideContent | null => {
    const mapping = { ...content.mapping };
    for (const [source, ids] of Object.entries(explanations?.mapping ?? {})) addMapping(mapping, [source], ids);
    if (diagram) {
      for (const node of diagram.nodes) addMapping(mapping, [`diagram-node:${node.id}`], [`infographic-diagram-node-${node.id}`]);
      for (const item of projection.items) if (item.diagramNodeId && diagram.nodes.some((node) => node.id === item.diagramNodeId)) {
        addMapping(mapping, item.sourceContentIds, [`infographic-diagram-node-${item.diagramNodeId}`]);
      }
      const annotationId = annotationItems.length === 1 ? annotationItems[0]!.id : 'infographic-diagram-annotation';
      if (diagram.annotation) addMapping(mapping, ['diagram-annotation'], [annotationId]);
      for (const item of annotationItems) addMapping(mapping, item.sourceContentIds, [annotationId]);
    }
    for (const [source, ids] of Object.entries(images?.mapping ?? {})) addMapping(mapping, [source], ids);
    if (designed && images && !graph.length && !explanations && content.elements.length) {
      const text = content.elements.filter((element) => element.type !== 'line');
      const pictures = images.elements.filter((element) => element.type !== 'line');
      const left = Math.min(...text.map((element) => element.left)), right = Math.max(...text.map((element) => element.left + element.width));
      const imageLeft = Math.min(...pictures.map((element) => element.left)), imageRight = Math.max(...pictures.map((element) => element.left + element.width));
      if (right <= imageLeft || left >= imageRight) {
        const first = Math.min(...text.map((element) => element.top)), last = Math.max(...text.map((element) => element.top + element.height));
        const imageTop = Math.min(...pictures.map((element) => element.top)), imageBottom = Math.max(...pictures.map((element) => element.top + element.height));
        const offset = (imageTop + imageBottom - first - last) / 2;
        if (first + offset >= top && last + offset <= BOTTOM) content = { ...content,
          elements: content.elements.map((element) => ({ ...element, top: element.top + offset })) };
      }
    }
    let body = [...content.elements, ...graph, ...(explanations?.elements ?? []), ...(images?.elements ?? [])];
    if (designed && !images && body.length) {
      const rectangles = body.filter((element) => element.type !== 'line');
      if (rectangles.length) {
        const first = Math.min(...rectangles.map((element) => element.top));
        const last = Math.max(...rectangles.map((element) => element.top + element.height));
        const spare = BOTTOM - top - (last - first);
        if (spare >= 0) {
          const offset = top + spare / 2 - first;
          body = body.map((element) => ({ ...element, top: element.top + offset }));
        }
      }
    }
    const elements = [title, ...body];
    if (new Set(elements.map((element) => element.id)).size !== elements.length) return null;
    return withSemanticTargetAliases(outline, { elements, background: { type: 'solid', color: '#FFFFFF' },
      ...(spatialFallback ? { qualityDiagnostics: ['Authored spatial arrangement did not fit; retained all display content in a measured alternative layout.'] } : {}),
      presentationProjection: { ...projection, elementIdsBySource: mapping } });
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
  if (designed) {
    if (projection.links?.length && !options.images?.length && !remainingItems.some((item) => item.row || item.column)) {
      const linked = remainingItems.filter((item) => linkedIds.has(item.id));
      const notes = remainingItems.filter((item) => !linkedIds.has(item.id));
      // Let the relationship be the main visual. Unconnected observations are
      // nearby supporting text, never extra nodes on an invented causal chain.
      for (const columns of [...new Set([Math.min(3, Math.max(1, notes.length)), 1])]) {
        const support = await contentBlocks(notes, columns, top, font, options.measure, [], { left: LEFT, width: WIDTH }, true, true);
        if (!support) continue;
        const available = BOTTOM - top - support.height - (notes.length ? GAP : 0);
        let relation = await layoutAuthoredRelations({ items: linked, links: projection.links,
          rect: { left: LEFT, top, width: WIDTH, height: available }, font, measure: options.measure });
        if (!relation) {
          for (const count of [...new Set([Math.min(3, linked.length), 1])]) {
            const cards = await contentBlocks(linked, count, top, font, options.measure, projection.links, { left: LEFT, width: WIDTH }, false, true);
            if (cards && cards.height <= available) { relation = cards; break; }
          }
        }
        if (!relation) continue;
        const moved = moveBlock(support, relation.height + (notes.length ? GAP : 0));
        const mapping = { ...relation.mapping };
        for (const [source, ids] of Object.entries(support.mapping)) addMapping(mapping, [source], ids);
        const result = finish({ elements: [...relation.elements, ...moved.elements], height: relation.height + (notes.length ? GAP : 0) + support.height,
          boxes: relation.boxes, mapping }, [], null);
        if (result) return result;
      }
    }
    if (options.images?.length && !projection.links?.length) {
      const mixed = await observationComparison(remainingItems, projection.takeawayItemId, top, font,
        slideTypography(outline).minimumBodyFontSize, options.images, options.measure);
      if (mixed) {
        const result = finish(mixed.content, [], null, mixed.images);
        if (result) return result;
      }
    }
    // Authored spatial groups are independent primitives, not named templates.
    // Semantic graphs and comparison matrices keep their own complete structure.
    if (projection.design && !projection.links?.length && !remainingItems.some((item) => item.row || item.column)) {
      const design = projection.design, full = { left: LEFT, top, width: WIDTH, height: BOTTOM - top };
      let textRect = full, mediaRect: Rect | undefined;
      if (options.images?.length) {
        const media = design.media ?? { placement: 'left', fraction: 0.55 };
        const horizontal = media.placement === 'left' || media.placement === 'right';
        if (horizontal) {
          const width = (WIDTH - design.gap) * media.fraction;
          mediaRect = { ...full, left: media.placement === 'left' ? LEFT : LEFT + WIDTH - width, width };
          textRect = { ...full, left: media.placement === 'left' ? LEFT + width + design.gap : LEFT, width: WIDTH - width - design.gap };
        } else {
          const height = (full.height - design.gap) * media.fraction;
          mediaRect = { ...full, top: media.placement === 'top' ? top : BOTTOM - height, height };
          textRect = { ...full, top: media.placement === 'top' ? top + height + design.gap : top, height: full.height - height - design.gap };
        }
      }
      let content = await layoutAuthoredGroups({ items: remainingItems, design, rect: textRect, font, measure: options.measure });
      // A narrow media-side column can require vertical group flow. Preserve
      // membership, treatments, words and the requested image placement.
      if (!content && mediaRect && design.flow === 'rows') content = await layoutAuthoredGroups({ items: remainingItems,
        design: { ...design, flow: 'columns' }, rect: textRect, font, measure: options.measure });
      const images = options.images?.length && mediaRect ? await imageBand(options.images, mediaRect.top, mediaRect.height,
        font, options.measure, mediaRect) : undefined;
      if (content && (!options.images?.length || images)) {
        const result = finish(content, [], null, images);
        if (result) return result;
      }
      spatialFallback = true;
    }
    const candidates: Array<{ content: Block; images?: Block; score: number }> = [];
    const focalId = projection.focusItemId ?? (remainingItems.length === 1 ? remainingItems[0]!.id : undefined);
    if (!options.images?.length && !projection.links?.length && focalId) {
      const content = await focusContent(remainingItems, focalId, top, font, options.measure);
      if (content && top + content.height <= BOTTOM) candidates.push({ content, score: -100 });
    }
    // Every candidate uses the same text, fonts and actual media. The choice
    // changes geometry only; it cannot discard a source to improve its score.
    for (const columns of [1, 2, 3]) {
      const content = await composedContent(remainingItems, columns, top, font, options.measure,
        projection.links, { left: LEFT, width: WIDTH }, false, true);
      if (!content || top + content.height > BOTTOM) continue;
      const images = options.images?.length ? await imageBand(options.images, top + content.height + GAP,
        BOTTOM - top - content.height - GAP, font, options.measure) : undefined;
      if (options.images?.length && !images) continue;
      const idealColumns = remainingItems.some((item) => item.row) ? 1 : remainingItems.length === 3 ? 3 : 2;
      const occupied = content.height + (images ? images.height + GAP : 0);
      candidates.push({ content, images: images ?? undefined, score: Math.abs(columns - idealColumns) * 20
        + Math.abs(occupied / (BOTTOM - top) - 0.8) * 12 });
    }
    if (options.images?.length) {
      // The planned visual is an observation surface, not a small afterthought.
      // Try two actual allocations rather than privileging a fixed text column.
      for (const imageWidth of [540, 460]) {
        const content = await composedContent(remainingItems, 1, top, font, options.measure, projection.links,
          { left: LEFT + imageWidth + GAP, width: WIDTH - imageWidth - GAP }, true, true);
        if (!content || top + content.height > BOTTOM) continue;
        const images = await imageBand(options.images, top, BOTTOM - top, font, options.measure,
          { left: LEFT, width: imageWidth });
        if (!images) continue;
        const imageArea = images.elements.reduce((sum, element) => sum + (element.type === 'image' ? element.width * element.height : 0), 0);
        candidates.push({ content, images, score: -20 - imageArea / (WIDTH * (BOTTOM - top)) * 20 });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const candidate of candidates) {
      const content = candidate.content;
      const focusBox = candidate.images && projection.focusItemId ? content.boxes.get(projection.focusItemId) : undefined;
      if (focusBox) content.elements = [surface('infographic-image-focus', focusBox, '#EFF6FF'), ...content.elements];
      const result = finish(content, [], null, candidate.images);
      if (result) return result;
    }
    // Observation images and a full comparison matrix are two visual subjects.
    // Compile them as consecutive native pages when they cannot share readable
    // space. The existing continuation contract owns their speech and timing.
    const cells = remainingItems.filter((item) => item.row && item.column);
    const observations = remainingItems.filter((item) => !item.row && !item.column && item.id !== projection.takeawayItemId);
    const conclusion = remainingItems.filter((item) => item.id === projection.takeawayItemId && !cells.includes(item));
    const imageSources = new Set(observations.flatMap((item) => item.sourceContentIds));
    if (options.images?.length && cells.length && observations.length && !projection.links?.length
      && [...cells, ...conclusion].every((item) => item.sourceContentIds.every((source) => !imageSources.has(source)))) {
      const subset = (items: SlidePresentationItem[], composition: SlidePresentationProjection['composition']): SlidePresentationProjection => ({
        ...projection, composition, design: undefined, items,
        focusItemId: items.some((item) => item.id === projection.focusItemId) ? projection.focusItemId : undefined,
        takeawayItemId: items.some((item) => item.id === projection.takeawayItemId) ? projection.takeawayItemId : undefined,
      });
      const observation = await compileSlideInfographic(outline, subset(observations, 'image-focus'), options);
      const contrast = await compileSlideInfographic(outline, subset([...cells, ...conclusion], 'comparison'), { measure: options.measure });
      if (observation && contrast && !observation.continuationPages?.length && !contrast.continuationPages?.length) {
        const page = (content: GeneratedSlideContent): GeneratedSlideContent => ({ ...content,
          sourceGroupIds: Object.keys(content.presentationProjection!.elementIdsBySource),
          teachingText: content.presentationProjection!.items.map((item) => [item.row, item.column, item.label, item.text].filter(Boolean).join('　')),
          occupiedHeight: Math.max(...content.elements.filter((element) => element.type !== 'line').map((element) => element.top + element.height)) - top,
          layoutDecision: 'paginated',
          paginationVersion: 'balanced-v1',
        });
        return { ...page(observation), continuationPages: [page(contrast)], paginationVersion: 'balanced-v1' };
      }
    }
    return null;
  }
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


/** Deterministic original-content layout. Pagination moves original text and
 * whole diagrams; it never rewrites facts, drops topology or reduces fonts. */
export async function compileOriginalSlideDraft(outline: SceneOutline, sourceContent: readonly { id: string; text: string }[], options: Options,
  acceptedProjection?: SlidePresentationProjection): Promise<GeneratedSlideContent> {
  if (sourceContent.some((item) => !item.id || !item.text.trim()) || new Set(sourceContent.map((item) => item.id)).size !== sourceContent.length) {
    throw new Error('Original slide source needs unique IDs and nonempty text');
  }
  // Structural fallback may improve grouping, but never summarizes or deletes
  // source words. Reuse the same measured compositions before paginating prose.
  const originalProjection = acceptedProjection ?? { ...unchangedSlideProjection(sourceContent), verified: true };
  const composed = await compileSlideInfographic(outline, originalProjection, options);
  if (composed) return { ...composed, qualityDiagnostics: [] };
  const font = slideTypography(outline).bodyFontSize;
  const title = await textElement('original-title', outline.title, { left: LEFT, top: 50, width: WIDTH }, 32, options.measure, { bold: true, color: PALETTE.title });
  const top = title.top + title.height + 18;
  const original = outline.visualIntent?.diagram;
  // Prose can paginate under its verified source mapping. Tables and directed
  // relations need their structured renderer, so never flatten them here.
  const retainedProjection = acceptedProjection?.verified && !acceptedProjection.links?.length
    && !acceptedProjection.items.some((item) => item.row || item.column) ? acceptedProjection : undefined;
  const annotation = original && !retainedProjection ? sourceContent.find((item) => item.id === 'diagram-annotation')?.text ?? original.annotation : undefined;
  const points: SlidePresentationItem[] = retainedProjection ? retainedProjection.items.map((item) => ({ ...item }))
    : sourceContent.filter((item) => !original || item.id !== 'diagram-annotation')
      .map((item) => ({ ...item, sourceContentIds: [item.id] }));
  const displayed = (item: SlidePresentationItem) => [item.label, item.text].filter(Boolean).join('：');
  const graphAt = async (graphTop: number, preserveOverflow = false): Promise<{ block: Block; diagnostics: string[] } | null> => {
    if (!original || graphTop >= BOTTOM && !preserveOverflow) return null;
    const note = annotation ? await textElement('original-diagram-annotation', annotation, { left: LEFT, top: graphTop, width: WIDTH }, font, options.measure) : undefined;
    const nodeTop = graphTop + (note ? note.height + GAP : 0), available = BOTTOM - nodeTop;
    if (available <= 0 && !preserveOverflow) return null;
    const groups = resolveDiagramSequenceGroups(original);
    const implicit = original.topology === 'branch' ? [] : groups
      ? groups.flatMap((group) => group.nodeIds.slice(0, -1).map((from, index) => ({ from, to: group.nodeIds[index + 1]! })))
      : original.nodes.slice(0, original.topology === 'cycle' ? undefined : -1).map((node, index) => ({ from: node.id, to: original.nodes[(index + 1) % original.nodes.length]!.id }));
    const edges = [...(original.edges ?? [])];
    for (const edge of implicit) if (!edges.some((existing) => existing.from === edge.from && existing.to === edge.to)) edges.push(edge);
    const plan = { ...original, edges, annotation: undefined, accentColor: PALETTE.title, nodeFill: PALETTE.pale, textColor: PALETTE.text };
    let elements: PPTElement[], height = preserveOverflow ? Math.max(260, available) : available;
    const diagnostics: string[] = [];
    try {
      if (preserveOverflow) throw new DiagramAllocationError('Original diagram has no measured readable allocation; complete editable source retained');
      const allocations = await measureDiagramAllocations(plan, options.measure, { left: LEFT, top: nodeTop, maxWidth: WIDTH, maxHeight: available });
      const allocation = allocations.find((item) => item.width === WIDTH) ?? allocations[0]!;
      height = allocation.height;
      elements = await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: 'original-diagram', left: LEFT, top: nodeTop, ...allocation }, options.measure);
    } catch (error) {
      if (!(error instanceof DiagramAllocationError)) throw error;
      // The basic native grid is another deterministic layout, constrained to
      // the same remaining rectangle and measured before it can be retained.
      let measurementError: unknown, measurementFailed = false;
      const measured: TextMeasure = async (input) => {
        try { return await options.measure(input); }
        catch (cause) { measurementFailed = true; measurementError = cause; throw cause; }
      };
      elements = await compileMeasuredDiagramComponent({ ...plan, type: 'diagram', id: 'original-diagram', left: LEFT, top: nodeTop, width: WIDTH, height }, measured,
        { onDiagnostic: (detail) => diagnostics.push(detail) });
      if (measurementFailed) throw measurementError;
      for (const element of elements) {
        if (element.type === 'shape' && element.text || element.type === 'text') {
          const html = element.type === 'shape' ? element.text!.content : element.content;
          const label = original.nodes.find((node) => element.id === `original-diagram-node-${node.id}`)?.label ?? html.replace(/<[^>]+>/gu, '');
          const actual = await options.measure({ html, text: label, width: element.width,
            fontSize: element.type === 'shape' ? 20 : Number(html.match(/font-size:(\d+)px/u)?.[1] ?? 16),
            fontWeight: element.type === 'shape' ? 700 : 400, fontFamily: FONT, padding: 10,
            lineHeight: element.type === 'shape' ? 1.25 : element.lineHeight ?? 1.2, paragraphSpace: 0, align: 'center', preserveRichText: true });
          if (!Number.isFinite(actual.height) || actual.height <= 0) throw new Error('Original diagram text measurement returned invalid geometry');
          if (actual.height > element.height + 0.5) {
            if (!preserveOverflow) return null;
            diagnostics.push(`Original diagram ${element.id}: text needs ${actual.height}px; available height ${element.height}px; complete source retained`);
          }
        }
        if (!preserveOverflow && element.type !== 'line' && (element.top < nodeTop - 0.5 || element.top + element.height > BOTTOM + 0.5)) return null;
      }
    }
    const mapping: Record<string, string[]> = {};
    for (const node of original.nodes) addMapping(mapping, [`diagram-node:${node.id}`], [`original-diagram-node-${node.id}`]);
    if (note) addMapping(mapping, ['diagram-annotation'], [note.id]);
    return { block: { elements: [...(note ? [note] : []), ...elements], height: nodeTop - graphTop + height, boxes: new Map(), mapping }, diagnostics };
  };
  type Page = { elements: PPTElement[]; mapping: Record<string, string[]>; items: SlidePresentationItem[]; text: string[]; bottom: number; diagnostics: string[] };
  const emptyPage = (): Page => ({ elements: [title], mapping: {}, items: [], text: [], bottom: top, diagnostics: top >= BOTTOM ? ['Original slide heading leaves no measured body space; complete editable source retained'] : [] });
  const append = (page: Page, block: Block) => {
    page.elements.push(...block.elements);
    for (const [id, targets] of Object.entries(block.mapping)) addMapping(page.mapping, [id], targets);
  };
  const bestContent = async (items: SlidePresentationItem[], at: number): Promise<Block | undefined> => {
    let best: Block | undefined;
    for (const columns of [1, 2, 3]) {
      const candidate = await contentBlocks(items, columns, at, font, options.measure, []);
      if (candidate && at + candidate.height <= BOTTOM && (!best || candidate.height < best.height)) best = candidate;
    }
    return best;
  };
  const pages: Page[] = [], pending = [...points];
  // Pack whole display items first. Only an item larger than an entire page is
  // split, by measured character spans, retaining every original character.
  while (pending.length) {
    let count = pending.length, content: Block | undefined;
    while (count > 0 && !(content = await bestContent(pending.slice(0, count), top))) count -= 1;
    if (!content) {
      const item = pending.shift()!, chars = [...item.text];
      let lo = 0, hi = chars.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = await contentBlocks([{ ...item, text: chars.slice(0, mid).join('') }], 1, top, font, options.measure, []);
        if (candidate && top + candidate.height <= BOTTOM) lo = mid; else hi = mid - 1;
      }
      if (!lo) {
        const page = emptyPage(), full = (await contentBlocks([item], 1, top, font, options.measure, []))!;
        append(page, full); page.items = [item]; page.text = [displayed(item)]; page.bottom = top + full.height;
        page.diagnostics.push('Original text has no measured readable allocation; complete editable source retained'); pages.push(page); continue;
      }
      const first = { ...item, text: chars.slice(0, lo).join('') };
      pending.unshift({ ...item, text: chars.slice(lo).join(''), id: `${item.id}-continued` });
      const page = emptyPage();
      content = (await contentBlocks([first], 1, top, font, options.measure, []))!;
      append(page, content); page.items = [first]; page.text = [displayed(first)]; page.bottom = top + content.height; pages.push(page);
      continue;
    }
    const page = emptyPage(), adopted = pending.splice(0, count);
    append(page, content); page.items = adopted; page.text = adopted.map(displayed); page.bottom = top + content.height; pages.push(page);
  }
  if (!pages.length) pages.push(emptyPage());
  if (original) {
    let page = pages[0]!, graphTop = page.bottom + (page.items.length ? GAP : 0);
    let graph = pages.length === 1 ? await graphAt(graphTop) : null;
    if (!graph && page.items.length) { page = emptyPage(); pages.unshift(page); graphTop = top; graph = await graphAt(graphTop); }
    graph ??= await graphAt(graphTop, true);
    if (!graph) throw new Error('Original diagram has no renderable nodes');
    append(page, graph.block); page.bottom = graphTop + graph.block.height; page.diagnostics.push(...graph.diagnostics);
    page.text.push(...original.nodes.map((node) => node.label), ...(annotation ? [annotation] : []));
    if (annotation) page.items.push({ id: 'diagram-annotation', text: annotation, sourceContentIds: ['diagram-annotation'] });
  }
  for (const image of options.images ?? []) {
    if (!image.src || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) throw new Error(`Original image ${image.id} has invalid dimensions or source`);
    let page = pages[pages.length - 1]!, at = page.bottom + (page.elements.length > 1 ? GAP : 0);
    let block = await imageBand([image], at, BOTTOM - at, font, options.measure);
    if (!block && page.elements.length > 1) { page = emptyPage(); pages.push(page); at = top; block = await imageBand([image], at, BOTTOM - at, font, options.measure); }
    if (!block) {
      const scale = Math.min(WIDTH / image.width, 260 / image.height);
      const rendered: PPTImageElement = { type: 'image', id: image.id, src: image.src, fixedRatio: true, rotate: 0,
        left: LEFT, top: at, width: image.width * scale, height: image.height * scale };
      const caption = image.caption ? await textElement(`${image.id}-caption`, image.caption, { left: LEFT, top: at + rendered.height + 6, width: WIDTH }, font, options.measure) : undefined;
      block = { elements: [rendered, ...(caption ? [caption] : [])], height: rendered.height + (caption ? caption.height + 6 : 0), boxes: new Map(),
        mapping: { [image.id]: [image.id, ...(caption ? [caption.id] : [])] } };
      page.diagnostics.push(`Original image ${image.id} has no measured readable allocation; complete image and caption retained`);
    }
    append(page, block); page.bottom = at + block.height; page.text.push(image.caption ?? outline.visualIntent?.observationGoal ?? outline.title);
  }
  if (pages.some((page) => page.elements.length === 1)) throw new Error('Original slide has no renderable source content');
  const results = pages.map((page): GeneratedSlideContent => {
    if (new Set(page.elements.map((element) => element.id)).size !== page.elements.length) throw new Error('Original source produces conflicting element IDs');
    if (page.bottom > BOTTOM) page.diagnostics.push(`Original slide capacity: measured content reaches y=${page.bottom}px beyond the safe bottom ${BOTTOM}px; complete source retained`);
    return withSemanticTargetAliases(outline, { elements: page.elements, background: { type: 'solid', color: '#FFFFFF' }, qualityDiagnostics: [...new Set(page.diagnostics)],
      sourceGroupIds: Object.keys(page.mapping), teachingText: page.text, occupiedHeight: page.bottom - top, layoutDecision: pages.length > 1 ? 'paginated' : 'original',
      ...(pages.length > 1 ? { paginationVersion: 'balanced-v1' as const } : {}),
      presentationProjection: { schemaVersion: 1, layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION, verified: true, items: page.items, elementIdsBySource: page.mapping } });
  });
  return { ...results[0]!, ...(results.length > 1 ? { continuationPages: results.slice(1), paginationVersion: 'balanced-v1' as const } : {}) };
}
