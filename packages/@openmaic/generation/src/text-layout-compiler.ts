import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { resolveAuthoringContent, type AuthoringContentItem, type AuthoringContentReference } from './authoring-content.js';

/** The layout compiler uses the same typography as BaseTextElement. */
export const TEXT_LAYOUT_FONT = 'Noto Sans SC' as const;
export const TEXT_LAYOUT_PADDING = 10 as const;
export const TEXT_LAYOUT_LINE_HEIGHT = 1.5 as const;
export const TEXT_LAYOUT_PARAGRAPH_SPACE = 5 as const;

export type TextAlign = 'left' | 'center' | 'right';

/** `width` is the outer text-box width, including the renderer's 10px padding. */
export interface TextMeasureInput {
  html: string;
  text: string;
  width: number;
  fontSize: number;
  fontWeight: 400 | 700;
  fontFamily: string;
  padding: number;
  /** Preserve safe native rich text typography during host measurement. */
  preserveRichText?: boolean;
  tableCell?: boolean;
  paddingCss?: string;
  lineHeight: number;
  paragraphSpace: number;
  align: TextAlign;
}

export interface TextMeasureResult {
  /** Widest unwrapped visible line in px, excluding horizontal padding. */
  naturalWidth: number;
  /** Optional host-measured visible glyph extents, relative to the allocated box. */
  inkBottom?: number;
  inkRight?: number;
  /** Actual glyph ink in local allocation coordinates, including padding
   * offsets but excluding padding area. Omit when glyph bounds are unknown. */
  inkRects?: Array<{ left: number; top: number; width: number; height: number }>;
  /** Actual content-box height in px, including top and bottom padding. */
  height: number;
  /** Visible lines after browser layout, in their displayed order. */
  lines: string[];
}

export type TextMeasure = (
  input: TextMeasureInput,
) => TextMeasureResult | Promise<TextMeasureResult>;

interface ComponentBox {
  id?: string;
  left?: number;
  top?: number;
  x?: number;
  y?: number;
  width: number;
  /** Legacy allocation hint. Text boxes are sized from measured content. */
  height?: number;
}

export interface TextBoxComponent extends ComponentBox, AuthoringContentReference {
  kind: 'textBox';
  /** Explicit hard vertical limit, when a neighboring visual reserves the space below. */
  maxHeight?: number;
  /** Plain text; explicit newlines become editable HTML line breaks. */
  text?: string;
  /** Distinct paragraphs; cannot be combined with `text`. */
  paragraphs?: string[];
  role?: 'title' | 'body' | 'label';
  fontSize?: number;
  bold?: boolean;
  color?: string;
  align?: TextAlign;
}

export interface LabelGridComponent extends ComponentBox {
  kind: 'labelGrid';
  height: number;
  rows: Array<{ header?: string; cells: string[] }>;
  /** Defaults to the first row's cell count. */
  columnCount?: number;
  fontSize?: number;
  bold?: boolean;
  color?: string;
  align?: TextAlign;
  gapX?: number;
  gapY?: number;
  cellFill?: string;
  headerFill?: string;
}

export type TextLayoutComponent = TextBoxComponent | LabelGridComponent;

export class TextLayoutError extends Error {
  constructor(message: string) {
    super(`Text layout: ${message}`);
    this.name = 'TextLayoutError';
  }
}

/** Production keeps usable text when a measured quality preference cannot be met. */
export interface TextLayoutDiagnostics {
  onDiagnostic?: (detail: string) => void;
  /** Native authoring can use the spare width inside its own text-only panel. */
  preserveNativeComposition?: boolean;
}

function qualityIssue(message: string, options: TextLayoutDiagnostics): void {
  if (options.onDiagnostic) options.onDiagnostic(`Text layout: ${message}`);
  else throw new TextLayoutError(message);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TextStyle {
  fontSize: number;
  bold: boolean;
  color: string;
  align: TextAlign;
}

interface LabelCell {
  text: string;
  header: boolean;
  style: TextStyle;
}

const EPSILON = 0.5;
const SAFE_LEFT = 50;
const SAFE_TOP = 50;
const SAFE_RIGHT = 950;
const SAFE_BOTTOM = 512.5;

/** Punctuation does not turn a lone CJK glyph into a readable last line. */
export function isOrphanTextLine(line: string): boolean {
  const meaningful = line.replace(/[\s\p{P}\p{S}]/gu, '');
  return /^[\u3400-\u9fff]$/.test(meaningful);
}

const FORBIDDEN_LINE_START = /^[,，、。.!！‼？?;；:：)）\]】〕〉》」』”’…—]/;
const FORBIDDEN_LINE_END = /[(（\[【〔〈《「『“‘]$/;

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TextLayoutError(`${name} must be a finite number`);
  }
  return value;
}

function componentBox(component: ComponentBox, name: string, options: TextLayoutDiagnostics = {}): Box {
  const left = finiteNumber(component.left ?? component.x, `${name}.left/x`);
  const top = finiteNumber(component.top ?? component.y, `${name}.top/y`);
  const width = finiteNumber(component.width, `${name}.width`);
  const height = finiteNumber(component.height, `${name}.height`);
  if (width <= 2 * TEXT_LAYOUT_PADDING || height <= 0) {
    throw new TextLayoutError(`${name} needs a positive area beyond text padding`);
  }
  if (left < SAFE_LEFT || top < SAFE_TOP || left + width > SAFE_RIGHT || top + height > SAFE_BOTTOM) {
    qualityIssue(`${name} lies outside the slide safe area (${SAFE_LEFT}, ${SAFE_TOP})–(${SAFE_RIGHT}, ${SAFE_BOTTOM})`, options);
  }
  if (component.left !== undefined && component.x !== undefined && component.left !== component.x) {
    qualityIssue(`${name}.left and x disagree; retaining left`, options);
  }
  if (component.top !== undefined && component.y !== undefined && component.top !== component.y) {
    qualityIssue(`${name}.top and y disagree; retaining top`, options);
  }
  return { left, top, width, height };
}

function styleOf(component: TextBoxComponent | LabelGridComponent, defaultSize: number, options: TextLayoutDiagnostics = {}): TextStyle {
  let fontSize = component.fontSize ?? defaultSize;
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0) {
    qualityIssue('fontSize must be positive; using the component font default', options);
    fontSize = defaultSize;
  }
  let align = component.align ?? 'left';
  if (!['left', 'center', 'right'].includes(align)) {
    qualityIssue('align must be left, center, or right; using left alignment', options);
    align = 'left';
  }
  let color = component.color ?? '#263445';
  if (typeof color !== 'string' || !color.trim()) {
    qualityIssue('color must be a nonempty string; using the component text color', options);
    color = '#263445';
  }
  return { fontSize, bold: component.bold ?? false, color, align };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlFor(paragraphs: string[], style: TextStyle): string {
  const paragraphStyle = `font-size:${style.fontSize}px;font-weight:${style.bold ? 700 : 400};text-align:${style.align}`;
  return paragraphs
    .map((paragraph) => `<p style="${paragraphStyle}">${escapeHtml(paragraph).replace(/\r\n?|\n/g, '<br>')}</p>`)
    .join('');
}

function textElement(id: string, box: Box, paragraphs: string[], style: TextStyle): PPTTextElement {
  return {
    id,
    type: 'text',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    rotate: 0,
    content: htmlFor(paragraphs, style),
    defaultFontName: TEXT_LAYOUT_FONT,
    defaultColor: style.color,
    lineHeight: TEXT_LAYOUT_LINE_HEIGHT,
    paragraphSpace: TEXT_LAYOUT_PARAGRAPH_SPACE,
    vAlign: 'middle',
    textType: 'content',
  };
}

function shapeElement(id: string, box: Box, fill: string): PPTShapeElement {
  return {
    id,
    type: 'shape',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    rotate: 0,
    viewBox: [box.width, box.height],
    path: `M0 0 L${box.width} 0 L${box.width} ${box.height} L0 ${box.height} Z`,
    fixedRatio: false,
    fill,
  };
}

function checkedMeasurement(result: TextMeasureResult, context: string): TextMeasureResult {
  if (
    !result ||
    !Number.isFinite(result.naturalWidth) ||
    result.naturalWidth < 0 ||
    !Number.isFinite(result.height) ||
    result.height < 0 ||
    !Array.isArray(result.lines) ||
    !result.lines.every((line) => typeof line === 'string')
  ) {
    throw new TextLayoutError(`${context}: text measurer returned invalid dimensions or lines`);
  }
  return result;
}

function createMeasurer(measure: TextMeasure) {
  const cache = new Map<string, Promise<TextMeasureResult>>();
  return (paragraphs: string[], width: number, style: TextStyle): Promise<TextMeasureResult> => {
    const input: TextMeasureInput = {
      html: htmlFor(paragraphs, style),
      text: paragraphs.join('\n\n'),
      width,
      fontSize: style.fontSize,
      fontWeight: style.bold ? 700 : 400,
      fontFamily: TEXT_LAYOUT_FONT,
      padding: TEXT_LAYOUT_PADDING,
      lineHeight: TEXT_LAYOUT_LINE_HEIGHT,
      paragraphSpace: TEXT_LAYOUT_PARAGRAPH_SPACE,
      align: style.align,
    };
    const key = JSON.stringify(input);
    let pending = cache.get(key);
    if (!pending) {
      pending = Promise.resolve(measure(input)).then((result) => checkedMeasurement(result, 'measure'));
      cache.set(key, pending);
    }
    return pending;
  };
}

type Measure = ReturnType<typeof createMeasurer>;

async function naturalWidth(text: string, style: TextStyle, measure: Measure): Promise<number> {
  // The width is intentionally generous: the callback returns the actual, unwrapped
  // content width. Even long labels are measured without imposing a slide width.
  const result = await measure([text], Math.max(10000, text.length * style.fontSize * 2), style);
  return result.naturalWidth;
}

interface SplitCandidate {
  lines: [string, string];
  width: number;
  score: number;
}

async function splitCandidates(text: string, style: TextStyle, measure: Measure): Promise<SplitCandidate[]> {
  if (text.includes('\n') || text.includes('\r')) return [];
  const chars = Array.from(text);
  if (chars.length < 4) return [];
  const candidates: SplitCandidate[] = [];
  for (let index = 2; index <= chars.length - 2; index += 1) {
    if (/[A-Za-z0-9]/.test(chars[index - 1]) && /[A-Za-z0-9]/.test(chars[index])) continue;
    const first = chars.slice(0, index).join('');
    const second = chars.slice(index).join('');
    if (Array.from(first.trim()).length < 2 || Array.from(second.trim()).length < 2) continue;
    if (FORBIDDEN_LINE_END.test(first.trimEnd()) || FORBIDDEN_LINE_START.test(second.trimStart())
      || isOrphanTextLine(first) || isOrphanTextLine(second)) continue;
    const [firstWidth, secondWidth] = await Promise.all([
      naturalWidth(first, style, measure),
      naturalWidth(second, style, measure),
    ]);
    const max = Math.max(firstWidth, secondWidth);
    const whitespaceBoundary = /\s/.test(chars[index - 1] ?? '') || /\s/.test(chars[index] ?? '');
    const punctuationBoundary = /[,，、。!！?？;；:：]/.test(chars[index - 1] ?? '');
    candidates.push({
      lines: [first, second],
      width: max + 2 * TEXT_LAYOUT_PADDING,
      score: max + Math.abs(firstWidth - secondWidth) * 0.15 + (whitespaceBoundary || punctuationBoundary ? 0 : style.fontSize * 4),
    });
  }
  return candidates.sort((a, b) => a.score - b.score);
}

async function minimumLabelWidth(text: string, style: TextStyle, measure: Measure): Promise<number> {
  const natural = (await naturalWidth(text, style, measure)) + 2 * TEXT_LAYOUT_PADDING;
  const candidates = await splitCandidates(text, style, measure);
  return Math.min(natural, ...candidates.map((candidate) => candidate.width));
}

async function fitLabel(text: string, width: number, style: TextStyle, measure: Measure, options: TextLayoutDiagnostics = {}): Promise<{ display: string; measurement: TextMeasureResult }> {
  const contentWidth = width - 2 * TEXT_LAYOUT_PADDING;
  if (contentWidth <= 0) throw new TextLayoutError(`label ${JSON.stringify(text)} has no text area`);
  const explicit = text.split(/\r\n?|\n/);
  for (let index = explicit.length - 1; index > 0; index -= 1) {
    if (isOrphanTextLine(explicit[index]) || FORBIDDEN_LINE_START.test(explicit[index].trimStart())
      || FORBIDDEN_LINE_END.test(explicit[index - 1].trimEnd())) {
      explicit.splice(index - 1, 2, explicit[index - 1] + explicit[index]);
    }
  }
  text = explicit.join('\n');
  const natural = await naturalWidth(text, style, measure);
  if (natural <= contentWidth + EPSILON) {
    const measurement = await measure([text], width, style);
    const explicitCount = text.split(/\r\n?|\n/).length;
    if (measurement.lines.length > explicitCount) {
      qualityIssue(`label ${JSON.stringify(text)} wrapped unexpectedly`, options);
    }
    return { display: text, measurement };
  }
  for (const candidate of await splitCandidates(text, style, measure)) {
    if (candidate.width > width + EPSILON) continue;
    const display = candidate.lines.join('\n');
    const measurement = await measure([display], width, style);
    if (measurement.lines.length === 2 && measurement.lines.every((line) => !isOrphanTextLine(line) && !FORBIDDEN_LINE_START.test(line.trimStart()))) return { display, measurement };
  }
  // Trust actual browser wrapping, including CJK punctuation compression. Its
  // measured height participates in flow; the two-line preference is not a cap.
  const wrapped = await measure([text], width, style);
  if (wrapped.lines.length > 1 && wrapped.lines.join('') === text.replace(/\r?\n/g, '')) {
    if (wrapped.lines.every((line) => [...line.trim()].length > 1 && !isOrphanTextLine(line))) return { display: text, measurement: wrapped };
    const head = wrapped.lines.slice(0, -2);
    const tail = wrapped.lines.slice(-2).join('');
    for (const candidate of await splitCandidates(tail, style, measure)) {
      if (candidate.width > width + EPSILON) continue;
      const display = [...head, ...candidate.lines].join('\n');
      const measurement = await measure([display], width, style);
      if (measurement.lines.length === wrapped.lines.length && measurement.lines.every((line) => !isOrphanTextLine(line) && !FORBIDDEN_LINE_START.test(line.trimStart()))) return { display, measurement };
    }
  }
  qualityIssue(`label ${JSON.stringify(text)} cannot fit in ${width}px without an orphan line`, options);
  return { display: text, measurement: wrapped };
}

async function compileTextBox(component: TextBoxComponent, measure: Measure, options: TextLayoutDiagnostics = {}): Promise<PPTElement[]> {
  const top = finiteNumber(component.top ?? component.y, 'textBox.top/y');
  if (component.height !== undefined && finiteNumber(component.height, 'textBox.height') <= 0) {
    throw new TextLayoutError('textBox.height must be positive when supplied');
  }
  const maximum = component.maxHeight === undefined ? Math.max(1, SAFE_BOTTOM - top) : finiteNumber(component.maxHeight, 'textBox.maxHeight');
  const box = componentBox({ ...component, height: maximum }, 'textBox', options);
  if (component.text !== undefined && component.paragraphs !== undefined) {
    throw new TextLayoutError('textBox accepts text or paragraphs, not both');
  }
  const paragraphs = component.paragraphs ?? (component.text === undefined ? undefined : [component.text]);
  if (!paragraphs || !Array.isArray(paragraphs) || !paragraphs.length || !paragraphs.every((p) => typeof p === 'string')) {
    throw new TextLayoutError('textBox needs plain text or a nonempty string paragraph array');
  }
  const defaultSize = component.role === 'title' ? 34 : component.role === 'label' ? 20 : 24;
  const style = styleOf(component, defaultSize, options);
  let output = paragraphs;
  let measured: TextMeasureResult;
  if (component.role === 'label' && paragraphs.length === 1) {
    const fitted = await fitLabel(paragraphs[0], box.width, style, measure, options);
    output = [fitted.display];
    measured = fitted.measurement;
  } else {
    output = await Promise.all(paragraphs.map(async (paragraph) => {
      const segments = paragraph.split(/\r\n?|\n/);
      for (let index = segments.length - 1; index > 0; index -= 1) {
        if (isOrphanTextLine(segments[index]) || FORBIDDEN_LINE_START.test(segments[index].trimStart())
          || FORBIDDEN_LINE_END.test(segments[index - 1].trimEnd())) segments.splice(index - 1, 2, segments[index - 1] + segments[index]);
      }
      const balanced = await Promise.all(segments.map(async (segment) => {
        const result = await measure([segment], box.width, style);
        if (result.lines.length < 2 || !isOrphanTextLine(result.lines.at(-1)!)) return segment;
        const lines = [...result.lines];
        const tail = lines.splice(-2).join('');
        const fitted = await fitLabel(tail, box.width, style, measure, options);
        // Only introduce measured breaks when text identity is preserved, including Latin spaces.
        const candidate = [...lines, fitted.display].join('\n');
        if (candidate.replace(/\n/g, '') !== segment) return segment;
        return candidate;
      }));
      return balanced.join('\n');
    }));
    measured = await measure(output, box.width, style);
  }
  if (measured.height > box.height + EPSILON) {
    qualityIssue(`textBox content needs ${measured.height}px but its maximum allocation is ${box.height}px high`, options);
  }
  const element = textElement(component.id ?? 'text-box', { ...box, height: measured.height }, output, style);
  element.vAlign = 'top';
  element.textType = component.role === 'title' ? 'title' : 'content';
  return [element];
}

async function compileLabelGrid(component: LabelGridComponent, measure: Measure, naturalRows = false, options: TextLayoutDiagnostics = {}): Promise<PPTElement[]> {
  const box = componentBox(component, 'labelGrid', options);
  if (!Array.isArray(component.rows) || component.rows.length === 0) {
    throw new TextLayoutError('labelGrid needs at least one row');
  }
  const columnCount = component.columnCount ?? component.rows[0]?.cells?.length;
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new TextLayoutError('labelGrid needs at least one cell column');
  }
  const hasHeaders = component.rows.some((row) => row.header !== undefined);
  if (component.rows.some((row) => !row || !Array.isArray(row.cells) || row.cells.length !== columnCount || row.cells.some((cell) => typeof cell !== 'string' || !cell.trim()) || (hasHeaders && (typeof row.header !== 'string' || !row.header.trim())))) {
    throw new TextLayoutError('labelGrid rows need equal, nonempty cells and consistent headers');
  }
  const style = styleOf(component, 20, options);
  const gapX = component.gapX ?? 12;
  const gapY = component.gapY ?? 12;
  if (finiteNumber(gapX, 'labelGrid.gapX') < 0 || finiteNumber(gapY, 'labelGrid.gapY') < 0) {
    throw new TextLayoutError('labelGrid gaps cannot be negative');
  }
  const totalColumns = columnCount + (hasHeaders ? 1 : 0);
  const availableWidth = box.width - (totalColumns - 1) * gapX;
  if (availableWidth <= 2 * TEXT_LAYOUT_PADDING * totalColumns) {
    throw new TextLayoutError('labelGrid columns leave no room for text');
  }
  const rows: LabelCell[][] = component.rows.map((row) => [
    ...(hasHeaders ? [{ text: row.header!, header: true, style: { ...style, bold: true } }] : []),
    ...row.cells.map((text) => ({ text, header: false, style })),
  ]);
  const naturalWidths: number[] = [];
  const minimumWidths: number[] = [];
  for (let column = 0; column < totalColumns; column += 1) {
    const cells = rows.map((row) => row[column]);
    const [natural, minimum] = await Promise.all([
      Promise.all(cells.map(async (cell) => (await naturalWidth(cell.text, cell.style, measure)) + 2 * TEXT_LAYOUT_PADDING)),
      Promise.all(cells.map((cell) => minimumLabelWidth(cell.text, cell.style, measure))),
    ]);
    naturalWidths.push(Math.max(...natural));
    minimumWidths.push(Math.max(...minimum));
  }
  const minimumTotal = minimumWidths.reduce((sum, value) => sum + value, 0);
  const naturalTotal = naturalWidths.reduce((sum, value) => sum + value, 0);
  const widths = minimumTotal > availableWidth + EPSILON
    ? rows[0].map(() => availableWidth / totalColumns)
    : naturalTotal <= availableWidth
    ? naturalWidths.map((value) => value + (availableWidth - naturalTotal) / totalColumns)
    : minimumWidths.map((minimum, index) => {
        const deficit = naturalWidths[index] - minimum;
        const totalDeficit = naturalTotal - minimumTotal;
        return minimum + (availableWidth - minimumTotal) * (totalDeficit === 0 ? 1 / totalColumns : deficit / totalDeficit);
      });
  const fittedRows = await Promise.all(rows.map(async (row) => Promise.all(row.map((cell, column) => fitLabel(cell.text, widths[column], cell.style, measure, options)))));
  const naturalRowHeights = fittedRows.map((row) => Math.max(...row.map((cell) => cell.measurement.height)));
  const availableHeight = box.height - (rows.length - 1) * gapY;
  const neededHeight = naturalRowHeights.reduce((sum, value) => sum + value, 0);
  if (!naturalRows && neededHeight > availableHeight + EPSILON) {
    qualityIssue(`labelGrid needs ${neededHeight + (rows.length - 1) * gapY}px but container is ${box.height}px high`, options);
  }
  const extraPerRow = naturalRows ? 0 : Math.max(0, (availableHeight - neededHeight) / rows.length);
  const elements: PPTElement[] = [];
  let top = box.top;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const height = naturalRowHeights[rowIndex] + extraPerRow;
    let left = box.left;
    for (let column = 0; column < totalColumns; column += 1) {
      const cell = rows[rowIndex][column];
      const cellBox = { left, top, width: widths[column], height };
      const groupId = `${component.id ?? 'label-grid'}-${rowIndex}-${column}`;
      const shape = shapeElement(`${groupId}-shape`, cellBox, cell.header ? (component.headerFill ?? '#E8EEF6') : (component.cellFill ?? '#F4F7FA'));
      const label = textElement(`${groupId}-text`, cellBox, [fittedRows[rowIndex][column].display], cell.style);
      shape.groupId = groupId;
      label.groupId = groupId;
      label.textType = cell.header ? 'header' : 'item';
      elements.push(shape, label);
      left += widths[column] + gapX;
    }
    top += height + gapY;
  }
  return elements;
}

/** Intermediate flow measurement, before pagination; all rows share the full table's column widths. */
export async function measureLabelGrid(component: LabelGridComponent, textMeasure: TextMeasure, options: TextLayoutDiagnostics = {}): Promise<PPTElement[]> {
  try { return await compileLabelGrid(component, createMeasurer(textMeasure), true, options); }
  catch (error) {
    if (!options.onDiagnostic || error instanceof Error && error.name === 'AbortError') throw error;
    const elements = compileUnmeasuredTextComponent(component, options);
    options.onDiagnostic(`Label measurement could not complete; retaining authored boxes: ${error instanceof Error ? error.message : String(error)}`);
    return elements;
  }
}

/** Renderer fallback without claiming a measured fit. All original text stays editable. */
function compileUnmeasuredTextComponent(component: TextLayoutComponent, options: TextLayoutDiagnostics): PPTElement[] {
  const top = finiteNumber(component.top ?? component.y, 'component.top/y');
  const height = component.kind === 'textBox' ? component.height ?? component.maxHeight
    ?? (component.role === 'title' ? (component.fontSize ?? 34) * TEXT_LAYOUT_LINE_HEIGHT + TEXT_LAYOUT_PADDING * 2 : Math.max(1, SAFE_BOTTOM - top)) : component.height;
  const box = componentBox({ ...component, height }, component.kind, options);
  const style = styleOf(component, component.kind === 'textBox' ? component.role === 'title' ? 34 : 24 : 20, options);
  if (component.kind === 'textBox') {
    const paragraphs = component.paragraphs ?? (component.text === undefined ? undefined : [component.text]);
    if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some((paragraph) => typeof paragraph !== 'string')) {
      throw new TextLayoutError('textBox needs plain text or a nonempty string paragraph array');
    }
    const element = textElement(component.id ?? 'text-box', box, paragraphs, style);
    element.vAlign = 'top';
    element.textType = component.role === 'title' ? 'title' : 'content';
    return [element];
  }
  const hasHeaders = component.rows?.some((row) => row.header !== undefined);
  const columns = component.rows?.[0]?.cells?.length;
  if (!Array.isArray(component.rows) || !component.rows.length || !columns
    || component.rows.some((row) => !Array.isArray(row.cells) || row.cells.length !== columns
      || row.cells.some((cell) => typeof cell !== 'string') || hasHeaders && typeof row.header !== 'string')) {
    throw new TextLayoutError('labelGrid requires complete text rows and consistent headers');
  }
  const width = box.width / (columns + (hasHeaders ? 1 : 0));
  const rowHeight = box.height / component.rows.length;
  return component.rows.flatMap((row, rowIndex) => [...(hasHeaders ? [row.header!] : []), ...row.cells].flatMap((text, column) => {
    const cell = { left: box.left + width * column, top: box.top + rowHeight * rowIndex, width, height: rowHeight };
    const id = `${component.id ?? 'label-grid'}-${rowIndex}-${column}`;
    const shape = shapeElement(`${id}-shape`, cell, hasHeaders && !column ? component.headerFill ?? '#E8EEF6' : component.cellFill ?? '#F4F7FA');
    const label = textElement(`${id}-text`, cell, [text], style);
    shape.groupId = id;
    label.groupId = id;
    return [shape, label];
  }));
}

/** Compile generation-only layout components into ordinary editable PPT elements. */
export async function compileTextComponents(
  components: readonly TextLayoutComponent[],
  textMeasure: TextMeasure,
  options: TextLayoutDiagnostics & { authoringContent?: readonly AuthoringContentItem[] } = {},
): Promise<PPTElement[]> {
  if (!Array.isArray(components)) throw new TextLayoutError('components must be an array');
  if (typeof textMeasure !== 'function') throw new TextLayoutError('textMeasure is required');
  const measure = createMeasurer(textMeasure);
  const elements: PPTElement[] = [];
  const resolved = options.authoringContent ? resolveAuthoringContent(components, options.authoringContent) : components;
  for (const [index, rawComponent] of resolved.entries()) {
    const component = { ...rawComponent, id: rawComponent.id ?? `component-${index}` };
    try {
      if (component?.kind === 'textBox') {
        elements.push(...(await compileTextBox(component, measure, options)));
      } else if (component?.kind === 'labelGrid') {
        elements.push(...(await compileLabelGrid(component, measure, false, options)));
      } else {
        throw new TextLayoutError(`unsupported component kind ${JSON.stringify((component as { kind?: unknown } | null)?.kind)}`);
      }
    } catch (error) {
      if (!options.onDiagnostic || error instanceof Error && error.name === 'AbortError') throw error;
      if (component.kind !== 'textBox' && component.kind !== 'labelGrid') throw error;
      let fallback: PPTElement[];
      try { fallback = compileUnmeasuredTextComponent(component, options); }
      catch { throw error; }
      options.onDiagnostic(`Text measurement could not complete; retaining authored boxes: ${error instanceof Error ? error.message : String(error)}`);
      elements.push(...fallback);
    }
  }
  return elements;
}

export interface MeasuredNativeTextStack {
  headers: PPTElement[];
  top: number;
  gap: number;
  capacity: number;
  groups: Array<{ id: string; elements: PPTElement[]; height: number; loadArea: number; teachingText: string[] }>;
}

/** Reuse measured text layout for an independent vertical stack. Only the
 * author's originally disjoint text rows and their unambiguous panels move.
 * Diagrams, tables, media and connectors keep their own layout contracts. */
export async function measureNativeTextStack(
  nativeElements: readonly PPTElement[],
  components: readonly unknown[],
  measure: TextMeasure,
): Promise<MeasuredNativeTextStack | undefined> {
  if (!components.length || components.some((component) => !component || typeof component !== 'object'
    || (component as TextBoxComponent).kind !== 'textBox' || (component as TextBoxComponent).role === 'title')) return;
  const rows = components.map((component) => component as TextBoxComponent)
    .sort((first, second) => (first.top ?? first.y ?? 0) - (second.top ?? second.y ?? 0));
  const authored = rows.map((row) => ({ left: row.left ?? row.x!, top: row.top ?? row.y!, width: row.width, height: row.height! }));
  if (authored.some((box) => Object.values(box).some((value) => !Number.isFinite(value))
    || box.left < SAFE_LEFT || box.top < SAFE_TOP || box.width <= 2 * TEXT_LAYOUT_PADDING || box.height <= 0
    || box.left + box.width > SAFE_RIGHT || box.top + box.height > SAFE_BOTTOM)
    || authored.some((box) => Math.abs(box.left - authored[0]!.left) > EPSILON
      || Math.abs(box.width - authored[0]!.width) > EPSILON)
    || authored.some((box, index) => index > 0 && box.top < authored[index - 1]!.top + authored[index - 1]!.height - EPSILON)) return;
  const contains = (outer: Box, inner: Box) => outer.left <= inner.left + EPSILON && outer.top <= inner.top + EPSILON
    && outer.left + outer.width >= inner.left + inner.width - EPSILON
    && outer.top + outer.height >= inner.top + inner.height - EPSILON;
  const decorations: PPTShapeElement[][] = rows.map(() => []);
  const headers: Array<PPTTextElement | PPTShapeElement> = [];
  const headerBottom = authored[0]!.top;
  for (const element of nativeElements) {
    if (!element || (element.type !== 'text' && element.type !== 'shape')
      || Object.values({ left: element.left, top: element.top, width: element.width, height: element.height })
        .some((value) => !Number.isFinite(value))
      || element.width <= 0 || element.height <= 0 || (element.rotate ?? 0) !== 0) return;
    if (element.top + element.height <= headerBottom + EPSILON) {
      headers.push(element);
      continue;
    }
    if (element.type !== 'shape' || element.text) return;
    const owned = authored.flatMap((box, index) => contains(element, box) ? [index] : []);
    if (owned.length === 1) decorations[owned[0]!]!.push(element);
    else if (owned.length) return;
    else {
      // An adjacent accent bar belongs to the unique row sharing its vertical
      // allocation. Never guess ownership of large peer regions or connections.
      const accents = authored.flatMap((box, index) => element.width <= 12
        && Math.abs(element.top - box.top) <= 12
        && element.top + element.height >= box.top + box.height - EPSILON
        && Math.abs(element.left - box.left) <= 24 ? [index] : []);
      if (accents.length !== 1) return;
      decorations[accents[0]!]!.push(element);
    }
  }
  const units = authored.map((box, index) => {
    const elements = decorations[index]!;
    const left = Math.min(box.left, ...elements.map((element) => element.left));
    const top = Math.min(box.top, ...elements.map((element) => element.top));
    const right = Math.max(box.left + box.width, ...elements.map((element) => element.left + element.width));
    const bottom = Math.max(box.top + box.height, ...elements.map((element) => element.top + element.height));
    return { left, top, width: right - left, height: bottom - top,
      paddingLeft: box.left - left, paddingRight: right - box.left - box.width,
      paddingTop: box.top - top, paddingBottom: bottom - box.top - box.height };
  });
  if (units.some((box, index) => index > 0 && box.top < units[index - 1]!.top + units[index - 1]!.height - EPSILON)) return;
  const top = units[0]!.top;
  if (headers.some((element) => element.top + element.height > top + EPSILON)) return;
  const gap = units.length > 1 ? Math.max(0, Math.min(...units.slice(1)
    .map((box, index) => box.top - units[index]!.top - units[index]!.height))) : 12;
  const capacity = SAFE_BOTTOM - top;
  if (capacity <= 0) return;
  const measureRows = async (allocation: 'original' | 'panel' | 'wide'): Promise<MeasuredNativeTextStack> => {
    const groups: MeasuredNativeTextStack['groups'] = [];
    for (const [index, row] of rows.entries()) {
      const box = authored[index]!, unit = units[index]!;
      const left = allocation === 'wide' ? SAFE_LEFT : unit.left;
      const width = allocation === 'wide' ? SAFE_RIGHT - SAFE_LEFT - unit.paddingLeft - unit.paddingRight
        : allocation === 'panel' ? Math.min(SAFE_RIGHT, unit.left + unit.width) - box.left : box.width;
      if (width < box.width - EPSILON) throw new TextLayoutError('native text stack has no lossless width allocation');
      // Measure at a local safe origin, before deciding which physical page
      // owns the complete row. The authored height is an estimate, not a cap.
      const { x: _x, y: _y, maxHeight: _maximum, ...style } = row;
      const compiled = await compileTextComponents([{ ...style, left: SAFE_LEFT, top: SAFE_TOP, width }], measure);
      const [text] = await compileNativeTextLayout(compiled, measure);
      if (!text || text.type !== 'text') throw new TextLayoutError('native text stack did not compile to editable text');
      const height = Math.max(unit.height, text.height + unit.paddingTop + unit.paddingBottom);
      const growth = height - unit.height;
      const widthGrowth = allocation === 'wide' ? width - box.width : 0;
      const elements = decorations[index]!.map((element): PPTElement => ({ ...element,
        left: left + element.left - unit.left, top: element.top - unit.top,
        width: element.width + (element.width > 12 ? widthGrowth : 0),
        height: element.height + growth,
      }));
      elements.push({ ...text, left: left + unit.paddingLeft, top: unit.paddingTop });
      groups.push({ id: text.id, elements, height, loadArea: text.width * text.height,
        teachingText: row.paragraphs ?? (row.text === undefined ? [] : [row.text]) });
    }
    return { headers, top, gap, capacity, groups };
  };
  const original = await measureRows('original');
  const occupied = (plan: MeasuredNativeTextStack) => plan.groups.reduce((sum, group) => sum + group.height, 0)
    + plan.gap * Math.max(0, plan.groups.length - 1);
  if (occupied(original) <= capacity + EPSILON) return original;
  // A narrow authored estimate can wrap an entire extra line even though its
  // existing panel has spare horizontal room. Use that real room first, keeping
  // every original panel, accent and row position when the measured text fits.
  const panel = await measureRows('panel');
  if (occupied(panel) <= capacity + EPSILON) return panel;
  // Try the full available width at the same author-selected font before
  // using the existing continuation paginator. Original HTML/text stays intact.
  if (units.every((unit) => SAFE_RIGHT - SAFE_LEFT - unit.paddingLeft - unit.paddingRight >= authored[0]!.width - EPSILON)) {
    const expanded = await measureRows('wide');
    if (occupied(expanded) < Math.min(occupied(original), occupied(panel)) - EPSILON) return expanded;
  }
  return occupied(panel) < occupied(original) - EPSILON ? panel : original;
}

/** Native slides retain their authored HTML, styles, geometry, and semantic paragraphs. */
function nativeHtmlText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&#(x[\da-f]+|\d+);/gi, (_, value: string) => String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)))
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&amp;/gi, '&').trim();
}

function nativeBreakCandidates(html: string): string[] {
  // Rebalance only one short paragraph. Never flatten multiple semantic paragraphs,
  // lists or verse; unsupported markup remains intact and yields a precise failure.
  if ((html.match(/<(?:p|li|div|h[1-6])\b/gi)?.length ?? 0) > 1) return [];
  const compact = html.replace(/<br\s*\/?\s*>/gi, '');
  const tokens = [...compact.matchAll(/<[^>]+>|&(?:#x[\da-f]+|#\d+|[a-z]+);|[^<&]|[<&]/giu)];
  const visible = tokens.filter((token) => !token[0].startsWith('<'));
  if (visible.length < 4 || visible.length > 80) return [];
  const breaks: Array<{ html: string; score: number }> = [];
  for (let index = 2; index <= visible.length - 2; index += 1) {
    const before = nativeHtmlText(visible.slice(0, index).map((token) => token[0]).join(''));
    const after = nativeHtmlText(visible.slice(index).map((token) => token[0]).join(''));
    if (FORBIDDEN_LINE_START.test(after) || FORBIDDEN_LINE_END.test(before) || isOrphanTextLine(before) || isOrphanTextLine(after)) continue;
    const offset = visible[index].index!;
    const boundary = /[\s，。；：！？、,;:.!?]$/.test(before);
    breaks.push({ html: compact.slice(0, offset) + '<br>' + compact.slice(offset), score: Math.abs(visible.length / 2 - index) + (boundary ? 0 : 4) });
  }
  return breaks.sort((a, b) => a.score - b.score).slice(0, 12).map((entry) => entry.html);
}

async function measureNativeHtml(
  html: string,
  allocation: { width: number; height: number; id: string },
  spec: Omit<TextMeasureInput, 'html' | 'text' | 'width'>,
  measure: TextMeasure,
  maxHeightGrowth = 0,
  options: TextLayoutDiagnostics = {},
): Promise<{ content: string; requiredHeight: number; measurement?: TextMeasureResult }> {
  const text = nativeHtmlText(html);
  if (!text) return { content: html, requiredHeight: allocation.height };
  const check = (candidate: string) => measure({ ...spec, html: candidate, text: nativeHtmlText(candidate), width: allocation.width, preserveRichText: true });
  const fits = (result: TextMeasureResult) => (result.inkBottom ?? result.height) <= allocation.height + maxHeightGrowth + 1
    && (result.inkRight === undefined || result.inkRight <= allocation.width + 1)
    && (result.inkRight !== undefined || !/white-space\s*:\s*(?:nowrap|pre)\b/i.test(html) || result.naturalWidth + spec.padding * 2 <= allocation.width + 1);
  const measured = await check(html);
  const preservedBreaks = /<(?:pre|code)\b|white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)\b/i.test(html);
  const orphan = !preservedBreaks && measured.lines.length > 1 && measured.lines.some(isOrphanTextLine);
  if (!orphan) {
    if (!fits(measured)) qualityIssue(`native text ${allocation.id} exceeds its authored ${allocation.width}×${allocation.height}px allocation (visible bounds ${measured.inkRight ?? measured.naturalWidth}×${measured.inkBottom ?? measured.height}px)`, options);
    return { content: html, requiredHeight: measured.inkBottom ?? measured.height, measurement: measured };
  }
  for (const candidate of nativeBreakCandidates(html)) {
    const result = await check(candidate);
    if (fits(result) && !result.lines.some(isOrphanTextLine)
      && result.lines.every((line) => !FORBIDDEN_LINE_START.test(line))) {
      return { content: candidate, requiredHeight: result.inkBottom ?? result.height, measurement: result };
    }
  }
  qualityIssue(`native text ${allocation.id} has a single-character wrapped line that cannot fit its authored allocation; widen the label without changing its text or font size`, options);
  return { content: html, requiredHeight: measured.inkBottom ?? measured.height, measurement: measured };
}

/** Measure native foreground text once, making only lossless short-label break edits. */
export async function compileNativeTextLayout(elements: PPTElement[], measure: TextMeasure, options: TextLayoutDiagnostics = {}): Promise<PPTElement[]> {
  type InkRect = NonNullable<TextMeasureResult['inkRects']>[number];
  const intersects = (a: InkRect, b: InkRect) => a.left < b.left + b.width - 0.5 && a.left + a.width > b.left + 0.5
    && a.top < b.top + b.height - 0.5 && a.top + a.height > b.top + 0.5;
  const contains = (outer: InkRect, inner: InkRect) => outer.left <= inner.left + 0.5 && outer.top <= inner.top + 0.5
    && outer.left + outer.width >= inner.left + inner.width - 0.5 && outer.top + outer.height >= inner.top + inner.height - 0.5;
  const sourceInk = new Map<number, InkRect[]>();
  const sourceMeasurements = new Map<number, TextMeasureResult>();
  const compiledInk = new Map<number, InkRect[]>();
  const cache = new Map<string, Promise<TextMeasureResult>>();
  const cachedMeasure: TextMeasure = (input) => {
    const key = JSON.stringify(input);
    let pending = cache.get(key);
    if (!pending) { pending = Promise.resolve(measure(input)); cache.set(key, pending); }
    return pending;
  };
  const specFor = (element: PPTTextElement | PPTShapeElement) => {
    const text = element.type === 'text' ? element : element.text!;
    const sizes = [...text.content.matchAll(/font-size\s*:\s*([\d.]+)px/gi)].map((match) => Number(match[1]));
    return { fontSize: Math.max(16, ...sizes), fontWeight: 400 as const, fontFamily: text.defaultFontName || TEXT_LAYOUT_FONT,
      padding: element.type === 'text' ? 10 : 0, lineHeight: text.lineHeight ?? 1.5,
      paragraphSpace: text.paragraphSpace ?? 5, align: 'left' as const };
  };
  const inkFor = (element: PPTElement, result?: TextMeasureResult): InkRect[] | undefined => {
    if (!result?.inkRects || (element.type !== 'text' && element.type !== 'shape') || (element.rotate ?? 0) !== 0
      || result.inkRects.some((rect) => Object.values(rect).some((value) => !Number.isFinite(value)) || rect.width < 0 || rect.height < 0)) return;
    const alignment = element.type === 'text' ? element.vAlign : element.text?.align;
    const offset = alignment === 'middle' ? Math.max(0, element.height - result.height) / 2
      : alignment === 'bottom' ? Math.max(0, element.height - result.height) : 0;
    return result.inkRects.map((rect) => ({ ...rect, left: rect.left + element.left, top: rect.top + element.top + offset }));
  };
  // Seed every peer before adapting any one box. Cached requests keep this a
  // single measurement of each unchanged HTML/width, with deterministic checks.
  await Promise.all(elements.map(async (element, index) => {
    if (element.type !== 'text' && (element.type !== 'shape' || !element.text)) return;
    const text = element.type === 'text' ? element : element.text!;
    if (!nativeHtmlText(text.content)) return;
    const result = await cachedMeasure({ ...specFor(element), html: text.content, text: nativeHtmlText(text.content),
      width: element.width, preserveRichText: true });
    sourceMeasurements.set(index, result);
    const ink = inkFor(element, result);
    if (ink) sourceInk.set(index, ink);
  }));
  if (options.preserveNativeComposition) {
    // The model can inset a text frame inside a card while the renderer adds
    // another 10px of padding. Use that existing card width before declaring
    // overflow, without changing the card, text, font, vertical rhythm or page.
    const blankPanel = (element: PPTElement): element is PPTShapeElement => element.type === 'shape'
      && !element.text?.content?.trim() && Boolean(element.fill && element.fill !== 'transparent' && element.fill !== 'none')
      && element.opacity !== 0 && (element.rotate ?? 0) === 0 && element.width > 0 && element.height > 0;
    const foregroundBounds = (element: PPTElement): InkRect => {
      if (element.type !== 'line') return element;
      const points = [element.start, element.end, element.broken, element.broken2, element.curve, ...(element.cubic ?? [])]
        .filter((point): point is [number, number] => Boolean(point));
      const padding = Math.max(1, element.width) / 2;
      const left = Math.min(...points.map((point) => point[0])), right = Math.max(...points.map((point) => point[0]));
      const top = Math.min(...points.map((point) => point[1])), bottom = Math.max(...points.map((point) => point[1]));
      return { left: element.left + left - padding, top: element.top + top - padding,
        width: right - left + padding * 2, height: bottom - top + padding * 2 };
    };
    const owners = new Map<number, number>();
    for (const [index, element] of elements.entries()) {
      if (element.type !== 'text' || element.opacity === 0 || (element.rotate ?? 0) !== 0 || !nativeHtmlText(element.content)) continue;
      const owner = elements.flatMap((panel, panelIndex) => panelIndex < index && blankPanel(panel) && contains(panel, element)
        ? [{ index: panelIndex, area: panel.width * panel.height }] : []).sort((a, b) => a.area - b.area)[0];
      if (owner) owners.set(index, owner.index);
    }
    type PanelColumn = { index: number; panel: PPTShapeElement; texts: number[]; insetLeft: number; insetRight: number };
    const columns: PanelColumn[] = [];
    for (const [panelIndex, panel] of elements.entries()) {
      if (!blankPanel(panel)) continue;
      const texts = [...owners].filter(([, owner]) => owner === panelIndex).map(([index]) => index);
      const first = elements[texts[0]!] as PPTTextElement | undefined;
      if (!first || !texts.every((index) => Math.abs(elements[index]!.left - first.left) <= EPSILON
        && Math.abs(elements[index]!.width - first.width) <= EPSILON)) continue;
      const insetLeft = first.left - panel.left, insetRight = panel.left + panel.width - first.left - first.width;
      // Bound this to normal card padding, rather than turning an intentional
      // narrow column inside a large background into a whole-page text box.
      if (insetLeft < 0 || insetRight < 0 || insetLeft + insetRight <= EPSILON
        || Math.max(insetLeft, insetRight) > TEXT_LAYOUT_PADDING * 2) continue;
      if (panel.left < SAFE_LEFT || panel.left + panel.width > SAFE_RIGHT
        || panel.top < SAFE_TOP || panel.top + panel.height > SAFE_BOTTOM) continue;
      const hasOtherContent = elements.some((other, otherIndex) => {
        if (otherIndex === panelIndex || texts.includes(otherIndex) || other.type === 'text') return false;
        // Larger backgrounds own the whole region; nested shapes, media,
        // tables and connectors make this more than a single text column.
        if (otherIndex < panelIndex && blankPanel(other) && contains(other, panel)) return false;
        return intersects(panel, foregroundBounds(other));
      });
      if (!hasOtherContent) columns.push({ index: panelIndex, panel, texts, insetLeft, insetRight });
    }
    const bottomMargin = (column: PanelColumn, index: number) => {
      const ink = sourceInk.get(index);
      return ink?.length ? column.panel.top + column.panel.height - Math.max(...ink.map((rect) => rect.top + rect.height)) : Infinity;
    };
    const needsWidth = (column: PanelColumn) => column.texts.some((index) =>
      (sourceMeasurements.get(index)?.inkBottom ?? sourceMeasurements.get(index)?.height ?? 0) > (elements[index] as PPTTextElement).height + EPSILON
      || bottomMargin(column, index) < TEXT_LAYOUT_PADDING - EPSILON);
    const acceptColumns = async (requested: PanelColumn[]): Promise<boolean> => {
      const candidates = new Map<number, { element: PPTTextElement; measurement: TextMeasureResult; ink: InkRect[] }>();
      for (const column of requested) for (const index of column.texts) {
        const original = elements[index] as PPTTextElement;
        const candidate = { ...original, left: column.panel.left, width: column.panel.width };
        const measured = await cachedMeasure({ ...specFor(candidate), html: candidate.content,
          text: nativeHtmlText(candidate.content), width: candidate.width, preserveRichText: true });
        const ink = inkFor(candidate, measured);
        const inset = { left: column.panel.left + TEXT_LAYOUT_PADDING, top: column.panel.top + TEXT_LAYOUT_PADDING,
          width: column.panel.width - TEXT_LAYOUT_PADDING * 2, height: column.panel.height - TEXT_LAYOUT_PADDING * 2 };
        if (!ink?.length || !ink.every((rect) => contains(inset, rect))
          || (measured.inkBottom ?? measured.height) > candidate.height + EPSILON
          || measured.lines.length > 1 && measured.lines.some(isOrphanTextLine)) return false;
        candidates.set(index, { element: candidate, measurement: measured, ink });
      }
      for (const [index, candidate] of candidates) {
        if (elements.some((other, otherIndex) => {
          if (otherIndex === index) return false;
          const owner = elements[owners.get(index)!] as PPTShapeElement;
          if (otherIndex < index && blankPanel(other) && contains(other, owner)) return false;
          const otherInk = candidates.get(otherIndex)?.ink ?? sourceInk.get(otherIndex);
          return candidate.ink.some((first) => (otherInk ?? [foregroundBounds(other)]).some((second) => intersects(first, second)));
        })) return false;
      }
      elements = elements.map((element, index) => candidates.get(index)?.element ?? element);
      for (const [index, candidate] of candidates) {
        sourceInk.set(index, candidate.ink);
        sourceMeasurements.set(index, candidate.measurement);
      }
      return true;
    };
    for (const column of columns) {
      if (!needsWidth(column)) continue;
      const peers = columns.filter((other) => other.panel.fill === column.panel.fill
        && Math.abs(other.panel.top - column.panel.top) <= EPSILON
        && Math.abs(other.panel.width - column.panel.width) <= EPSILON
        && Math.abs(other.panel.height - column.panel.height) <= EPSILON
        && Math.abs(other.insetLeft - column.insetLeft) <= EPSILON
        && Math.abs(other.insetRight - column.insetRight) <= EPSILON);
      if (await acceptColumns(peers)) continue;
      if (peers.length > 1 && await acceptColumns([column])) continue;
      for (const index of column.texts) if (bottomMargin(column, index) < TEXT_LAYOUT_PADDING - EPSILON) {
        qualityIssue(`native text ${elements[index]!.id} lacks ${TEXT_LAYOUT_PADDING}px bottom clearance in its owning panel ${column.panel.id}; the measured panel-width candidate was not safe`, options);
      }
    }
  }
  const ownBackground = (index: number, other: PPTElement, otherIndex: number, ink?: InkRect[]) => otherIndex < index
    && other.type === 'shape' && !other.text?.content?.trim() && Boolean(other.fill && other.fill !== 'transparent' && other.fill !== 'none')
    && Boolean(ink?.length && ink.every((rect) => contains(other, rect)));
  // A filled shape behind an unrelated caption is background paint, not a
  // foreground obstacle. Keep the containment limit for a card which owns
  // the original text, and still check every actual peer word/image/table.
  const unrelatedBackground = (index: number, other: PPTElement, otherIndex: number) => otherIndex < index
    && other.type === 'shape' && !other.text?.content?.trim()
    && Boolean(other.fill && other.fill !== 'transparent' && other.fill !== 'none')
    && Boolean(sourceInk.get(index)?.length) && !contains(other, elements[index] as InkRect)
    && !ownBackground(index, other, otherIndex, sourceInk.get(index));
  const remember = (index: number, output: PPTElement, measurement?: TextMeasureResult) => {
    const ink = inkFor(output, measurement);
    if (ink) compiledInk.set(index, ink);
    return output;
  };
  const compiled = await Promise.all(elements.map(async (element, index): Promise<PPTElement> => {
    if (element.type === 'text' || (element.type === 'shape' && element.text)) {
      const text = element.type === 'text' ? element : element.text!;
      const html = text.content;
      const spec = specFor(element);
      // Browser glyph bounds can exceed a model's box by a fraction of one
      // line. Grow that box in its available space before rejecting the page.
      const maxHeightGrowth = element.type === 'text' ? Math.min(16, Math.ceil(spec.fontSize / 2)) : 0;
      let resolvedWidth = element.width;
      let result: Awaited<ReturnType<typeof measureNativeHtml>>;
      try {
        result = await measureNativeHtml(html, element, spec, cachedMeasure, maxHeightGrowth);
      } catch (error) {
        if (element.type !== 'text' || element.rotate !== 0 || !(error instanceof TextLayoutError)
          || !/single-character wrapped line/.test(error.message)) {
          if (!options.onDiagnostic || !(error instanceof TextLayoutError)
            || !/exceeds its authored|single-character wrapped line/.test(error.message)) throw error;
          result = await measureNativeHtml(html, element, spec, cachedMeasure, maxHeightGrowth, options);
          return remember(index, element.type === 'text' ? { ...element, content: result.content,
            height: Math.max(element.height, Math.ceil(result.requiredHeight)) } : element, result.measurement);
        }
        let repaired: Awaited<ReturnType<typeof measureNativeHtml>> | undefined;
        const overlapsForeground = (width: number, height: number, measurement?: TextMeasureResult) => elements.some((other, otherIndex) => {
          if (other === element || other.type === 'line' || unrelatedBackground(index, other, otherIndex)) return false;
          const ink = inkFor({ ...element, width, height }, measurement);
          if (ink) {
            if (ownBackground(index, other, otherIndex, sourceInk.get(index)) && ink.every((rect) => contains(other, rect))) return false;
            const otherInk = sourceInk.get(otherIndex);
            return ink.some((first) => (otherInk ?? [other as InkRect]).some((second) => intersects(first, second)));
          }
          const whollyContains = other.left <= element.left && other.top <= element.top
            && other.left + other.width >= element.left + width
            && other.top + other.height >= element.top + height;
          if (whollyContains) return false;
          return element.left < other.left + other.width - 0.5
            && element.left + width > other.left + 0.5
            && element.top < other.top + other.height - 0.5
            && element.top + height > other.top + 0.5;
        });
        for (let width = element.width + 16; element.left + width <= 950; width += 16) {
          const candidate = { ...element, width };
          // Width collisions cannot improve as the box grows. Height
          // collisions may improve if widening removes a wrapped line.
          if (!sourceInk.has(index) && overlapsForeground(width, element.height)) break;
          try {
            const measured = await measureNativeHtml(html, candidate, spec, cachedMeasure, maxHeightGrowth);
            const height = Math.max(element.height, Math.ceil(measured.requiredHeight));
            if (element.top + height > 562.5 || overlapsForeground(width, height, measured.measurement)) continue;
            repaired = measured;
            resolvedWidth = width;
            break;
          } catch (candidateError) {
            if (!(candidateError instanceof TextLayoutError)) throw candidateError;
          }
        }
        if (!repaired) {
          if (!options.onDiagnostic) throw error;
          repaired = await measureNativeHtml(html, element, spec, cachedMeasure, maxHeightGrowth, options);
        }
        result = repaired;
      }
      if (element.type === 'text') return remember(index, {
        ...element,
        width: resolvedWidth,
        content: result.content,
        height: Math.max(element.height, Math.ceil(result.requiredHeight)),
      }, result.measurement);
      return remember(index, result.content === html ? element : { ...element, text: { ...element.text!, content: result.content } }, result.measurement);
    }
    if (element.type !== 'table') return element;
    const widths = element.colWidths.map((width) => width * element.width);
    const rowHeights = element.data.map((_, index) => element.rowHeights?.[index] ?? element.cellMinHeight ?? element.height / element.data.length);
    const occupied = element.data.map(() => new Set<number>());
    const data = [];
    for (const [rowIndex, row] of element.data.entries()) {
      const cells = [];
      let column = 0;
      for (const cell of row) {
        while (occupied[rowIndex].has(column)) column += 1;
        const colspan = Math.max(1, cell.colspan || 1);
        const rowspan = Math.max(1, cell.rowspan || 1);
        const width = widths.slice(column, column + colspan).reduce((sum, value) => sum + value, 0) - 2 * (element.outline?.width ?? 1);
        const spanningHeight = rowHeights.slice(rowIndex, rowIndex + rowspan).reduce((sum, value) => sum + value, 0);
        // Row heights are renderer minima, not fixed cell allocations. Allow a
        // cell to grow its row only within the original whole-table rectangle.
        const height = element.height - rowHeights.reduce((sum, value) => sum + value, 0) + spanningHeight - 2 * (element.outline?.width ?? 1);
        const spec = { fontSize: Number.parseFloat(String(cell.style?.fontsize ?? 16)) || 16,
          fontWeight: cell.style?.bold ? 700 as const : 400 as const, fontFamily: cell.style?.fontname || TEXT_LAYOUT_FONT,
          padding: 0, paddingCss: cell.padding, tableCell: true, lineHeight: 1, paragraphSpace: 0,
          align: cell.style?.align === 'center' || cell.style?.align === 'right' ? cell.style.align : 'left' as const };
        let cellMeasurement: TextMeasureResult | undefined;
        const text = await measureNativeHtml(cell.text, { width, height, id: `${element.id}:${cell.id}` }, spec, async (input) => {
          cellMeasurement = await measure(input);
          return cellMeasurement;
        }, 0, options);
        if (cellMeasurement) {
          const required = Math.max(cellMeasurement.height, cellMeasurement.inkBottom ?? 0) + 2 * (element.outline?.width ?? 1);
          if (required > spanningHeight) rowHeights[Math.min(rowIndex + rowspan - 1, rowHeights.length - 1)] += required - spanningHeight;
        }
        cells.push(text.content === cell.text ? cell : { ...cell, text: text.content });
        for (let next = rowIndex + 1; next < Math.min(element.data.length, rowIndex + rowspan); next += 1) {
          for (let col = column; col < column + colspan; col += 1) occupied[next].add(col);
        }
        column += colspan;
      }
      data.push(cells);
    }
    return { ...element, data };
  }));
  for (const [index, element] of compiled.entries()) {
    const original = elements[index]!;
    if (element.type !== 'text' || original.type !== 'text' || element.height <= original.height) continue;
    if (element.top + element.height > 562.5) {
      qualityIssue(`native text ${element.id} needs ${element.height}px but exceeds the slide canvas`, options);
    }
    const originalBottom = original.top + original.height;
    const obstruction = compiled.find((other, otherIndex) => {
      if (otherIndex === index || other.type === 'line' || unrelatedBackground(index, other, otherIndex)) return false;
      const ink = compiledInk.get(index);
      if (ink) {
        if (ownBackground(index, other, otherIndex, sourceInk.get(index)) && ink.every((rect) => contains(other, rect))) return false;
        const otherInk = compiledInk.get(otherIndex);
        return ink.some((first) => first.top + first.height > originalBottom + 0.5
          && (otherInk ?? [other as InkRect]).some((second) => intersects(first, second)));
      }
      if (other.left <= element.left + 0.5 && other.left + other.width >= element.left + element.width - 0.5
        && other.top <= element.top + 0.5 && other.top + other.height >= element.top + element.height - 0.5) return false;
      return element.left < other.left + other.width - 0.5
        && element.left + element.width > other.left + 0.5
        && originalBottom < other.top + other.height - 0.5
        && element.top + element.height > Math.max(originalBottom, other.top) + 0.5;
    });
    if (obstruction) {
      qualityIssue(`native text ${element.id} needs ${element.height}px but would overlap ${obstruction.id}`, options);
    }
  }
  return compiled;
}
