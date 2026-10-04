import type { PPTElement, PPTShapeElement, PPTTextElement, SlidePresentationDesign, SlidePresentationItem } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import { slidePresentationLabel } from './slide-visual-projection';
import { presentationRichText } from './slide-presentation-text';

type Rect = { left: number; top: number; width: number; height: number };
type Block = { elements: PPTElement[]; height: number; boxes: Map<string, Rect>; mapping: Record<string, string[]> };
type Options = { items: SlidePresentationItem[]; design: SlidePresentationDesign; rect: Rect; font: number; measure: TextMeasure; compactLabels?: boolean };
type Group = SlidePresentationDesign['groups'][number];
const FONT = 'Noto Sans SC';
/** Prose needs roughly twelve full-width characters per line. Short labels
 * may be narrower, but a tall, six-character sidebar is not a prose layout. */
export function minimumReadableProseWidth(value: string, font: number): number {
  return Math.max(140, Math.min(12, Array.from(value.replace(/\s/gu, '')).length) * font + 20);
}
const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/\n/gu, '<br>');

async function measuredText(id: string, value: string, position: Pick<Rect, 'left' | 'top' | 'width'>,
  options: { font: number; bold?: boolean; color: string; emphasis?: string[]; emphasisStyle?: SlidePresentationItem['emphasisStyle']; align: 'left' | 'center'; measure: TextMeasure;
    inlineLabel?: string; labelColor?: string }): Promise<PPTTextElement> {
  const { font, bold, color, align, measure } = options;
  const label = options.inlineLabel ? `<strong style="font-size:${font}px;color:${options.labelColor ?? color}">${escape(options.inlineLabel)}：</strong>` : '';
  const content = `<p style="font-size:${font}px;font-weight:${bold ? 700 : 400};color:${color};text-align:${align};text-wrap:pretty">${label}${presentationRichText(value, options.emphasis, options.emphasisStyle, color)}</p>`;
  const geometry = await measure({ html: content, text: options.inlineLabel ? `${options.inlineLabel}：${value}` : value, width: position.width, fontSize: font, fontWeight: bold ? 700 : 400,
    fontFamily: FONT, padding: 10, lineHeight: 1.5, paragraphSpace: 5, align, preserveRichText: true });
  if (!Number.isFinite(geometry.height) || geometry.height <= 0 || !Number.isFinite(geometry.naturalWidth)) {
    throw new Error('Authored group text measurement returned invalid geometry');
  }
  return { id, type: 'text', ...position, height: Math.ceil(geometry.height + 1), rotate: 0, content,
    defaultFontName: FONT, defaultColor: color, lineHeight: 1.5, paragraphSpace: 5 };
}

function background(group: Group, rect: Rect): PPTShapeElement {
  return { id: `infographic-authored-group-${encodeURIComponent(group.id)}`, type: 'shape', ...rect, rotate: 0,
    viewBox: [rect.width, rect.height], path: `M0 0H${rect.width}V${rect.height}H0Z`, fixedRatio: false,
    fill: group.treatment === 'accent' ? '#FFF7ED' : '#EFF6FF' };
}

function validDesign(items: SlidePresentationItem[], design: SlidePresentationDesign): boolean {
  if (!design || !items.length || !Array.isArray(design.groups) || !design.groups.length
    || !['rows', 'columns'].includes(design.flow) || !['start', 'center'].includes(design.align)
    || !Number.isFinite(design.gap) || design.gap < 16 || design.gap > 40) return false;
  const expected = new Set(items.map((item) => item.id));
  if (expected.size !== items.length || items.some((item) => typeof item.id !== 'string' || !item.id.trim())) return false;
  const assigned = new Set<string>(), groupIds = new Set<string>();
  for (const group of design.groups) {
    if (!group || typeof group.id !== 'string' || !group.id.trim() || groupIds.has(group.id) || !['plain', 'panel', 'accent'].includes(group.treatment)
      || !Number.isInteger(group.span) || group.span < 1 || group.span > 12
      || ![1, 2, 3].includes(group.columns ?? 1) || !Array.isArray(group.itemIds) || !group.itemIds.length) return false;
    groupIds.add(group.id);
    for (const id of group.itemIds) {
      if (!expected.has(id) || assigned.has(id)) return false;
      assigned.add(id);
    }
  }
  return assigned.size === expected.size;
}

async function layoutGroup(group: Group, members: SlidePresentationItem[], region: Rect,
  design: SlidePresentationDesign, font: number, measure: TextMeasure, compact: boolean, panelInset: number): Promise<Block | null> {
  const columns = group.columns ?? 1, inset = group.treatment === 'plain' ? 0 : panelInset;
  const width = (region.width - 2 * inset - (columns - 1) * design.gap) / columns;
  if (members.some((item) => width < minimumReadableProseWidth(item.text, font))) return null;
  const block: Block = { elements: [], height: 0, boxes: new Map(), mapping: {} };
  const color = '#334155', align = design.align === 'center' ? 'center' : 'left';
  let top = region.top + inset;
  for (let start = 0; start < members.length; start += columns) {
    const heights: number[] = [];
    for (const [column, item] of members.slice(start, start + columns).entries()) {
      const left = region.left + inset + column * (width + design.gap), elementIds: string[] = [];
      let cursor = top;
      if (item.label && !compact) {
        const heading = await measuredText(`infographic-authored-heading-${encodeURIComponent(item.id)}`, item.label, { left, top: cursor, width },
          { font: Math.max(font, 20), bold: true, color, align, measure });
        block.elements.push(heading); elementIds.push(heading.id); cursor += heading.height + 2;
      }
      const body = await measuredText(`infographic-authored-body-${encodeURIComponent(item.id)}`, item.text, { left, top: cursor, width },
        { font, color, emphasis: item.emphasis, emphasisStyle: item.emphasisStyle, align, measure,
          ...(compact && item.label ? { inlineLabel: item.label, labelColor: color } : {}) });
      block.elements.push(body); elementIds.push(body.id);
      const height = body.top + body.height - top;
      block.boxes.set(item.id, { left, top, width, height }); heights.push(height);
      for (const source of item.sourceContentIds) block.mapping[source] = [...new Set([...(block.mapping[source] ?? []), ...elementIds])];
    }
    top += Math.max(...heights) + design.gap;
  }
  block.height = top - design.gap - region.top + inset;
  if (block.height > region.height) return null;
  if (group.treatment !== 'plain') block.elements.unshift(background(group, { ...region, height: block.height }));
  return block;
}

async function layoutAttempt({ items, design, rect, font, measure }: Options, compact: boolean, panelInset: number): Promise<Block | null> {
  const rows = design.flow === 'rows', sum = design.groups.reduce((total, group) => total + group.span, 0);
  const availableWidth = rect.width - (rows ? (design.groups.length - 1) * design.gap : 0);
  if (availableWidth <= 0) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const result: Block = { elements: [], height: 0, boxes: new Map(), mapping: {} };
  let left = rect.left, top = rect.top;
  for (const group of design.groups) {
    const width = rows ? availableWidth * group.span / sum : rect.width;
    const block = await layoutGroup(group, group.itemIds.map((id) => byId.get(id)!),
      { left, top, width, height: rect.height - (top - rect.top) }, design, font, measure, compact, panelInset);
    if (!block) return null;
    result.elements.push(...block.elements);
    for (const [id, box] of block.boxes) result.boxes.set(id, box);
    for (const [source, ids] of Object.entries(block.mapping)) result.mapping[source] = [...new Set([...(result.mapping[source] ?? []), ...ids])];
    result.height = Math.max(result.height, top - rect.top + block.height);
    if (rows) left += width + design.gap;
    else top += block.height + design.gap;
  }
  return result;
}

/** Compile authored groups with at most three measured spacing treatments.
 * Group membership, proportions, media region and body font remain authored. */
export async function layoutAuthoredGroups(options: Options): Promise<Block | null> {
  const { items, design, rect, font } = options;
  if (!validDesign(items, design) || !Object.values(rect).every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(font) || font <= 0) return null;
  const display = { ...options, items: items.map((item) => ({ ...item, label: slidePresentationLabel(item.label) })) };
  return await layoutAttempt(display, options.compactLabels ?? false, 14)
    ?? await layoutAttempt(display, true, 14)
    ?? await layoutAttempt({ ...display, design: { ...design, gap: 16 } }, true, 10);
}
