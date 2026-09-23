import { nanoid } from 'nanoid';
import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';

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
  fontFamily: typeof TEXT_LAYOUT_FONT;
  padding: typeof TEXT_LAYOUT_PADDING;
  lineHeight: typeof TEXT_LAYOUT_LINE_HEIGHT;
  paragraphSpace: typeof TEXT_LAYOUT_PARAGRAPH_SPACE;
  align: TextAlign;
}

export interface TextMeasureResult {
  /** Widest unwrapped visible line in px, excluding horizontal padding. */
  naturalWidth: number;
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
  height: number;
}

export interface TextBoxComponent extends ComponentBox {
  kind: 'textBox';
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

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TextLayoutError(`${name} must be a finite number`);
  }
  return value;
}

function componentBox(component: ComponentBox, name: string): Box {
  const left = finiteNumber(component.left ?? component.x, `${name}.left/x`);
  const top = finiteNumber(component.top ?? component.y, `${name}.top/y`);
  const width = finiteNumber(component.width, `${name}.width`);
  const height = finiteNumber(component.height, `${name}.height`);
  if (width <= 2 * TEXT_LAYOUT_PADDING || height <= 0) {
    throw new TextLayoutError(`${name} needs a positive area beyond text padding`);
  }
  if (component.left !== undefined && component.x !== undefined && component.left !== component.x) {
    throw new TextLayoutError(`${name}.left and x disagree`);
  }
  if (component.top !== undefined && component.y !== undefined && component.top !== component.y) {
    throw new TextLayoutError(`${name}.top and y disagree`);
  }
  return { left, top, width, height };
}

function styleOf(component: TextBoxComponent | LabelGridComponent, defaultSize: number): TextStyle {
  const fontSize = component.fontSize ?? defaultSize;
  if (finiteNumber(fontSize, 'fontSize') <= 0) {
    throw new TextLayoutError('fontSize must be positive');
  }
  const align = component.align ?? 'left';
  if (!['left', 'center', 'right'].includes(align)) {
    throw new TextLayoutError('align must be left, center, or right');
  }
  const color = component.color ?? '#263445';
  if (typeof color !== 'string' || !color.trim()) {
    throw new TextLayoutError('color must be a nonempty string');
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
    const first = chars.slice(0, index).join('').trimEnd();
    const second = chars.slice(index).join('').trimStart();
    if (Array.from(first).length < 2 || Array.from(second).length < 2) continue;
    if (/[(（《“‘]$/.test(first) || /^[,，。.!！？?;；:：)）】》”’]/.test(second)) continue;
    const [firstWidth, secondWidth] = await Promise.all([
      naturalWidth(first, style, measure),
      naturalWidth(second, style, measure),
    ]);
    const max = Math.max(firstWidth, secondWidth);
    const whitespaceBoundary = /\s/.test(chars[index - 1] ?? '') || /\s/.test(chars[index] ?? '');
    const punctuationBoundary = /[,，。;；:：]/.test(chars[index - 1] ?? '');
    candidates.push({
      lines: [first, second],
      width: max + 2 * TEXT_LAYOUT_PADDING,
      score: max + Math.abs(firstWidth - secondWidth) * 0.15 - (whitespaceBoundary ? 8 : punctuationBoundary ? 4 : 0),
    });
  }
  return candidates.sort((a, b) => a.score - b.score);
}

async function minimumLabelWidth(text: string, style: TextStyle, measure: Measure): Promise<number> {
  const natural = (await naturalWidth(text, style, measure)) + 2 * TEXT_LAYOUT_PADDING;
  const candidates = await splitCandidates(text, style, measure);
  return Math.min(natural, ...candidates.map((candidate) => candidate.width));
}

async function fitLabel(text: string, width: number, style: TextStyle, measure: Measure): Promise<{ display: string; measurement: TextMeasureResult }> {
  const contentWidth = width - 2 * TEXT_LAYOUT_PADDING;
  if (contentWidth <= 0) throw new TextLayoutError(`label ${JSON.stringify(text)} has no text area`);
  const natural = await naturalWidth(text, style, measure);
  if (natural <= contentWidth + EPSILON) {
    const measurement = await measure([text], width, style);
    const explicitCount = text.split(/\r\n?|\n/).length;
    if (measurement.lines.length > explicitCount) {
      throw new TextLayoutError(`label ${JSON.stringify(text)} wrapped unexpectedly`);
    }
    return { display: text, measurement };
  }
  for (const candidate of await splitCandidates(text, style, measure)) {
    if (candidate.width > width + EPSILON) continue;
    const display = candidate.lines.join('\n');
    const measurement = await measure([display], width, style);
    if (measurement.lines.length === 2) return { display, measurement };
  }
  throw new TextLayoutError(`label ${JSON.stringify(text)} cannot fit in ${width}px without an orphan line`);
}

async function compileTextBox(component: TextBoxComponent, measure: Measure): Promise<PPTElement[]> {
  const box = componentBox(component, 'textBox');
  if (component.text !== undefined && component.paragraphs !== undefined) {
    throw new TextLayoutError('textBox accepts text or paragraphs, not both');
  }
  const paragraphs = component.paragraphs ?? (component.text === undefined ? undefined : [component.text]);
  if (!paragraphs || !Array.isArray(paragraphs) || !paragraphs.length || !paragraphs.every((p) => typeof p === 'string')) {
    throw new TextLayoutError('textBox needs plain text or a nonempty string paragraph array');
  }
  const defaultSize = component.role === 'title' ? 34 : component.role === 'label' ? 20 : 24;
  const style = styleOf(component, defaultSize);
  let output = paragraphs;
  let measured: TextMeasureResult;
  if (component.role === 'label' && paragraphs.length === 1) {
    const fitted = await fitLabel(paragraphs[0], box.width, style, measure);
    output = [fitted.display];
    measured = fitted.measurement;
  } else {
    measured = await measure(paragraphs, box.width, style);
  }
  if (measured.height > box.height + EPSILON) {
    throw new TextLayoutError(`textBox content needs ${measured.height}px but its container is ${box.height}px high`);
  }
  const element = textElement(component.id ?? nanoid(), box, output, style);
  element.vAlign = 'top';
  element.textType = component.role === 'title' ? 'title' : 'content';
  return [element];
}

async function compileLabelGrid(component: LabelGridComponent, measure: Measure): Promise<PPTElement[]> {
  const box = componentBox(component, 'labelGrid');
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
  const style = styleOf(component, 20);
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
  if (minimumTotal > availableWidth + EPSILON) {
    throw new TextLayoutError(`labelGrid needs ${minimumTotal + (totalColumns - 1) * gapX}px but container is ${box.width}px wide`);
  }
  const naturalTotal = naturalWidths.reduce((sum, value) => sum + value, 0);
  const widths = naturalTotal <= availableWidth
    ? naturalWidths.map((value) => value + (availableWidth - naturalTotal) / totalColumns)
    : minimumWidths.map((minimum, index) => {
        const deficit = naturalWidths[index] - minimum;
        const totalDeficit = naturalTotal - minimumTotal;
        return minimum + (availableWidth - minimumTotal) * (totalDeficit === 0 ? 1 / totalColumns : deficit / totalDeficit);
      });
  const fittedRows = await Promise.all(rows.map(async (row) => Promise.all(row.map((cell, column) => fitLabel(cell.text, widths[column], cell.style, measure)))));
  const naturalRowHeights = fittedRows.map((row) => Math.max(...row.map((cell) => cell.measurement.height)));
  const availableHeight = box.height - (rows.length - 1) * gapY;
  const neededHeight = naturalRowHeights.reduce((sum, value) => sum + value, 0);
  if (neededHeight > availableHeight + EPSILON) {
    throw new TextLayoutError(`labelGrid needs ${neededHeight + (rows.length - 1) * gapY}px but container is ${box.height}px high`);
  }
  const extraPerRow = (availableHeight - neededHeight) / rows.length;
  const elements: PPTElement[] = [];
  let top = box.top;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const height = naturalRowHeights[rowIndex] + extraPerRow;
    let left = box.left;
    for (let column = 0; column < totalColumns; column += 1) {
      const cell = rows[rowIndex][column];
      const cellBox = { left, top, width: widths[column], height };
      const groupId = `${component.id ?? 'label-grid'}-${rowIndex}-${column}-${nanoid(4)}`;
      const shape = shapeElement(nanoid(), cellBox, cell.header ? (component.headerFill ?? '#E8EEF6') : (component.cellFill ?? '#F4F7FA'));
      const label = textElement(nanoid(), cellBox, [fittedRows[rowIndex][column].display], cell.style);
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

/** Compile generation-only layout components into ordinary editable PPT elements. */
export async function compileTextComponents(
  components: readonly TextLayoutComponent[],
  textMeasure: TextMeasure,
): Promise<PPTElement[]> {
  if (!Array.isArray(components)) throw new TextLayoutError('components must be an array');
  if (typeof textMeasure !== 'function') throw new TextLayoutError('textMeasure is required');
  const measure = createMeasurer(textMeasure);
  const elements: PPTElement[] = [];
  for (const component of components) {
    if (component?.kind === 'textBox') {
      elements.push(...(await compileTextBox(component, measure)));
    } else if (component?.kind === 'labelGrid') {
      elements.push(...(await compileLabelGrid(component, measure)));
    } else {
      throw new TextLayoutError(`unsupported component kind ${JSON.stringify((component as { kind?: unknown } | null)?.kind)}`);
    }
  }
  return elements;
}
