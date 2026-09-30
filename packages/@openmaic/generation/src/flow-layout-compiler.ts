import type { PPTElement } from '@openmaic/dsl';
import type { DiagramPlan } from './outline-types.js';
import { compileTextComponents, measureLabelGrid, TextLayoutError, type TextBoxComponent, type LabelGridComponent, type TextMeasure } from './text-layout-compiler.js';
import { compileMeasuredDiagramComponent } from './diagram-compiler.js';

export type FlowLeaf =
  | (Omit<TextBoxComponent, 'left' | 'top' | 'x' | 'y' | 'width' | 'height' | 'maxHeight'> & { kind: 'textBox' })
  | (Omit<LabelGridComponent, 'left' | 'top' | 'x' | 'y' | 'width' | 'height'> & { kind: 'labelGrid' })
  | (DiagramPlan & { kind: 'diagram'; id?: string })
  | { kind: 'native'; id?: string; element: { type: 'chart' | 'latex'; [key: string]: unknown }; observation?: string }
  | { kind: 'media'; id?: string; resourceId: string; mediaType?: 'image' | 'video'; aspectRatio?: string; observation?: string };
export interface FlowGroup {
  kind: 'row' | 'column';
  id?: string;
  children: FlowBlock[];
  weights?: number[];
  gap?: number;
  /** Keep a definition, comparison or image with its essential observation intact. Rows default to true. */
  keepTogether?: boolean;
}
export type FlowBlock = FlowLeaf | FlowGroup;
export interface FlowLayout { groups: FlowBlock[] }
export type FlowLayoutDecision = 'original' | 'optimized' | 'paginated';
export interface FlowPageMeasurement {
  strategyVersion: 'adaptive-v2';
  bodyCapacity: number;
  occupiedHeight: number;
  /** Share of the usable body occupied by measured text and useful visual regions. */
  contentLoad: number;
  pageIndex: number;
  pageCount: number;
  sourceGroupIds: string[];
  groups: Array<{ sourceGroupId: string; occupiedHeight: number; contentLoad: number }>;
}
export class FlowLayoutFailure extends Error {
  constructor(
    readonly category: 'page-capacity' | 'section-overload',
    message: string,
    readonly requestedPageCount?: number,
  ) {
    super(message);
    this.name = 'FlowLayoutFailure';
  }
}
export interface CompiledFlowPage {
  elements: PPTElement[];
  sourceGroupIds: string[];
  teachingText: string[];
  paginationVersion?: 'balanced-v1';
  occupiedHeight?: number;
  layoutDecision: FlowLayoutDecision;
  layoutMeasurement: FlowPageMeasurement;
}
interface MeasuredBlock { elements: PPTElement[]; height: number; loadArea: number; teachingText: string[] }
const WIDTH = 900;
const BOTTOM = 512.5;
const GAP = 20;
const COMPACT_GAP = 12;
const FLOW_PALETTE = {
  title: '#1E3A8A', text: '#334155', accent: '#1E40AF',
  surface: '#F1F5F9', border: '#DCE8F4', node: '#EFF6FF',
} as const;
interface LayoutProfile { kind: 'standard' | 'compact'; gap: number }

function panel(id: string, left: number, top: number, width: number, height: number, fill: string): PPTElement {
  return { id, type: 'shape', left, top, width, height, rotate: 0, fixedRatio: false,
    viewBox: [width, height], path: `M0 0 L${width} 0 L${width} ${height} L0 ${height} Z`, fill };
}

function move(elements: PPTElement[], left: number, top: number): PPTElement[] {
  return elements.map((element) => ({ ...element, left: element.left + left, top: element.top + top }));
}
function blockParagraphs(block: Extract<FlowLeaf, { kind: 'textBox' }>): string[] {
  if (!block.paragraphs) return block.text ? [block.text] : [];
  return block.text && !block.paragraphs.includes(block.text) ? [block.text, ...block.paragraphs] : block.paragraphs;
}
function texts(block: FlowBlock): string[] {
  if (block.kind === 'row' || block.kind === 'column') return block.children.flatMap(texts);
  if (block.kind === 'textBox') return blockParagraphs(block);
  if (block.kind === 'labelGrid') return block.rows.flatMap((row) => [...(row.header ? [row.header] : []), ...row.cells]);
  if (block.kind === 'diagram') return [...block.nodes.map((node) => node.label), ...(block.annotation ? [block.annotation] : [])];
  return [];
}
function minimumWidth(block: FlowBlock): number {
  if (block.kind === 'diagram') return block.topology === 'cycle' ? 700 : Math.min(900, block.nodes.length * 145);
  if (block.kind === 'row' || block.kind === 'column') return Math.max(...block.children.map(minimumWidth), 200);
  if (block.kind === 'labelGrid') return Math.max(300, (block.rows[0]?.cells.length ?? 1) * 120);
  return block.kind === 'media' ? 260 : 220;
}

function usefulArea(elements: PPTElement[], kind: FlowLeaf['kind'], width: number, height: number): number {
  if (kind === 'diagram' || kind === 'native') return width * height;
  return elements.reduce((area, element) => area + (element.type === 'text' || element.type === 'image' || element.type === 'video'
    ? element.width * element.height : 0), 0);
}

async function measureBlock(block: FlowBlock, width: number, id: string, measure: TextMeasure, profile: LayoutProfile, planned?: DiagramPlan, resourceDescriptions: Record<string, string> = {}, observationGoal = ''): Promise<MeasuredBlock> {
  if (!block || typeof block !== 'object') throw new Error('Flow blocks must be objects');
  if (block.kind === 'row' || block.kind === 'column') {
    if (!Array.isArray(block.children) || !block.children.length) throw new Error('Flow groups need children');
    const authoredGap = block.gap ?? GAP;
    if (!Number.isFinite(authoredGap) || authoredGap < 12 || authoredGap > 48) throw new Error('Flow group gap must be 12–48px');
    const gap = profile.kind === 'compact' ? Math.min(authoredGap, COMPACT_GAP) : authoredGap;
    const weights = block.weights ?? block.children.map(() => 1);
    if (weights.length !== block.children.length || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) throw new Error('Flow column weights must be positive');
    const total = weights.reduce((sum, value) => sum + value, 0);
    const available = width - gap * (weights.length - 1);
    const authoredWidths = weights.map((weight) => available * weight / total);
    const widthCandidates = [authoredWidths];
    if (profile.kind === 'compact' && block.kind === 'row') {
      const minima = block.children.map(minimumWidth);
      const minimumTotal = minima.reduce((sum, value) => sum + value, 0);
      if (minimumTotal <= available) widthCandidates.push(minima.map((minimum, index) => minimum + (available - minimumTotal) * weights[index]! / total));
      if (block.children.length === 2) {
        for (const share of [0.4, 0.45, 0.55, 0.6]) widthCandidates.push([available * share, available * (1 - share)]);
      }
    }
    let row = false;
    let widths = authoredWidths;
    let children: MeasuredBlock[] | undefined;
    let bestScore = Infinity;
    if (block.kind === 'row') {
      for (const candidate of widthCandidates) {
        if (candidate.some((candidateWidth, index) => candidateWidth < minimumWidth(block.children[index]!) - 0.001)) continue;
        try {
          const measured = await Promise.all(block.children.map((child, index) => measureBlock(child, candidate[index]!, `${id}-${index}`, measure, profile, planned, resourceDescriptions, observationGoal)));
          const height = Math.max(...measured.map((child) => child.height));
          const departure = candidate.reduce((sum, candidateWidth, index) => sum + Math.abs(candidateWidth - authoredWidths[index]!), 0);
          const score = height + departure * 0.015;
          if (score < bestScore - 0.001) { row = true; widths = candidate; children = measured; bestScore = score; }
        } catch (error) {
          if (!(error instanceof TextLayoutError)
            && (!(error instanceof Error) || !/^Invalid diagram component: (?:sequence .*do not fit|edge label (?:.*is too long|exceeds|overlaps))/.test(error.message))) throw error;
        }
      }
    }
    if (!children) children = await Promise.all(block.children.map((child, index) => measureBlock(child, width, `${id}-${index}`, measure, profile, planned, resourceDescriptions, observationGoal)));
    let offset = 0;
    const elements = children.flatMap((child, index) => {
      const placed = move(child.elements, row ? offset : 0, row ? 0 : offset);
      offset += (row ? widths[index] : child.height) + gap;
      return placed;
    });
    return { elements, height: row ? Math.max(...children.map((child) => child.height)) : offset - gap,
      loadArea: children.reduce((area, child) => area + child.loadArea, 0), teachingText: children.flatMap((child) => child.teachingText) };
  }
  let elements: PPTElement[];
  let reservedHeight: number | undefined;
  if (block.kind === 'textBox') {
    elements = await compileTextComponents([{ ...block, text: undefined, paragraphs: blockParagraphs(block), id, role: block.role === 'label' ? 'label' : 'body',
      color: block.color ?? FLOW_PALETTE.text,
      fontSize: Math.max(block.role === 'label' ? 18 : 22, block.fontSize ?? 24), left: 50, top: 50, width }], measure);
  } else if (block.kind === 'labelGrid') {
    elements = await measureLabelGrid({ ...block, id, color: block.color ?? FLOW_PALETTE.text,
      headerFill: block.headerFill ?? FLOW_PALETTE.node, cellFill: block.cellFill ?? FLOW_PALETTE.surface,
      fontSize: Math.max(18, block.fontSize ?? 20), gapY: profile.gap,
      left: 50, top: 50, width, height: 462.5 }, measure);
  } else if (block.kind === 'diagram') {
    const diagram = planned ?? block;
    const heights = diagram.topology === 'cycle' ? [260, 280, 300, 312, 320, 340, 360, 380, 400, 420, 440]
      : [120, 160, 178, 200, 240].map((height) => height + (diagram.edges?.some((edge) => diagram.nodes.findIndex((n) => n.id === edge.from) > diagram.nodes.findIndex((n) => n.id === edge.to)) ? 58 : 0));
    let compiled: PPTElement[] | undefined;
    let lastError: unknown;
    for (const height of heights) {
      try {
        compiled = await compileMeasuredDiagramComponent({ ...diagram, type: 'diagram', id, left: 50, top: 50, width, height,
          accentColor: FLOW_PALETTE.accent, nodeFill: FLOW_PALETTE.node, textColor: FLOW_PALETTE.text }, measure);
        reservedHeight = height;
        break;
      } catch (error) { lastError = error; }
    }
    if (!compiled) throw lastError;
    elements = compiled;
  } else if (block.kind === 'native') {
    if (!block.element || !['chart', 'latex'].includes(block.element.type)) throw new Error('Native flow blocks support editable charts and formulae');
    const height = block.element.type === 'chart' ? 270 : 90;
    elements = [{ ...block.element, id, left: 50, top: 50, width, height, rotate: 0 } as PPTElement];
  } else if (block.kind === 'media') {
    if (typeof block.resourceId !== 'string' || !block.resourceId.trim()) throw new Error('Flow media needs a resource ID');
    const match = /^(16:9|4:3|1:1|9:16)$/.exec(block.aspectRatio ?? '16:9');
    if (!match) throw new Error('Unsupported media aspect ratio');
    const [horizontal, vertical] = match[0].split(':').map(Number);
    const height = Math.min(profile.kind === 'compact' ? 280 : 300, width * vertical / horizontal);
    const imageWidth = height * horizontal / vertical;
    elements = [{ id, type: block.mediaType ?? 'image', left: 50 + (width - imageWidth) / 2, top: 50, width: imageWidth, height,
      rotate: 0, src: block.resourceId, resourceId: block.resourceId, fixedRatio: true } as PPTElement];
  } else throw new Error(`Unknown flow block ${(block as { kind?: string }).kind}`);
  const height = reservedHeight ?? Math.max(...elements.map((element) => element.type === 'line' ? 0 : element.top - 50 + element.height));
  const teachingText = block.kind === 'media'
    ? [block.observation || resourceDescriptions[block.resourceId] || observationGoal].filter(Boolean)
    : block.kind === 'native'
      ? [block.observation || (block.element.type === 'latex' ? `公式：${String(block.element.latex ?? '')}` : observationGoal)].filter(Boolean)
      : texts(block.kind === 'diagram' && planned ? { ...planned, kind: 'diagram' } : block);
  return { elements: move(elements, -50, -50), height,
    loadArea: usefulArea(elements, block.kind, width, height), teachingText };
}

/** Explanations belong outside the relationship, and can move independently when the ring fills a page. */
function extractDiagramAnnotations(block: FlowBlock, planned?: DiagramPlan): { block: FlowBlock; annotations: string[] } {
  if (block.kind === 'diagram') {
    const diagram = planned ?? block;
    return { block: { ...block, annotation: undefined }, annotations: diagram.annotation ? [diagram.annotation] : [] };
  }
  if (block.kind === 'row' || block.kind === 'column') {
    const children = block.children.map((child) => extractDiagramAnnotations(child, planned));
    return { block: { ...block, children: children.map((child) => child.block) }, annotations: children.flatMap((child) => child.annotations) };
  }
  return { block, annotations: [] };
}

/** An oversized container can paginate at its authored child/paragraph boundaries. */
async function fitSemanticParts(block: FlowBlock, capacity: number, id: string, measure: TextMeasure, profile: LayoutProfile, planned?: DiagramPlan, resources?: Record<string, string>, observationGoal?: string): Promise<MeasuredBlock[]> {
  let measured: MeasuredBlock | undefined;
  let heightError: unknown;
  try { measured = await measureBlock(block, WIDTH, id, measure, profile, planned, resources, observationGoal); }
  catch (error) {
    // Large paragraphs and grids can exceed the provisional whole-canvas box.
    if (!(error instanceof Error) || !/Text layout: (?:textBox content needs .*maximum allocation|labelGrid needs .*container is .* high)/.test(error.message)) throw error;
    heightError = error;
  }
  if (measured && measured.height <= capacity) return [measured];
  if ((block.kind === 'row' && block.keepTogether !== false) || (block.kind === 'column' && block.keepTogether)) {
    throw new FlowLayoutFailure('page-capacity', `Semantic ${block.kind} group ${block.id ?? id} needs ${measured?.height}px but a page provides ${capacity}px`);
  }
  if (block.kind === 'labelGrid' && measured) {
    const columns = block.rows[0].cells.length + (block.rows.some((row) => row.header !== undefined) ? 1 : 0);
    const parts: MeasuredBlock[] = [];
    for (let index = 0; index < block.rows.length; index += 1) {
      const row = measured.elements.slice(index * columns * 2, (index + 1) * columns * 2);
      const first = row[0];
      if (first.type === 'line') throw new Error('Grid row must have measurable cells');
      if (first.height > capacity) throw new Error(`Semantic table row ${index + 1} needs ${first.height}px but a page provides ${capacity}px`);
      const source = block.rows[index];
      parts.push({ elements: move(row, 0, -first.top), height: first.height,
        loadArea: usefulArea(row, 'labelGrid', WIDTH, first.height),
        teachingText: [...(source.header ? [source.header] : []), ...source.cells] });
    }
    return parts;
  }
  const parts: FlowBlock[] = block.kind === 'row' || block.kind === 'column'
    ? block.children
    : block.kind === 'textBox' && blockParagraphs(block).length > 1
      ? blockParagraphs(block).map((paragraph) => ({ ...block, text: undefined, paragraphs: [paragraph] }))
      : [];
  if (!parts.length) throw new FlowLayoutFailure('page-capacity',
    heightError instanceof Error ? heightError.message
      : `Semantic ${block.kind} needs ${measured?.height}px but a page provides ${capacity}px; author smaller independent groups`);
  const fitted: MeasuredBlock[] = [];
  for (const [index, part] of parts.entries()) {
    fitted.push(...await fitSemanticParts(part, capacity, `${id}-${index}`, measure, profile, planned, resources, observationGoal));
  }
  return fitted;
}

interface FlowPart { measured: MeasuredBlock; sourceGroupId: string }

/** Choose ordered page breaks globally. The first feasible page count wins; within it,
 * minimizing squared occupied-height differences avoids a dense first page and an empty last page. */
function balancedBreaks(parts: FlowPart[], capacity: number, gap: number): number[] {
  const heights = parts.map((part) => part.measured.height);
  if (heights.some((height) => !Number.isFinite(height) || height < 0 || height > capacity)) {
    throw new FlowLayoutFailure('page-capacity', `Semantic group exceeds the ${capacity}px page body`);
  }
  const prefix = [0];
  const areaPrefix = [0];
  for (const height of heights) prefix.push(prefix[prefix.length - 1]! + height);
  for (const part of parts) areaPrefix.push(areaPrefix[areaPrefix.length - 1]! + part.measured.loadArea / WIDTH);
  const used = (start: number, end: number) => prefix[end]! - prefix[start]! + gap * (end - start - 1);
  const count = parts.length;
  for (let pageCount = 1; pageCount <= count; pageCount += 1) {
    const target = (prefix[count]! + gap * (count - pageCount)) / pageCount;
    const areaTarget = areaPrefix[count]! / pageCount;
    const costs = Array.from({ length: pageCount + 1 }, () => Array<number>(count + 1).fill(Infinity));
    const previous = Array.from({ length: pageCount + 1 }, () => Array<number>(count + 1).fill(-1));
    costs[0]![0] = 0;
    for (let pages = 1; pages <= pageCount; pages += 1) {
      for (let end = pages; end <= count; end += 1) {
        for (let start = pages - 1; start < end; start += 1) {
          const height = used(start, end);
          if (height > capacity + 0.001 || !Number.isFinite(costs[pages - 1]![start])) continue;
          const visualArea = areaPrefix[end]! - areaPrefix[start]!;
          const cost = costs[pages - 1]![start]! + (height - target) ** 2 + 0.25 * (visualArea - areaTarget) ** 2;
          if (cost < costs[pages]![end]! - 0.001) {
            costs[pages]![end] = cost;
            previous[pages]![end] = start;
          }
        }
      }
    }
    if (!Number.isFinite(costs[pageCount]![count])) continue;
    const breaks = [count];
    let end = count;
    for (let pages = pageCount; pages > 0; pages -= 1) {
      end = previous[pages]![end]!;
      breaks.push(end);
    }
    return breaks.reverse();
  }
  throw new FlowLayoutFailure('page-capacity', 'Measured teaching groups cannot fit on continuation pages');
}

/** Measure one semantic plan under both normal and compact geometry before accepting a page break. */
export async function compileFlowLayout(layout: FlowLayout, options: { title: string; id: string; textMeasure: TextMeasure; diagram?: DiagramPlan; resourceDescriptions?: Record<string, string>; observationGoal?: string }): Promise<CompiledFlowPage[]> {
  if (!layout || !Array.isArray(layout.groups) || !layout.groups.length) throw new Error('Flow layout needs semantic groups');
  const titleFor = (title: string, id: string) => compileTextComponents([{ kind: 'textBox', role: 'title', id,
    left: 50, top: 50, width: WIDTH, text: title, fontSize: 34, bold: true, color: FLOW_PALETTE.title }], options.textMeasure);
  const originalTitle = await titleFor(options.title, `${options.id}-title`);
  const title = originalTitle[0];
  if (title.type !== 'text') throw new Error('Title must compile to text');
  const countDiagrams = (block: FlowBlock): number => block.kind === 'diagram' ? 1 : block.kind === 'row' || block.kind === 'column' ? block.children.reduce((sum, child) => sum + countDiagrams(child), 0) : 0;
  const groups = layout.groups.flatMap((group, index) => {
    const extracted = extractDiagramAnnotations(group, options.diagram);
    return [extracted.block, ...extracted.annotations.map((text, annotationIndex): FlowBlock => ({
      kind: 'textBox', id: `${group.id ?? `group-${index}`}-annotation-${annotationIndex}`, text, role: 'body', fontSize: 22,
    }))];
  });
  const plannedDiagram = options.diagram ? { ...options.diagram, annotation: undefined } : undefined;
  const diagramCount = groups.reduce((sum, group) => sum + countDiagrams(group), 0);
  if (options.diagram && diagramCount !== 1) throw new Error('Structured teaching diagram is missing or duplicated');
  const measureParts = async (bodyCapacity: number, profile: LayoutProfile): Promise<FlowPart[]> => {
    const result: FlowPart[] = [];
    for (const [index, group] of groups.entries()) {
      const id = `${options.id}-group-${index}`;
      const fitted = await fitSemanticParts(group, bodyCapacity, id, options.textMeasure, profile, plannedDiagram, options.resourceDescriptions, options.observationGoal || options.title);
      fitted.forEach((measured, partIndex) => result.push({ measured,
        sourceGroupId: fitted.length === 1 ? group.id ?? id : `${group.id ?? id}-part-${partIndex + 1}` }));
    }
    return result;
  };
  interface Candidate { profile: LayoutProfile; capacity: number; parts: FlowPart[]; breaks: number[] }
  const makeCandidate = async (profile: LayoutProfile): Promise<Candidate> => {
    const capacity = BOTTOM - 50 - title.height - profile.gap;
    const parts = await measureParts(capacity, profile);
    const breaks = balancedBreaks(parts, capacity, profile.gap);
    return { profile, capacity, parts, breaks };
  };
  const profiles: LayoutProfile[] = [{ kind: 'standard', gap: GAP }, { kind: 'compact', gap: COMPACT_GAP }];
  const candidates: Candidate[] = [];
  let firstError: unknown;
  for (const profile of profiles) {
    try { candidates.push(await makeCandidate(profile)); }
    catch (error) { firstError ??= error; }
    if (candidates[0]?.breaks.length === 2) break;
  }
  if (!candidates.length) throw firstError instanceof FlowLayoutFailure ? firstError
    : new FlowLayoutFailure('page-capacity', firstError instanceof Error ? firstError.message : String(firstError));
  const imbalance = (candidate: Candidate): number => {
    const loads = candidate.breaks.slice(1).map((end, index) => {
      const start = candidate.breaks[index]!;
      const partHeight = candidate.parts.slice(start, end).reduce((sum, part) => sum + part.measured.height, 0);
      const area = candidate.parts.slice(start, end).reduce((sum, part) => sum + part.measured.loadArea / WIDTH, 0);
      return { height: partHeight + candidate.profile.gap * (end - start - 1), area };
    });
    const heightTarget = loads.reduce((sum, load) => sum + load.height, 0) / loads.length;
    const areaTarget = loads.reduce((sum, load) => sum + load.area, 0) / loads.length;
    return loads.reduce((score, load) => score + (load.height - heightTarget) ** 2 + 0.25 * (load.area - areaTarget) ** 2, 0);
  };
  candidates.sort((a, b) => (a.breaks.length - b.breaks.length) || (imbalance(a) - imbalance(b)) || (a.profile.kind === 'standard' ? -1 : 1));
  const chosen = candidates[0]!;
  const { parts, breaks, profile, capacity } = chosen;
  const pageCount = breaks.length - 1;
  if (pageCount > 2) throw new FlowLayoutFailure('section-overload',
    `Measured teaching units need ${pageCount} pages; return this section for replanning instead of creating sparse continuation pages`, pageCount);
  if (pageCount === 2) {
    const loads = [0, 1].map((pageIndex) => {
      const pageParts = parts.slice(breaks[pageIndex], breaks[pageIndex + 1]);
      const height = pageParts.reduce((sum, part) => sum + part.measured.height, 0) + profile.gap * (pageParts.length - 1);
      const area = pageParts.reduce((sum, part) => sum + part.measured.loadArea, 0);
      return (height / capacity + area / (WIDTH * capacity)) / 2;
    });
    const smaller = Math.min(...loads);
    const larger = Math.max(...loads);
    if (smaller < 0.35 && smaller / larger < 0.45) {
      throw new FlowLayoutFailure('section-overload',
        `Two measured pages remain uneven (${loads.map((load) => `${Math.round(load * 100)}%`).join(' vs ')} useful load); replan this section instead of leaving a sparse continuation`, 2);
    }
  }
  const layoutDecision: FlowLayoutDecision = pageCount > 1 ? 'paginated' : profile.kind === 'compact' ? 'optimized' : 'original';
  const pages: CompiledFlowPage[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const elements = pageCount === 1 ? originalTitle : await titleFor(options.title, `${options.id}-title-${pageIndex + 1}`);
    const heading = elements[0];
    if (heading.type !== 'text') throw new Error('Title must compile to text');
    const bodyTop = 50 + heading.height + profile.gap;
    const start = breaks[pageIndex]!, end = breaks[pageIndex + 1]!;
    const pageHeight = parts.slice(start, end).reduce((sum, part) => sum + part.measured.height, 0)
      + profile.gap * (end - start - 1);
    // Use the same open alignment on original and continuation pages. Center
    // a short semantic composition in the usable body instead of leaving it
    // crowded beneath the title with an accidental blank lower half.
    let cursor = bodyTop + Math.max(0, (BOTTOM - bodyTop - pageHeight) / 2);
    const sourceGroupIds: string[] = [];
    const page: CompiledFlowPage = { elements: [...elements, panel(`${options.id}-title-accent-${pageIndex + 1}`, 50, 50 + heading.height + 5, 96, 3, FLOW_PALETTE.accent)],
      sourceGroupIds, teachingText: [], paginationVersion: 'balanced-v1', occupiedHeight: 0,
      layoutDecision, layoutMeasurement: { strategyVersion: 'adaptive-v2', bodyCapacity: capacity,
        occupiedHeight: 0, contentLoad: 0, pageIndex: pageIndex + 1, pageCount, sourceGroupIds, groups: [] } };
    let loadArea = 0;
    for (let index = breaks[pageIndex]!; index < breaks[pageIndex + 1]!; index += 1) {
      const part = parts[index]!;
      page.elements.push(...move(part.measured.elements, 50, cursor));
      sourceGroupIds.push(part.sourceGroupId);
      page.layoutMeasurement.groups.push({ sourceGroupId: part.sourceGroupId,
        occupiedHeight: part.measured.height, contentLoad: part.measured.loadArea / (WIDTH * capacity) });
      page.teachingText.push(...part.measured.teachingText);
      page.occupiedHeight! += part.measured.height + (index > breaks[pageIndex]! ? profile.gap : 0);
      loadArea += part.measured.loadArea;
      cursor += part.measured.height + profile.gap;
    }
    if (cursor - profile.gap > BOTTOM + 0.001) throw new FlowLayoutFailure('page-capacity', `Balanced page ${pageIndex + 1} exceeds the slide body`);
    page.layoutMeasurement.occupiedHeight = page.occupiedHeight!;
    page.layoutMeasurement.contentLoad = loadArea / (WIDTH * capacity);
    pages.push(page);
  }
  return pages;
}
