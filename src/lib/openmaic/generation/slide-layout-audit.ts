import { access } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { PPTElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { RenderedElement, VisibleRect } from '@/lib/course-quality-review/render-measurements';
import { auditGeneratedSlide } from './slide-quality';

export type SlideLayoutAuditStatus = 'checked' | 'unavailable';

export interface SlideLayoutAudit {
  status: SlideLayoutAuditStatus;
  method: 'openmaic-renderer-chromium-v1';
  issues: string[];
  findings?: SlideLayoutFinding[];
  measurements?: RenderedElement[];
  reason?: string;
}

export interface SlideLayoutFinding {
  id: string;
  title: string;
  evidence: string;
  elementId?: string;
}

export interface SlideLayoutRepairResult {
  content: GeneratedSlideContent;
  initialAudit: SlideLayoutAudit;
  finalAudit: SlideLayoutAudit;
  repairAttempted: boolean;
  adopted: 'first-draft' | 'repair';
  initialKnowledgeCoverage: number;
  finalKnowledgeCoverage: number;
  initialDensityIssues: string[];
  finalDensityIssues: string[];
  initialVisibleTextCharacters: number;
  finalVisibleTextCharacters: number;
  initialVerticalSpan: number;
  finalVerticalSpan: number;
  initialContentAreaUtilization: number;
  finalContentAreaUtilization: number;
  initialMaxBlankBand: number;
  finalMaxBlankBand: number;
  initialHasDeepBlueTitle: boolean;
  finalHasDeepBlueTitle: boolean;
  initialHasSubtitle: boolean;
  finalHasSubtitle: boolean;
  semanticStructureRequired: boolean;
  initialSemanticStructures: string[];
  finalSemanticStructures: string[];
  initialSemanticStructureSatisfied: boolean;
  finalSemanticStructureSatisfied: boolean;
  initialPaletteDeviationCount: number;
  finalPaletteDeviationCount: number;
  initialElementCount: number;
  finalElementCount: number;
  initialSemanticElementCount: number;
  finalSemanticElementCount: number;
  initialQualityScore: number;
  finalQualityScore: number;
}

export interface SlideDensityAudit {
  issues: string[];
  visibleTextCharacters: number;
  verticalSpan: number;
  underrepresentedKeyPoints: Array<{ keyPoint: string; coverage: number }>;
  contentAreaUtilization: number;
  maxBlankBand: number;
  hasDeepBlueTitle: boolean;
  hasSubtitle: boolean;
  semanticStructureRequired: boolean;
  semanticStructures: string[];
  semanticStructureSatisfied: boolean;
  paletteDeviationCount: number;
  elementCount: number;
  semanticElementCount: number;
}

const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
let browser: Browser | undefined;
let page: Page | undefined;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function launchBrowser(): Promise<Browser> {
  const configured = process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH?.trim();
  const systemCandidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  const candidates: Array<string | undefined> = configured ? [configured] : [];
  for (const candidate of systemCandidates) {
    if (await exists(candidate)) candidates.push(candidate);
  }
  candidates.push(undefined);
  let cause: unknown;
  for (const executablePath of candidates) {
    try {
      return await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    } catch (error) {
      cause = error;
    }
  }
  throw cause ?? new Error('No Chromium executable is available');
}

async function getPage(): Promise<Page> {
  if (page && browser?.isConnected()) return page;
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1000, height: 563 } });
  const auditUrl = layoutAuditUrl();
  const allowedOrigin = new URL(auditUrl).origin;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(allowedOrigin) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    return route.abort();
  });
  await page.goto(auditUrl, { waitUntil: 'networkidle', timeout: 15_000 });
  await page.waitForFunction(() => typeof window.__openPblAuditSlide === 'function', undefined, {
    timeout: 10_000,
  });
  return page;
}

function layoutAuditUrl(): string {
  const configured = process.env.OPENPBL_LAYOUT_AUDIT_URL?.trim();
  const value = configured || `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}/internal/slide-layout-audit`;
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('OPENPBL_LAYOUT_AUDIT_URL must use a loopback host');
  }
  return url.toString();
}

async function resetBrowser(): Promise<void> {
  const current = browser;
  browser = undefined;
  page = undefined;
  await current?.close().catch(() => undefined);
}

function serialized<T>(work: (target: Page) => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(async () => {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      return await work(await getPage());
    } finally {
      idleTimer = setTimeout(() => void resetBrowser(), 30_000);
      idleTimer.unref?.();
    }
  });
  queue = run;
  return run;
}

function auditSafeElements(elements: readonly PPTElement[]): PPTElement[] {
  return elements.map((element) => {
    if (element.type === 'image') return { ...element, src: PIXEL };
    if (element.type === 'video') return { ...element, src: undefined };
    return { ...element };
  }) as PPTElement[];
}

async function inspectRenderedElements(
  target: Page,
  content: GeneratedSlideContent,
  outlineId: string,
): Promise<{ issues: SlideLayoutFinding[]; measurements: RenderedElement[] }> {
  const inspection = target.evaluate(async ({ slideContent, sceneId }) => {
    if (!window.__openPblAuditSlide) throw new Error('Layout audit renderer is unavailable');
    const result = await window.__openPblAuditSlide({ content: slideContent, outlineId: sceneId });
    return result;
  }, {
    slideContent: { ...content, elements: auditSafeElements(content.elements) },
    sceneId: outlineId,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Layout audit timed out for ${outlineId}`)), 10_000);
    timer.unref?.();
  });
  try {
    return await Promise.race([inspection, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function concreteIssue(issue: { id: string }): boolean {
  return /:(?:invisible-text|overflow|box-overflow|small-type|overlap-|collision-|occluded-)/.test(issue.id);
}

export function structuralSlideIssues(elements: readonly PPTElement[]): string[] {
  return elements.flatMap((element) => {
    if (element.type === 'text' && typeof element.content !== 'string') {
      return [`text ${element.id} has no renderable content`];
    }
    if (element.type === 'table') {
      if (!Array.isArray(element.data) || element.data.length === 0) {
        return [`table ${element.id} has no rows`];
      }
      const invalidCells = element.data.flat().filter((cell) => typeof cell?.text !== 'string');
      if (invalidCells.length > 0) {
        return [`table ${element.id} has ${invalidCells.length} malformed cell(s)`];
      }
    }
    if (element.type === 'chart') {
      const labels = element.data?.labels ?? [];
      const legends = element.data?.legends ?? [];
      const series = element.data?.series ?? [];
      if (!labels.length || !series.length || series.some((values) => values.length !== labels.length)) {
        return [`chart ${element.id} has inconsistent labels or series`];
      }
      if (legends.length !== series.length) {
        return [`chart ${element.id} has inconsistent legends or series`];
      }
    }
    return [];
  });
}

/** Render with the actual OpenMAIC renderer and report only actionable defects. */
export async function auditSlideLayout(
  content: GeneratedSlideContent,
  outlineId: string,
): Promise<SlideLayoutAudit> {
  const structural = [
    ...auditGeneratedSlide(content.elements).reasons,
    ...structuralSlideIssues(content.elements),
  ];
  try {
    const inspected = await serialized((target) => inspectRenderedElements(target, content, outlineId));
    const findings = inspected.issues.filter(concreteIssue);
    const rendered = findings.map((issue) =>
      `${issue.title}：${issue.evidence}${issue.elementId ? `（${issue.elementId}）` : ''}`,
    );
    return {
      status: 'checked',
      method: 'openmaic-renderer-chromium-v1',
      issues: [...new Set([...structural, ...rendered])],
      findings,
      measurements: inspected.measurements,
    };
  } catch (error) {
    await resetBrowser();
    return {
      status: 'unavailable',
      method: 'openmaic-renderer-chromium-v1',
      issues: structural,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function visibleText(elements: readonly PPTElement[]): string {
  return elements.map((element) => {
    if (element.type === 'text') return element.content;
    if (element.type === 'shape') return element.text?.content ?? '';
    if (element.type === 'table') return element.data.flat().map((cell) => cell.text).join(' ');
    if (element.type === 'chart') return JSON.stringify(element.data ?? '');
    if (element.type === 'latex') return element.latex ?? element.html ?? '';
    if (element.type === 'code') return element.lines.map((line) => line.content).join('\n');
    return '';
  }).join(' ').replace(/<[^>]+>/g, ' ').toLocaleLowerCase();
}

function semanticUnits(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const units = new Set<string>();
  for (const word of value.toLocaleLowerCase().match(/[a-z][a-z0-9_-]{2,}|\d+(?:\.\d+)?/g) ?? []) units.add(word);
  for (let index = 0; index < normalized.length - 1; index += 1) units.add(normalized.slice(index, index + 2));
  return units;
}

export function slideKnowledgeCoverage(
  keyPoints: readonly string[],
  elements: readonly PPTElement[],
): number {
  const meaningful = keyPoints.filter((keyPoint) => semanticUnits(keyPoint).size > 0);
  if (meaningful.length === 0) return 1;
  // Page copy is intentionally concise and may paraphrase the outline. Count
  // a confirmed proposition as visible when a conservative share of its
  // lexical anchors survives, rather than requiring nearly every bigram of a
  // long source sentence. The latter produced misleading 8-30% reports even
  // when the page visibly contained the concept, relation and example.
  const represented = meaningful.filter((keyPoint) =>
    keyPointCoverage(keyPoint, elements) >= 0.3,
  ).length;
  return represented / meaningful.length;
}

/**
 * The PPT contract is broader than the concise outline key points. In
 * particular, first-introduced concept definitions compiled into
 * teachingPlan.visibleContent must stay visible even when the key point uses a
 * short label. Keep one combined set for first generation scoring and the
 * existing single repair opportunity.
 */
export function slideRequiredVisibleStatements(outline: SceneOutline): string[] {
  return [...new Set([
    ...outline.keyPoints,
    ...(outline.teachingBrief?.teachingPlan?.visibleContent ?? []),
  ].map((statement) => statement.trim()).filter(Boolean))];
}

function keyPointCoverage(keyPoint: string, elements: readonly PPTElement[]): number {
  const expected = semanticUnits(keyPoint);
  if (expected.size === 0) return 1;
  const actual = semanticUnits(visibleText(elements));
  return [...expected].filter((unit) => actual.has(unit)).length / expected.size;
}

function visibleTextCharacters(elements: readonly PPTElement[]): number {
  return visibleText(elements).replace(/[^\p{L}\p{N}]+/gu, '').length;
}

function elementVisibleText(element: PPTElement): string {
  if (element.type === 'text') return element.content.replace(/<[^>]+>/g, ' ');
  if (element.type === 'shape') return element.text?.content?.replace(/<[^>]+>/g, ' ') ?? '';
  if (element.type === 'table') return element.data.flat().map((cell) => cell.text).join(' ');
  return '';
}

function normalizedHex(value: string): string {
  const color = value.trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(color)) {
    return `#${color.slice(1).split('').map((part) => `${part}${part}`).join('')}`;
  }
  return color;
}

function elementColors(element: PPTElement): string[] {
  const serialized = JSON.stringify(element);
  return [...new Set((serialized.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map(normalizedHex))];
}

const DEEP_BLUE_TITLE_COLORS = new Set(['#1E3A8A', '#1E40AF']);
/**
 * Colors actually used by slide elements in the supplied OpenMAIC v1.0.2
 * seven-slide export. The package's legacy `themeColors` metadata is not
 * included: those values are defaults in the DSL and are not the visible
 * editorial palette of the reference slides.
 */
const REFERENCE_ELEMENT_PALETTE = new Set([
  '#FFFFFF', '#F8FAFC', '#F1F5F9', '#EFF6FF', '#F0F9FF', '#E8F4FD', '#E0F2FE',
  '#FFF3E0', '#FFF7ED', '#E2E8F0', '#CBD5E1',
  '#1E3A8A', '#1E40AF', '#0284C7', '#0369A1',
  '#0F172A', '#1E293B', '#334155', '#475569', '#64748B', '#94A3B8',
  '#333333', '#666666', '#DC2626', '#ED7D31',
]);
const REFERENCE_BACKGROUNDS = new Set([
  '#FFFFFF', '#F8FAFC', '#F1F5F9', '#F0F9FF', '#E8F4FD', '#E0F2FE',
]);

function hexRgb(color: string): [number, number, number] | undefined {
  const normalized = normalizedHex(color);
  const match = /^#([0-9A-F]{6})(?:[0-9A-F]{2})?$/.exec(normalized);
  if (!match) return undefined;
  const value = match[1]!;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function nearestReferenceColor(color: string): string {
  const source = hexRgb(color);
  if (!source) return color;
  let nearest = '#334155';
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of REFERENCE_ELEMENT_PALETTE) {
    const rgb = hexRgb(candidate)!;
    // Perceptual-ish weighted RGB is deterministic and keeps pale fills pale,
    // dark text dark, and warm warning accents in the permitted warm family.
    const distance = 2 * (source[0] - rgb[0]) ** 2
      + 4 * (source[1] - rgb[1]) ** 2
      + 3 * (source[2] - rgb[2]) ** 2;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function normalizeElementPalette(
  elements: readonly PPTElement[],
): { elements: PPTElement[]; changed: boolean } {
  let changed = false;
  const serialized = JSON.stringify(elements).replace(/#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b/gi, (raw) => {
    const color = normalizedHex(raw);
    if (REFERENCE_ELEMENT_PALETTE.has(color)) return raw;
    changed = true;
    return nearestReferenceColor(color);
  });
  return {
    elements: changed ? JSON.parse(serialized) as PPTElement[] : [...elements],
    changed,
  };
}

function paletteDeviations(content: GeneratedSlideContent): number {
  const colors = new Set(content.elements.flatMap(elementColors));
  const nonReferenceColors = [...colors]
    .filter((color) => !REFERENCE_ELEMENT_PALETTE.has(color)).length;
  const background = content.background;
  const incompatibleBackground = background
    && (background.type !== 'solid'
      || !background.color
      || !REFERENCE_BACKGROUNDS.has(normalizedHex(background.color)))
    ? 1
    : 0;
  return nonReferenceColors + incompatibleBackground;
}

function titleElement(outline: SceneOutline, elements: readonly PPTElement[]): PPTElement | undefined {
  const title = outline.title.replace(/\s+/g, '').toLocaleLowerCase();
  const textual = elements.filter((element) => elementVisibleText(element).trim());
  return textual.find((element) =>
    elementVisibleText(element).replace(/\s+/g, '').toLocaleLowerCase().includes(title),
  ) ?? textual.sort((a, b) => a.top - b.top || a.left - b.left)[0];
}

function titleUsesDeepBlue(outline: SceneOutline, elements: readonly PPTElement[]): boolean {
  const title = titleElement(outline, elements);
  return Boolean(title && elementColors(title).some((color) => DEEP_BLUE_TITLE_COLORS.has(color)));
}

/**
 * Deterministic visual-only closure after an audit has found a concrete
 * reference-palette violation. It never enters the official first-draft
 * prompt and never changes text, geometry, media, or semantic structures.
 * This prevents model variance from leaving one page in a different deck
 * style after the sole evidence-triggered rewrite.
 */
export function normalizeAuditedReferenceStyle(
  outline: SceneOutline,
  content: GeneratedSlideContent,
  density: SlideDensityAudit = auditSlideDensity(outline, content),
): GeneratedSlideContent | null {
  let changed = false;
  const palette = density.paletteDeviationCount > 0
    ? normalizeElementPalette(content.elements)
    : { elements: [...content.elements], changed: false };
  changed ||= palette.changed;
  let elements = palette.elements;

  if (!density.hasDeepBlueTitle) {
    const title = titleElement(outline, elements);
    if (title) {
      elements = elements.map((element) => {
        if (element.id !== title.id) return element;
        if (element.type === 'text') {
          changed = true;
          return {
            ...element,
            defaultColor: '#1E3A8A',
            content: element.content.replace(
              /color\s*:\s*#[0-9a-f]{3,8}\b/gi,
              'color:#1E3A8A',
            ),
          };
        }
        if (element.type === 'shape' && element.text) {
          changed = true;
          return {
            ...element,
            text: {
              ...element.text,
              defaultColor: '#1E3A8A',
              content: element.text.content.replace(
                /color\s*:\s*#[0-9a-f]{3,8}\b/gi,
                'color:#1E3A8A',
              ),
            },
          };
        }
        return element;
      });
    }
  }

  let background = content.background;
  if (
    background
    && (background.type !== 'solid'
      || !background.color
      || !REFERENCE_BACKGROUNDS.has(normalizedHex(background.color)))
  ) {
    background = { type: 'solid', color: '#FFFFFF' };
    changed = true;
  }

  return changed ? { ...content, elements, background } : null;
}

function hasIndependentSubtitle(outline: SceneOutline, elements: readonly PPTElement[]): boolean {
  const title = titleElement(outline, elements);
  if (!title) return false;
  const titleBottom = title.top + ('height' in title && typeof title.height === 'number' ? title.height : 0);
  const titleWidth = 'width' in title && typeof title.width === 'number' ? title.width : 0;
  return elements.some((element) => {
    if (element === title || !elementVisibleText(element).trim()) return false;
    const width = 'width' in element && typeof element.width === 'number' ? element.width : 0;
    return element.top >= Math.max(95, titleBottom - 8)
      && element.top <= 165
      && width >= Math.max(300, titleWidth * 0.45);
  });
}

function comparisonLabels(outline: SceneOutline): string[] {
  return outline.keyPoints.flatMap((keyPoint) => {
    if (/^\s*\[(?:table|chart)\]/iu.test(keyPoint)) return [];
    const label = keyPoint.split(/[：:]/u, 1)[0]?.trim().replace(/^[•·\-\d.、\s]+/u, '') ?? '';
    return label.length >= 2 && label.length <= 18 ? [label] : [];
  }).slice(0, 2);
}

function comparisonLabelAnchor(label: string): string {
  const normalized = label.replace(/\s+/g, '').toLocaleLowerCase();
  const latin = normalized.match(/[a-z][a-z0-9_-]{1,}/u)?.[0];
  if (latin) return latin;
  return normalized.replace(/(?:核心特征|实施路径|教学路径|学习路径|认知特点|阶段|教学|模式|特征|路径)$/u, '');
}

function missingComparisonLabels(outline: SceneOutline, elements: readonly PPTElement[]): string[] {
  if (requiredSemanticKind(outline) !== 'comparison') return [];
  const labels = comparisonLabels(outline);
  if (labels.length < 2) return [];
  const tableText = elements
    .filter((element) => element.type === 'table')
    .flatMap((element) => element.type === 'table' ? element.data.flat().map((cell) => cell.text) : [])
    .join('')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
  if (!tableText) return [];
  return labels.filter((label) => {
    const anchor = comparisonLabelAnchor(label);
    return anchor.length < 2 || !tableText.includes(anchor);
  });
}


function requiredSemanticKind(outline: SceneOutline): string | undefined {
  const text = `${outline.title}\n${outline.description}\n${outline.keyPoints.join('\n')}`.toLocaleLowerCase();
  if (/\[table\]|比较|对比|异同|区别|矩阵|表格|compare|versus|\bvs\b/.test(text)) return 'comparison';
  // A classic outline sometimes marks a flow illustration as `[Chart]`.
  // Explicit process language is the stronger semantic signal: connectors are
  // correct for a workflow even when the surrounding source also mentions
  // learner data. Numeric/trend charts remain classified as data below.
  if (/流程|步骤|阶段|路径|过程|先.+再|flow|process|step/.test(text)) return 'process';
  if (/\[chart\]|数据|趋势|比例|统计|图表|曲线|data|trend|percent/.test(text)) return 'data';
  if (/层级|映射|关系|体系|框架|结构|hierarch|mapping|relationship/.test(text)) return 'relationship';
  return undefined;
}

function semanticStructures(elements: readonly PPTElement[]): string[] {
  const structures = new Set<string>();
  if (elements.some((element) => element.type === 'table')) structures.add('table');
  if (elements.some((element) => element.type === 'chart')) structures.add('chart');
  if (elements.filter((element) => element.type === 'line' && element.top >= 130).length >= 1) {
    structures.add('connector');
  }
  const textElements = elements.filter((element): element is Extract<PPTElement, { type: 'text' }> =>
    element.type === 'text' && element.top >= 130 && Boolean(elementVisibleText(element).trim()),
  );
  // OpenMAIC commonly emits an editable background shape followed by a
  // separate editable text element (rather than embedding shape.text). Treat
  // that pair as one semantic group when the text sits inside the container;
  // otherwise genuine two-panel comparisons in the supplied export are
  // incorrectly reported as unstructured cards.
  const semanticShapes = elements.filter((element) => {
    if (element.type !== 'shape' || element.top < 130 || element.height < 36 || element.width < 100) {
      return false;
    }
    if (elementVisibleText(element).trim()) return true;
    const right = element.left + element.width;
    const bottom = element.top + element.height;
    return textElements.some((text) => {
      const centerX = text.left + text.width / 2;
      const centerY = text.top + text.height / 2;
      return centerX >= element.left && centerX <= right
        && centerY >= element.top && centerY <= bottom;
    });
  });
  const shapeRows = new Set(semanticShapes.map((element) => Math.round(element.top / 60)));
  const shapeColumns = new Set(semanticShapes.map((element) => Math.round(element.left / 80)));
  if (semanticShapes.length >= 2 && (shapeRows.size >= 2 || shapeColumns.size >= 2)) {
    structures.add('grouped-shapes');
  }
  return [...structures];
}

function semanticElementCount(elements: readonly PPTElement[]): number {
  const structures = semanticStructures(elements);
  return elements.filter((element) =>
    element.type === 'table'
    || element.type === 'chart'
    || (element.type === 'line' && element.top >= 130)
    || (structures.includes('grouped-shapes')
      && element.type === 'shape'
      && element.top >= 130
      && element.height >= 36
      && element.width >= 100),
  ).length;
}

function satisfiesSemanticKind(kind: string | undefined, structures: readonly string[]): boolean {
  if (!kind) return true;
  if (kind === 'data') return structures.some((value) => value === 'chart' || value === 'table');
  if (kind === 'comparison') {
    return structures.some((value) => value === 'table' || value === 'connector' || value === 'grouped-shapes');
  }
  return structures.some((value) => value === 'connector' || value === 'grouped-shapes' || value === 'table');
}

type Interval = { start: number; end: number };

function mergedIntervalLength(intervals: readonly Interval[]): number {
  const sorted = intervals.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0]?.start ?? 0;
  let end = sorted[0]?.end ?? 0;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + Math.max(0, end - start);
}

function maxIntervalGap(intervals: readonly Interval[], start: number, end: number): number {
  const sorted = intervals
    .map((item) => ({ start: Math.max(start, item.start), end: Math.min(end, item.end) }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  let maxGap = 0;
  for (const interval of sorted) {
    maxGap = Math.max(maxGap, interval.start - cursor);
    cursor = Math.max(cursor, interval.end);
  }
  return Math.max(maxGap, end - cursor);
}

function contentAreaMetrics(elements: readonly PPTElement[]): {
  utilization: number;
  maxBlankBand: number;
} {
  const body = elements.filter((element) => {
    return element.type !== 'line' && element.top >= 110;
  });
  const horizontal = body.map((element) => ({
    start: Math.max(50, element.left),
    end: Math.min(950, element.left + ('width' in element && typeof element.width === 'number' ? element.width : 0)),
  }));
  const vertical = body.map((element) => ({
    start: Math.max(145, element.top),
    end: Math.min(530, element.top + ('height' in element && typeof element.height === 'number' ? element.height : 0)),
  }));
  const horizontalCoverage = mergedIntervalLength(horizontal) / 900;
  const verticalCoverage = mergedIntervalLength(vertical) / 385;
  return {
    utilization: Math.max(0, Math.min(1, (horizontalCoverage + verticalCoverage) / 2)),
    maxBlankBand: Math.round(maxIntervalGap(vertical, 145, 530)),
  };
}

function instructionalVerticalSpan(elements: readonly PPTElement[]): number {
  const instructional = elements.filter((element) => {
    if (element.type === 'shape') return Boolean(element.text?.content);
    return element.type !== 'line';
  });
  if (instructional.length === 0) return 0;
  const top = Math.min(...instructional.map((element) => element.top));
  const bottom = Math.max(...instructional.map((element) =>
    element.top + ('height' in element && typeof element.height === 'number' ? element.height : 0),
  ));
  return Math.max(0, Math.round(bottom - top));
}

/** Static evidence for pages that technically fit but visibly waste most of
 * the canvas or omit the confirmed propositions. This is intentionally a
 * conservative trigger; it never asks for filler. */
export function auditSlideDensity(
  outline: SceneOutline,
  content: GeneratedSlideContent,
): SlideDensityAudit {
  if (outline.generationPurpose !== 'knowledge-teaching') {
    const area = contentAreaMetrics(content.elements);
    const deepBlueTitle = titleUsesDeepBlue(outline, content.elements);
    const paletteDeviationCount = paletteDeviations(content);
    const issues = [
      ...(!deepBlueTitle
        ? ['主标题未使用 OpenMAIC 参考页的深蓝视觉角色（#1E3A8A/#1E40AF）']
        : []),
      ...(paletteDeviationCount > 0
        ? [`页面存在 ${paletteDeviationCount} 种非 OpenMAIC 参考元素色或非参考背景，导致跨页视觉体系漂移`]
        : []),
    ];
    return {
      issues,
      visibleTextCharacters: visibleTextCharacters(content.elements),
      verticalSpan: instructionalVerticalSpan(content.elements),
      underrepresentedKeyPoints: [],
      contentAreaUtilization: area.utilization,
      maxBlankBand: area.maxBlankBand,
      hasDeepBlueTitle: deepBlueTitle,
      hasSubtitle: hasIndependentSubtitle(outline, content.elements),
      semanticStructureRequired: false,
      semanticStructures: semanticStructures(content.elements),
      semanticStructureSatisfied: true,
      paletteDeviationCount,
      elementCount: content.elements.length,
      semanticElementCount: semanticElementCount(content.elements),
    };
  }
  const visibleCharacters = visibleTextCharacters(content.elements);
  const verticalSpan = instructionalVerticalSpan(content.elements);
  const requiredVisibleStatements = slideRequiredVisibleStatements(outline);
  const knowledgeCoverage = slideKnowledgeCoverage(requiredVisibleStatements, content.elements);
  const underrepresentedKeyPoints = requiredVisibleStatements
    .map((keyPoint) => ({ keyPoint, coverage: keyPointCoverage(keyPoint, content.elements) }))
    .filter((item) => item.coverage < 0.3)
    .sort((a, b) => a.coverage - b.coverage);
  const area = contentAreaMetrics(content.elements);
  const deepBlueTitle = titleUsesDeepBlue(outline, content.elements);
  const subtitle = hasIndependentSubtitle(outline, content.elements);
  const requiredStructure = requiredSemanticKind(outline);
  const structures = semanticStructures(content.elements);
  const structureSatisfied = satisfiesSemanticKind(requiredStructure, structures);
  const hasSemanticEvidence = content.elements.some((element) =>
    ['image', 'video', 'chart', 'latex', 'code'].includes(element.type),
  ) || structures.includes('connector');
  const paletteDeviationCount = paletteDeviations(content);
  const absentComparisonLabels = missingComparisonLabels(outline, content.elements);
  const hasMedia = content.elements.some((element) => element.type === 'image' || element.type === 'video');
  const instructionalCount = content.elements.filter((element) =>
    element.type !== 'line' && (element.type !== 'shape' || Boolean(element.text?.content)),
  ).length;
  const issues: string[] = [];
  if (requiredVisibleStatements.length > 0 && underrepresentedKeyPoints.length > 0) {
    issues.push(`关键教学点可见覆盖率仅 ${(knowledgeCoverage * 100).toFixed(1)}%，存在 ${underrepresentedKeyPoints.length} 条未完整可见的已确认要点`);
  }
  if (!hasSemanticEvidence && visibleCharacters < 150) {
    issues.push(`普通讲授页可见教学文字仅 ${visibleCharacters} 个有效字符，低于 150 个字符的信息密度基线`);
  }
  if (!deepBlueTitle) {
    issues.push('主标题未使用 OpenMAIC 参考页的深蓝视觉角色（#1E3A8A/#1E40AF）');
  }
  if (!subtitle) {
    issues.push('普通讲授页缺少独立副标题，标题与正文未形成清晰的两级页首层级');
  }
  if (requiredStructure && !structureSatisfied) {
    issues.push(`页面内容需要${requiredStructure}语义结构，但当前未使用表格、图表、连线或分组关系表达`);
  }
  if (absentComparisonLabels.length > 0) {
    issues.push(`比较表未呈现已确认的比较对象：${absentComparisonLabels.join('、')}；不得用大纲外对象替换表头或比较列`);
  }
  if (paletteDeviationCount > 0) {
    issues.push(`页面存在 ${paletteDeviationCount} 种非 OpenMAIC 参考元素色或非参考背景，导致跨页视觉体系漂移`);
  }
  // Utilization is a continuous comparison signal, not a pass/fail target.
  // Intentional whitespace alone must not trigger another model request.
  if (area.maxBlankBand > 125) {
    issues.push(`正文区域存在 ${area.maxBlankBand}px 的连续空白带，信息分布明显失衡`);
  }
  if (!hasMedia && instructionalCount <= 3 && verticalSpan < 300) {
    issues.push(`有效内容纵向仅占 ${verticalSpan}px，页面下半部存在大面积无教学作用的空白`);
  }
  return {
    issues,
    visibleTextCharacters: visibleCharacters,
    verticalSpan,
    underrepresentedKeyPoints,
    contentAreaUtilization: area.utilization,
    maxBlankBand: area.maxBlankBand,
    hasDeepBlueTitle: deepBlueTitle,
    hasSubtitle: subtitle,
    semanticStructureRequired: Boolean(requiredStructure),
    semanticStructures: structures,
    semanticStructureSatisfied: structureSatisfied,
    paletteDeviationCount,
    elementCount: content.elements.length,
    semanticElementCount: semanticElementCount(content.elements),
  };
}

export function buildLayoutRepairDirective(
  audit: SlideLayoutAudit,
  density?: SlideDensityAudit,
): string {
  const densityIssues = density?.issues ?? [];
  const wholeBodyRepair = densityIssues.some((issue) =>
    issue.includes('信息密度')
    || issue.includes('可见覆盖率')
    || issue.includes('网格利用率')
    || issue.includes('连续空白带')
    || issue.includes('缺少独立副标题')
    || issue.includes('语义结构'),
  );
  const hasBlockCollision = audit.issues.some((issue) =>
    issue.includes('文字侵入相邻内容区域') || issue.includes('文字可能被图形或图片遮挡'),
  );
  return [
    audit.issues.length
      ? '只修复下面由实际浏览器渲染确认的排版问题。保留原有事实、教学要点、媒体和未被点名的对象；不得增加或删除知识内容。'
      : '浏览器未发现溢出，但静态内容测量确认页面过疏。不得编造新事实；只把现有 description、keyPoints 与媒体所承载的知识组织得更完整。',
    ...audit.issues.map((issue, index) => `排版 ${index + 1}. ${issue}`),
    ...densityIssues.map((issue, index) => `密度 ${index + 1}. ${issue}`),
    ...(wholeBodyRepair ? [
      '这些证据涉及整页正文，明确允许在这一次修复中重建正文布局：可以替换、拆分或合并现有 text/shape/table/chart/line 元素并重新排版，不受“保留未点名对象”的限制。必须保留全部既有事实、结论与媒体引用；主标题保持原意，不得增加外部事实。不要只换颜色或微调坐标后原样返回。',
      '优先把 description 中已有的具体解释、例子和条件压缩为可扫读的标签、短句与表格单元格；keyPoints 中的每条命题都要在画布上有对应表达。',
    ] : []),
    ...(densityIssues.length && density?.underrepresentedKeyPoints.length ? [
      '以下已确认要点在可见页面文案中表达不足。每条都必须把核心概念、对象、关系和必要条件呈现在页面上；可以压缩和改写长句，不要求逐字复制，也不要只放进讲稿：',
      ...density.underrepresentedKeyPoints.map((item, index) =>
        `${index + 1}. ${item.keyPoint}（当前可见词语覆盖 ${(item.coverage * 100).toFixed(1)}%）`,
      ),
      '返回前逐项核对上述要点是否都能被学生直接看到。用两栏、2×2 分组、原生表格或带连线的流程分散承载，避免挤成一个长段落；不得删除现有正确内容。',
    ] : []),
    ...(density && density.visibleTextCharacters < 150 ? [
      `当前普通讲授页只有 ${density.visibleTextCharacters} 个有效可见字符。最终页面至少呈现 150 个有效中英文字符：逐条展开现有 description/keyPoints，每条用标题或关系标签加一至两句可扫读说明；只能重组和显化已有事实，不得补充外部常识或新事实。`,
    ] : []),
    ...(hasBlockCollision ? [
      '对文字与图形/表格/媒体相交的问题：若图形是文字的背景容器，把整个文字框置于图形边界内并保留至少 20px 内边距，同时让图形位于元素数组前面；若不是容器关系，则把两者完全分离并保留至少 12px 可见间距。不得用删掉知识点或把正文字号缩到 16px 以下来规避检测。',
    ] : []),
    ...(density && !density.hasDeepBlueTitle ? [
      '把现有主标题设置为深蓝视觉角色 #1E3A8A 或 #1E40AF；正文保持 slate 灰阶。不要把旧版 #5B9BD5/#4472C4 用作主视觉色。',
    ] : []),
    ...(density && !density.hasSubtitle ? [
      '从现有 description 或 keyPoints 中提炼一行独立副标题，放在主标题与正文之间；副标题不得引入新事实。',
    ] : []),
    ...(density?.semanticStructureRequired && !density.semanticStructureSatisfied ? [
      '根据现有关系重组为原生表格、图表、连线或分组结构；不要继续使用彼此无关系的通用卡片堆叠。',
      ...(density.issues.some((issue) => issue.includes('需要comparison语义结构'))
        ? ['比较内容优先使用原生 table，并设置明确的比较对象与维度表头。']
        : []),
      ...(density.issues.some((issue) => issue.includes('需要data语义结构'))
        ? ['含比例、权重或数据的内容必须使用原生 table 或 chart，不得仅写成段落。']
        : []),
      ...(density.issues.some((issue) => issue.includes('需要process语义结构'))
        ? ['流程内容必须使用按顺序排列的节点与带箭头 line 连接线，清楚表现先后关系。']
        : []),
      ...(density.issues.some((issue) => issue.includes('需要relationship语义结构'))
        ? ['映射或层级内容必须使用分组节点与 line 连接线或原生 table，清楚表现对应关系。']
        : []),
    ] : []),
    ...(density && density.maxBlankBand > 125 ? [
      `重组现有内容以利用正文区域，消除 ${density.maxBlankBand}px 连续空白带；可以拆分现有要点、增加关系标签或结论带，但不得增加新事实。`,
    ] : []),
    '返回完整页面 JSON。确保所有对象位于 1000 × 562.5 画布内，正文不小于 16px；仅不超过两行的简短图注可使用 14–16px。',
  ].join('\n');
}

/** Comparable score for choosing between the official first draft and the one
 * allowed repair. It rewards measured density and structure continuously so a
 * materially fuller page is not discarded merely because two issue labels
 * happen to collapse into another two labels. */
export function slideCompositeQualityScore(
  audit: SlideLayoutAudit,
  density: SlideDensityAudit,
  knowledgeCoverage: number,
): number {
  if (audit.status !== 'checked') return Number.NEGATIVE_INFINITY;
  const textScore = Math.min(1, density.visibleTextCharacters / 150) * 12;
  const areaScore = Math.min(1, density.contentAreaUtilization / 0.9) * 12;
  const hierarchyScore = (density.hasDeepBlueTitle ? 5 : 0) + (density.hasSubtitle ? 5 : 0);
  const semanticScore = density.semanticStructureRequired
    ? density.semanticStructureSatisfied ? 8 : 0
    : 8;
  return Number((
    knowledgeCoverage * 30
    + textScore
    + areaScore
    + hierarchyScore
    + semanticScore
    - audit.issues.length * 12
    - density.issues.length * 3
    - density.paletteDeviationCount * 2
  ).toFixed(3));
}

function rectRight(rect: VisibleRect): number {
  return rect.left + rect.width;
}

function rectBottom(rect: VisibleRect): number {
  return rect.top + rect.height;
}

function rectArea(rect: VisibleRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: VisibleRect, b: VisibleRect): number {
  return Math.max(0, Math.min(rectRight(a), rectRight(b)) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.top, b.top));
}

function unionRects(rects: readonly VisibleRect[]): VisibleRect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map(rectRight));
  const bottom = Math.max(...rects.map(rectBottom));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Repair only geometry that the renderer measured directly. No content,
 * styling, font size, element identity, or ordering is changed. This handles
 * the common model error where a card label is almost — but not fully — inside
 * its background shape, and text boxes whose rendered lines need a taller box.
 */
export function repairMeasuredSlideGeometry(
  content: GeneratedSlideContent,
  audit: SlideLayoutAudit,
): GeneratedSlideContent | null {
  if (audit.status !== 'checked' || !audit.findings?.length || !audit.measurements?.length) {
    return null;
  }
  if (audit.findings.some((finding) => finding.id.includes(':small-type:'))) return null;

  const elements = content.elements.map((element) => ({ ...element })) as PPTElement[];
  const byMeasurement = new Map(audit.measurements.map((measurement) => [measurement.id, measurement]));
  let changed = false;

  for (const finding of audit.findings) {
    const elementId = finding.elementId;
    if (!elementId) continue;
    const elementIndex = elements.findIndex((element) => element.id === elementId);
    const element = elements[elementIndex];
    const measured = byMeasurement.get(elementId);
    if (!element || !measured || element.type !== 'text') continue;

    if (finding.id.includes(':box-overflow:')) {
      const glyphs = unionRects(measured.textRects);
      if (!glyphs) continue;
      let width = element.width;
      let height = element.height;
      if (rectRight(glyphs) > rectRight(measured.box) + 6) {
        width = Math.min(994 - element.left, Math.ceil(rectRight(glyphs) - element.left + 12));
      }
      if (rectBottom(glyphs) > rectBottom(measured.box) + 6) {
        height = Math.min(556.5 - element.top, Math.ceil(rectBottom(glyphs) - element.top + 12));
      }
      if (width > element.width || height > element.height) {
        elements[elementIndex] = { ...element, width, height };
        changed = true;
      }
      continue;
    }

    if (!finding.id.includes(':collision-') && !finding.id.includes(':occluded-')) continue;
    const block = audit.measurements.find((candidate) =>
      candidate.id !== elementId
      && (
        finding.id.includes(`:collision-${candidate.id}:`)
        || finding.id.includes(`:occluded-${candidate.id}:`)
      ),
    );
    if (!block || block.type !== 'shape' || block.text.trim()) continue;
    const blockIndex = elements.findIndex((candidate) => candidate.id === block.id);
    if (blockIndex < 0 || blockIndex >= elementIndex) continue;
    const centerInside = measured.box.left + measured.box.width / 2 >= block.box.left
      && measured.box.left + measured.box.width / 2 <= rectRight(block.box)
      && measured.box.top + measured.box.height / 2 >= block.box.top
      && measured.box.top + measured.box.height / 2 <= rectBottom(block.box);
    const mostlyOverShape = intersectionArea(measured.box, block.box)
      >= rectArea(measured.box) * 0.45;
    const innerWidth = block.box.width - 40;
    const innerHeight = block.box.height - 40;
    if ((!centerInside && !mostlyOverShape) || innerWidth < 80 || innerHeight < element.height) {
      continue;
    }
    elements[elementIndex] = {
      ...element,
      left: Math.round(block.box.left + 20),
      top: Math.round(block.box.top + (block.box.height - element.height) / 2),
      width: Math.round(innerWidth),
    };
    changed = true;
  }

  return changed ? { ...content, elements } : null;
}

/** Evidence-gated, single-attempt repair. Production uses the pinned
 * OpenMAIC editor path with the same teacher-selected model; callers may set
 * preserveOpenMaicFirstDraft for byte-level upstream comparison tooling. */
export async function auditAndRepairSlideOnce(input: {
  outline: SceneOutline;
  content: GeneratedSlideContent;
  audit?: typeof auditSlideLayout;
  regenerate: (directive: string, baseline: GeneratedSlideContent) => Promise<GeneratedSlideContent | null>;
  onRepair?: () => Promise<void> | void;
  preserveOpenMaicFirstDraft?: boolean;
}): Promise<SlideLayoutRepairResult> {
  const audit = input.audit ?? auditSlideLayout;
  const initialAudit = await audit(input.content, input.outline.id);
  const requiredVisibleStatements = slideRequiredVisibleStatements(input.outline);
  const initialCoverage = slideKnowledgeCoverage(requiredVisibleStatements, input.content.elements);
  const initialDensity = auditSlideDensity(input.outline, input.content);
  const initialQualityScore = slideCompositeQualityScore(
    initialAudit,
    initialDensity,
    initialCoverage,
  );
  if (
    input.preserveOpenMaicFirstDraft
    || initialAudit.status !== 'checked'
    || (initialAudit.issues.length === 0 && initialDensity.issues.length === 0)
  ) {
    return {
      content: input.content,
      initialAudit,
      finalAudit: initialAudit,
      repairAttempted: false,
      adopted: 'first-draft',
      initialKnowledgeCoverage: initialCoverage,
      finalKnowledgeCoverage: initialCoverage,
      initialDensityIssues: initialDensity.issues,
      finalDensityIssues: initialDensity.issues,
      initialVisibleTextCharacters: initialDensity.visibleTextCharacters,
      finalVisibleTextCharacters: initialDensity.visibleTextCharacters,
      initialVerticalSpan: initialDensity.verticalSpan,
      finalVerticalSpan: initialDensity.verticalSpan,
      initialContentAreaUtilization: initialDensity.contentAreaUtilization,
      finalContentAreaUtilization: initialDensity.contentAreaUtilization,
      initialMaxBlankBand: initialDensity.maxBlankBand,
      finalMaxBlankBand: initialDensity.maxBlankBand,
      initialHasDeepBlueTitle: initialDensity.hasDeepBlueTitle,
      finalHasDeepBlueTitle: initialDensity.hasDeepBlueTitle,
      initialHasSubtitle: initialDensity.hasSubtitle,
      finalHasSubtitle: initialDensity.hasSubtitle,
      semanticStructureRequired: initialDensity.semanticStructureRequired,
      initialSemanticStructures: initialDensity.semanticStructures,
      finalSemanticStructures: initialDensity.semanticStructures,
      initialSemanticStructureSatisfied: initialDensity.semanticStructureSatisfied,
      finalSemanticStructureSatisfied: initialDensity.semanticStructureSatisfied,
      initialPaletteDeviationCount: initialDensity.paletteDeviationCount,
      finalPaletteDeviationCount: initialDensity.paletteDeviationCount,
      initialElementCount: initialDensity.elementCount,
      finalElementCount: initialDensity.elementCount,
      initialSemanticElementCount: initialDensity.semanticElementCount,
      finalSemanticElementCount: initialDensity.semanticElementCount,
      initialQualityScore,
      finalQualityScore: initialQualityScore,
    };
  }

  await input.onRepair?.();
  // One repair opportunity per page. Browser-measured geometry is safe to use
  // as the editing baseline because it changes no facts or style. When density
  // also needs a model edit, there is still exactly one model rewrite; a final
  // deterministic geometry normalization is part of validating that candidate,
  // never another generation loop.
  const styledBaseline = normalizeAuditedReferenceStyle(
    input.outline,
    input.content,
    initialDensity,
  );
  const evidenceBaseline = styledBaseline ?? input.content;
  const measuredBaseline = repairMeasuredSlideGeometry(evidenceBaseline, initialAudit);
  const repairBaseline = measuredBaseline ?? styledBaseline;
  // Re-audit deterministic style/geometry repair before asking the model to
  // rewrite a whole page. The old branch used issues from the original draft,
  // so an already-corrected page still paid for an unnecessary generation.
  const deterministicAudit = repairBaseline
    ? await audit(repairBaseline, input.outline.id)
    : undefined;
  const deterministicDensity = repairBaseline
    ? auditSlideDensity(input.outline, repairBaseline)
    : undefined;
  const deterministicCoverage = repairBaseline
    ? slideKnowledgeCoverage(requiredVisibleStatements, repairBaseline.elements)
    : undefined;
  const deterministicPasses = Boolean(
    repairBaseline
    && deterministicAudit?.status === 'checked'
    && deterministicAudit.issues.length === 0
    && deterministicDensity?.issues.length === 0
    && (deterministicCoverage ?? 0) + 0.02 >= initialCoverage
  );
  let candidate = deterministicPasses
    ? repairBaseline
    : await input.regenerate(
        buildLayoutRepairDirective(
          deterministicAudit?.status === 'checked' ? deterministicAudit : initialAudit,
          deterministicDensity ?? initialDensity,
        ),
        repairBaseline ?? input.content,
      );
  // If the one allowed model rewrite is unavailable or invalid, retain a
  // browser-measured geometry improvement instead of falling all the way back
  // to an avoidably overflowing first draft.
  candidate ??= repairBaseline;
  if (!candidate) {
    return {
      content: input.content,
      initialAudit,
      finalAudit: initialAudit,
      repairAttempted: true,
      adopted: 'first-draft',
      initialKnowledgeCoverage: initialCoverage,
      finalKnowledgeCoverage: initialCoverage,
      initialDensityIssues: initialDensity.issues,
      finalDensityIssues: initialDensity.issues,
      initialVisibleTextCharacters: initialDensity.visibleTextCharacters,
      finalVisibleTextCharacters: initialDensity.visibleTextCharacters,
      initialVerticalSpan: initialDensity.verticalSpan,
      finalVerticalSpan: initialDensity.verticalSpan,
      initialContentAreaUtilization: initialDensity.contentAreaUtilization,
      finalContentAreaUtilization: initialDensity.contentAreaUtilization,
      initialMaxBlankBand: initialDensity.maxBlankBand,
      finalMaxBlankBand: initialDensity.maxBlankBand,
      initialHasDeepBlueTitle: initialDensity.hasDeepBlueTitle,
      finalHasDeepBlueTitle: initialDensity.hasDeepBlueTitle,
      initialHasSubtitle: initialDensity.hasSubtitle,
      finalHasSubtitle: initialDensity.hasSubtitle,
      semanticStructureRequired: initialDensity.semanticStructureRequired,
      initialSemanticStructures: initialDensity.semanticStructures,
      finalSemanticStructures: initialDensity.semanticStructures,
      initialSemanticStructureSatisfied: initialDensity.semanticStructureSatisfied,
      finalSemanticStructureSatisfied: initialDensity.semanticStructureSatisfied,
      initialPaletteDeviationCount: initialDensity.paletteDeviationCount,
      finalPaletteDeviationCount: initialDensity.paletteDeviationCount,
      initialElementCount: initialDensity.elementCount,
      finalElementCount: initialDensity.elementCount,
      initialSemanticElementCount: initialDensity.semanticElementCount,
      finalSemanticElementCount: initialDensity.semanticElementCount,
      initialQualityScore,
      finalQualityScore: initialQualityScore,
    };
  }
  candidate = normalizeAuditedReferenceStyle(
    input.outline,
    candidate,
    auditSlideDensity(input.outline, candidate),
  ) ?? candidate;
  let candidateAudit = candidate === repairBaseline && deterministicAudit
    ? deterministicAudit
    : await audit(candidate, input.outline.id);
  const normalizedGeometry = repairMeasuredSlideGeometry(candidate, candidateAudit);
  if (normalizedGeometry) {
    candidate = normalizedGeometry;
    candidateAudit = await audit(candidate, input.outline.id);
  }
  let candidateCoverage = candidate === repairBaseline && deterministicCoverage !== undefined
    ? deterministicCoverage
    : slideKnowledgeCoverage(requiredVisibleStatements, candidate.elements);
  let candidateDensity = candidate === repairBaseline && deterministicDensity
    ? deterministicDensity
    : auditSlideDensity(input.outline, candidate);
  let candidateQualityScore = slideCompositeQualityScore(
    candidateAudit,
    candidateDensity,
    candidateCoverage,
  );
  const improvesMeasuredQuality = candidateAudit.status === 'checked'
    && candidateQualityScore > initialQualityScore + 0.5
    && candidateAudit.issues.length <= initialAudit.issues.length;
  const preservesKnowledge = candidateCoverage + 0.02 >= initialCoverage;
  let adoptRepair = improvesMeasuredQuality && preservesKnowledge;
  if (!adoptRepair && repairBaseline && candidate !== repairBaseline) {
    const measuredAudit = await audit(repairBaseline, input.outline.id);
    const measuredDensity = auditSlideDensity(input.outline, repairBaseline);
    const measuredQualityScore = slideCompositeQualityScore(
      measuredAudit,
      measuredDensity,
      initialCoverage,
    );
    const measuredImproves = measuredAudit.status === 'checked'
      && measuredQualityScore > initialQualityScore + 0.5
      && measuredAudit.issues.length <= initialAudit.issues.length;
    if (measuredImproves) {
      candidate = repairBaseline;
      candidateAudit = measuredAudit;
      candidateCoverage = initialCoverage;
      candidateDensity = measuredDensity;
      candidateQualityScore = measuredQualityScore;
      adoptRepair = true;
    }
  }
  return {
    content: adoptRepair ? candidate : input.content,
    initialAudit,
    finalAudit: adoptRepair ? candidateAudit : initialAudit,
    repairAttempted: true,
    adopted: adoptRepair ? 'repair' : 'first-draft',
    initialKnowledgeCoverage: initialCoverage,
    finalKnowledgeCoverage: adoptRepair ? candidateCoverage : initialCoverage,
    initialDensityIssues: initialDensity.issues,
    finalDensityIssues: adoptRepair ? candidateDensity.issues : initialDensity.issues,
    initialVisibleTextCharacters: initialDensity.visibleTextCharacters,
    finalVisibleTextCharacters: adoptRepair
      ? candidateDensity.visibleTextCharacters
      : initialDensity.visibleTextCharacters,
    initialVerticalSpan: initialDensity.verticalSpan,
    finalVerticalSpan: adoptRepair ? candidateDensity.verticalSpan : initialDensity.verticalSpan,
    initialContentAreaUtilization: initialDensity.contentAreaUtilization,
    finalContentAreaUtilization: adoptRepair
      ? candidateDensity.contentAreaUtilization
      : initialDensity.contentAreaUtilization,
    initialMaxBlankBand: initialDensity.maxBlankBand,
    finalMaxBlankBand: adoptRepair ? candidateDensity.maxBlankBand : initialDensity.maxBlankBand,
    initialHasDeepBlueTitle: initialDensity.hasDeepBlueTitle,
    finalHasDeepBlueTitle: adoptRepair ? candidateDensity.hasDeepBlueTitle : initialDensity.hasDeepBlueTitle,
    initialHasSubtitle: initialDensity.hasSubtitle,
    finalHasSubtitle: adoptRepair ? candidateDensity.hasSubtitle : initialDensity.hasSubtitle,
    semanticStructureRequired: initialDensity.semanticStructureRequired,
    initialSemanticStructures: initialDensity.semanticStructures,
    finalSemanticStructures: adoptRepair
      ? candidateDensity.semanticStructures
      : initialDensity.semanticStructures,
    initialSemanticStructureSatisfied: initialDensity.semanticStructureSatisfied,
    finalSemanticStructureSatisfied: adoptRepair
      ? candidateDensity.semanticStructureSatisfied
      : initialDensity.semanticStructureSatisfied,
    initialPaletteDeviationCount: initialDensity.paletteDeviationCount,
    finalPaletteDeviationCount: adoptRepair
      ? candidateDensity.paletteDeviationCount
      : initialDensity.paletteDeviationCount,
    initialElementCount: initialDensity.elementCount,
    finalElementCount: adoptRepair ? candidateDensity.elementCount : initialDensity.elementCount,
    initialSemanticElementCount: initialDensity.semanticElementCount,
    finalSemanticElementCount: adoptRepair
      ? candidateDensity.semanticElementCount
      : initialDensity.semanticElementCount,
    initialQualityScore,
    finalQualityScore: adoptRepair ? candidateQualityScore : initialQualityScore,
  };
}

export async function closeSlideLayoutAuditBrowser(): Promise<void> {
  await queue.catch(() => undefined);
  if (idleTimer) clearTimeout(idleTimer);
  await resetBrowser();
}
