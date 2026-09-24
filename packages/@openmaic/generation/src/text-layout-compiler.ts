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

export interface TextBoxComponent extends ComponentBox {
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

function componentBox(component: ComponentBox, name: string): Box {
  const left = finiteNumber(component.left ?? component.x, `${name}.left/x`);
  const top = finiteNumber(component.top ?? component.y, `${name}.top/y`);
  const width = finiteNumber(component.width, `${name}.width`);
  const height = finiteNumber(component.height, `${name}.height`);
  if (width <= 2 * TEXT_LAYOUT_PADDING || height <= 0) {
    throw new TextLayoutError(`${name} needs a positive area beyond text padding`);
  }
  if (left < SAFE_LEFT || top < SAFE_TOP || left + width > SAFE_RIGHT || top + height > SAFE_BOTTOM) {
    throw new TextLayoutError(`${name} must stay inside the slide safe area (${SAFE_LEFT}, ${SAFE_TOP})–(${SAFE_RIGHT}, ${SAFE_BOTTOM})`);
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

async function fitLabel(text: string, width: number, style: TextStyle, measure: Measure): Promise<{ display: string; measurement: TextMeasureResult }> {
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
      throw new TextLayoutError(`label ${JSON.stringify(text)} wrapped unexpectedly`);
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
  throw new TextLayoutError(`label ${JSON.stringify(text)} cannot fit in ${width}px without an orphan line`);
}

async function compileTextBox(component: TextBoxComponent, measure: Measure): Promise<PPTElement[]> {
  const top = finiteNumber(component.top ?? component.y, 'textBox.top/y');
  if (component.height !== undefined && finiteNumber(component.height, 'textBox.height') <= 0) {
    throw new TextLayoutError('textBox.height must be positive when supplied');
  }
  const maximum = component.maxHeight === undefined ? SAFE_BOTTOM - top : finiteNumber(component.maxHeight, 'textBox.maxHeight');
  const box = componentBox({ ...component, height: maximum }, 'textBox');
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
        const fitted = await fitLabel(tail, box.width, style, measure);
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
    throw new TextLayoutError(`textBox content needs ${measured.height}px but its maximum allocation is ${box.height}px high`);
  }
  const element = textElement(component.id ?? 'text-box', { ...box, height: measured.height }, output, style);
  element.vAlign = 'top';
  element.textType = component.role === 'title' ? 'title' : 'content';
  return [element];
}

async function compileLabelGrid(component: LabelGridComponent, measure: Measure, naturalRows = false): Promise<PPTElement[]> {
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
  const fittedRows = await Promise.all(rows.map(async (row) => Promise.all(row.map((cell, column) => fitLabel(cell.text, widths[column], cell.style, measure)))));
  const naturalRowHeights = fittedRows.map((row) => Math.max(...row.map((cell) => cell.measurement.height)));
  const availableHeight = box.height - (rows.length - 1) * gapY;
  const neededHeight = naturalRowHeights.reduce((sum, value) => sum + value, 0);
  if (!naturalRows && neededHeight > availableHeight + EPSILON) {
    throw new TextLayoutError(`labelGrid needs ${neededHeight + (rows.length - 1) * gapY}px but container is ${box.height}px high`);
  }
  const extraPerRow = naturalRows ? 0 : (availableHeight - neededHeight) / rows.length;
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
export async function measureLabelGrid(component: LabelGridComponent, textMeasure: TextMeasure): Promise<PPTElement[]> {
  return compileLabelGrid(component, createMeasurer(textMeasure), true);
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
  for (const [index, rawComponent] of components.entries()) {
    const component = { ...rawComponent, id: rawComponent.id ?? `component-${index}` };
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
): Promise<{ content: string; requiredHeight: number }> {
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
    if (!fits(measured)) throw new TextLayoutError(`native text ${allocation.id} exceeds its authored ${allocation.width}×${allocation.height}px allocation (visible bounds ${measured.inkRight ?? measured.naturalWidth}×${measured.inkBottom ?? measured.height}px)`);
    return { content: html, requiredHeight: measured.inkBottom ?? measured.height };
  }
  for (const candidate of nativeBreakCandidates(html)) {
    const result = await check(candidate);
    if (fits(result) && !result.lines.some(isOrphanTextLine)
      && result.lines.every((line) => !FORBIDDEN_LINE_START.test(line))) {
      return { content: candidate, requiredHeight: result.inkBottom ?? result.height };
    }
  }
  throw new TextLayoutError(`native text ${allocation.id} has a single-character wrapped line that cannot fit its authored allocation; widen the label without changing its text or font size`);
}

/** Measure native foreground text once, making only lossless short-label break edits. */
export async function compileNativeTextLayout(elements: PPTElement[], measure: TextMeasure): Promise<PPTElement[]> {
  const compiled = await Promise.all(elements.map(async (element): Promise<PPTElement> => {
    if (element.type === 'text' || (element.type === 'shape' && element.text)) {
      const text = element.type === 'text' ? element : element.text!;
      const html = text.content;
      const fontSizes = [...html.matchAll(/font-size\s*:\s*([\d.]+)px/gi)].map((match) => Number(match[1]));
      const spec = { fontSize: Math.max(16, ...fontSizes), fontWeight: 400 as const, fontFamily: text.defaultFontName || TEXT_LAYOUT_FONT,
        padding: element.type === 'text' ? 10 : 0, lineHeight: text.lineHeight ?? 1.5,
        paragraphSpace: text.paragraphSpace ?? 5, align: 'left' as const };
      // Browser glyph bounds can exceed a model's box by a fraction of one
      // line. Grow that box in its available space before rejecting the page.
      const maxHeightGrowth = element.type === 'text' ? Math.min(16, Math.ceil(spec.fontSize / 2)) : 0;
      const result = await measureNativeHtml(html, element, spec, measure, maxHeightGrowth);
      if (element.type === 'text') return {
        ...element,
        content: result.content,
        height: Math.max(element.height, Math.ceil(result.requiredHeight)),
      };
      return result.content === html ? element : { ...element, text: { ...element.text!, content: result.content } };
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
        });
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
      throw new TextLayoutError(`native text ${element.id} needs ${element.height}px but exceeds the slide canvas`);
    }
    const originalBottom = original.top + original.height;
    const obstruction = compiled.find((other, otherIndex) => {
      if (otherIndex === index || other.type === 'line') return false;
      if (other.left <= element.left + 0.5 && other.left + other.width >= element.left + element.width - 0.5
        && other.top <= element.top + 0.5 && other.top + other.height >= element.top + element.height - 0.5) return false;
      return element.left < other.left + other.width - 0.5
        && element.left + element.width > other.left + 0.5
        && originalBottom < other.top + other.height - 0.5
        && element.top + element.height > Math.max(originalBottom, other.top) + 0.5;
    });
    if (obstruction) {
      throw new TextLayoutError(`native text ${element.id} needs ${element.height}px but would overlap ${obstruction.id}`);
    }
  }
  return compiled;
}
