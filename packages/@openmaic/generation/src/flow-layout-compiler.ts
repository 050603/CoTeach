import type { PPTElement } from '@openmaic/dsl';
import type { DiagramPlan } from './outline-types.js';
import { compileTextComponents, measureLabelGrid, type TextBoxComponent, type LabelGridComponent, type TextMeasure } from './text-layout-compiler.js';
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
}
export type FlowBlock = FlowLeaf | FlowGroup;
export interface FlowLayout { groups: FlowBlock[] }
export interface CompiledFlowPage {
  elements: PPTElement[];
  sourceGroupIds: string[];
  teachingText: string[];
}
interface MeasuredBlock { elements: PPTElement[]; height: number; teachingText: string[] }
const WIDTH = 900;
const BOTTOM = 512.5;
const GAP = 20;

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

async function measureBlock(block: FlowBlock, width: number, id: string, measure: TextMeasure, planned?: DiagramPlan, resourceDescriptions: Record<string, string> = {}, observationGoal = ''): Promise<MeasuredBlock> {
  if (!block || typeof block !== 'object') throw new Error('Flow blocks must be objects');
  if (block.kind === 'row' || block.kind === 'column') {
    if (!Array.isArray(block.children) || !block.children.length) throw new Error('Flow groups need children');
    const gap = block.gap ?? GAP;
    if (!Number.isFinite(gap) || gap < 12 || gap > 48) throw new Error('Flow group gap must be 12–48px');
    const weights = block.weights ?? block.children.map(() => 1);
    if (weights.length !== block.children.length || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) throw new Error('Flow column weights must be positive');
    const total = weights.reduce((sum, value) => sum + value, 0);
    const widths = weights.map((weight) => (width - gap * (weights.length - 1)) * weight / total);
    let row = block.kind === 'row' && block.children.every((child, index) => minimumWidth(child) <= widths[index]);
    const measureChildren = () => Promise.all(block.children.map((child, index) => measureBlock(child, row ? widths[index] : width, `${id}-${index}`, measure, planned, resourceDescriptions, observationGoal)));
    let children: MeasuredBlock[];
    try { children = await measureChildren(); }
    catch (error) {
      // Labels can make a valid relationship wider than the rough minimum.
      // Give its existing group full width before requiring a new model draft.
      if (!row || !(error instanceof Error) || !/^Invalid diagram component: (?:sequence .*do not fit|edge label (?:.*is too long|exceeds|overlaps))/.test(error.message)) throw error;
      row = false;
      children = await measureChildren();
    }
    let offset = 0;
    const elements = children.flatMap((child, index) => {
      const placed = move(child.elements, row ? offset : 0, row ? 0 : offset);
      offset += (row ? widths[index] : child.height) + gap;
      return placed;
    });
    return { elements, height: row ? Math.max(...children.map((child) => child.height)) : offset - gap, teachingText: children.flatMap((child) => child.teachingText) };
  }
  let elements: PPTElement[];
  let reservedHeight: number | undefined;
  if (block.kind === 'textBox') {
    elements = await compileTextComponents([{ ...block, text: undefined, paragraphs: blockParagraphs(block), id, role: block.role === 'label' ? 'label' : 'body',
      fontSize: Math.max(block.role === 'label' ? 18 : 22, block.fontSize ?? 24), left: 50, top: 50, width }], measure);
  } else if (block.kind === 'labelGrid') {
    elements = await measureLabelGrid({ ...block, id, left: 50, top: 50, width, height: 462.5 }, measure);
  } else if (block.kind === 'diagram') {
    const diagram = planned ?? block;
    const heights = diagram.topology === 'cycle' ? [260, 280, 300, 312, 320, 340] : [120 + (diagram.edges?.some((edge) => diagram.nodes.findIndex((n) => n.id === edge.from) > diagram.nodes.findIndex((n) => n.id === edge.to)) ? 58 : 0)];
    let compiled: PPTElement[] | undefined;
    let lastError: unknown;
    for (const height of heights) {
      try {
        compiled = await compileMeasuredDiagramComponent({ ...diagram, type: 'diagram', id, left: 50, top: 50, width, height }, measure);
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
    const height = Math.min(300, width * vertical / horizontal);
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
  return { elements: move(elements, -50, -50), height, teachingText };
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
async function fitSemanticParts(block: FlowBlock, capacity: number, id: string, options: Parameters<typeof measureBlock>[3], planned?: DiagramPlan, resources?: Record<string, string>, observationGoal?: string): Promise<MeasuredBlock[]> {
  let measured: MeasuredBlock | undefined;
  let heightError: unknown;
  try { measured = await measureBlock(block, WIDTH, id, options, planned, resources, observationGoal); }
  catch (error) {
    // Large paragraphs and grids can exceed the provisional whole-canvas box.
    if (!(error instanceof Error) || !/Text layout: (?:textBox content needs .*maximum allocation|labelGrid needs .*container is .* high)/.test(error.message)) throw error;
    heightError = error;
  }
  if (measured && measured.height <= capacity) return [measured];
  if (block.kind === 'labelGrid' && measured) {
    const columns = block.rows[0].cells.length + (block.rows.some((row) => row.header !== undefined) ? 1 : 0);
    const parts: MeasuredBlock[] = [];
    let elements: PPTElement[] = [];
    let teachingText: string[] = [];
    let start = 0;
    let bottom = 0;
    const flush = () => {
      if (elements.length) parts.push({ elements: move(elements, 0, -start), height: bottom - start, teachingText });
      elements = []; teachingText = [];
    };
    for (let index = 0; index < block.rows.length; index += 1) {
      const row = measured.elements.slice(index * columns * 2, (index + 1) * columns * 2);
      const first = row[0];
      if (first.type === 'line') throw new Error('Grid row must have measurable cells');
      if (first.height > capacity) throw new Error(`Semantic table row needs ${first.height}px but a page provides ${capacity}px`);
      if (elements.length && first.top + first.height - start > capacity) flush();
      if (!elements.length) start = first.top;
      bottom = first.top + first.height;
      elements.push(...row);
      const source = block.rows[index];
      teachingText.push(...(source.header ? [source.header] : []), ...source.cells);
    }
    flush();
    return parts;
  }
  const parts: FlowBlock[] = block.kind === 'row' || block.kind === 'column'
    ? block.children
    : block.kind === 'textBox' && blockParagraphs(block).length > 1
      ? blockParagraphs(block).map((paragraph) => ({ ...block, text: undefined, paragraphs: [paragraph] }))
      : [];
  if (!parts.length) throw heightError ?? new Error(`Semantic ${block.kind} needs ${measured?.height}px but a page provides ${capacity}px; author smaller independent groups`);
  const fitted: MeasuredBlock[] = [];
  for (const [index, part] of parts.entries()) {
    fitted.push(...await fitSemanticParts(part, capacity, `${id}-${index}`, options, planned, resources, observationGoal));
  }
  return fitted;
}

/** First-pass layout: measured groups move together, and overflow creates continuation pages. */
export async function compileFlowLayout(layout: FlowLayout, options: { title: string; id: string; textMeasure: TextMeasure; diagram?: DiagramPlan; resourceDescriptions?: Record<string, string>; observationGoal?: string }): Promise<CompiledFlowPage[]> {
  if (!layout || !Array.isArray(layout.groups) || !layout.groups.length) throw new Error('Flow layout needs semantic groups');
  const titleElements = await compileTextComponents([{ kind: 'textBox', role: 'title', id: `${options.id}-title`, left: 50, top: 50, width: WIDTH, text: options.title, fontSize: 34, bold: true }], options.textMeasure);
  const title = titleElements[0];
  if (title.type !== 'text') throw new Error('Title must compile to text');
  const bodyTop = 50 + title.height + GAP;
  const capacity = BOTTOM - bodyTop;
  const pages: CompiledFlowPage[] = [];
  let current: CompiledFlowPage = { elements: [...titleElements], sourceGroupIds: [], teachingText: [] };
  let cursor = bodyTop;
  let diagramCount = 0;
  const countDiagrams = (block: FlowBlock): number => block.kind === 'diagram' ? 1 : block.kind === 'row' || block.kind === 'column' ? block.children.reduce((sum, child) => sum + countDiagrams(child), 0) : 0;
  const groups = layout.groups.flatMap((group, index) => {
    const extracted = extractDiagramAnnotations(group, options.diagram);
    return [extracted.block, ...extracted.annotations.map((text, annotationIndex): FlowBlock => ({
      kind: 'textBox', id: `${group.id ?? `group-${index}`}-annotation-${annotationIndex}`, text, role: 'body', fontSize: 22,
    }))];
  });
  const plannedDiagram = options.diagram ? { ...options.diagram, annotation: undefined } : undefined;
  for (const [index, group] of groups.entries()) {
    diagramCount += countDiagrams(group);
    const id = `${options.id}-group-${index}`;
    const parts = await fitSemanticParts(group, capacity, id, options.textMeasure, plannedDiagram, options.resourceDescriptions, options.observationGoal || options.title);
    for (const [partIndex, measured] of parts.entries()) {
      if (cursor + measured.height > BOTTOM && current.sourceGroupIds.length) {
        pages.push(current);
        current = { elements: titleElements.map((element) => ({ ...element, id: `${element.id}-continuation-${pages.length}` })), sourceGroupIds: [], teachingText: [] };
        cursor = bodyTop;
      }
      current.elements.push(...move(measured.elements, 50, cursor));
      current.sourceGroupIds.push(parts.length === 1 ? group.id ?? id : `${group.id ?? id}-part-${partIndex + 1}`);
      current.teachingText.push(...measured.teachingText);
      cursor += measured.height + GAP;
    }
  }
  if (options.diagram && diagramCount !== 1) throw new Error('Structured teaching diagram is missing or duplicated');
  pages.push(current);
  return pages;
}
