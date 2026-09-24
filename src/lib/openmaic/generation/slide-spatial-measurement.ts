/** Server-only, pre-authoring measurements; never measures generated slides to request repairs. */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { SlideTeachingRegion } from './slide-spatial-types';
import { SLIDE_RENDERER_STYLES } from '../../../../packages/@openmaic/renderer/src/styles';
import type { TextMeasure, TextMeasureInput, TextMeasureResult } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';

export const SPATIAL_FONT = 'Noto Sans SC';
export const SPATIAL_PADDING = 10;
export const SPATIAL_LINE_HEIGHT = 1.5;
export interface SpatialMeasurement { width: number; height: number; representativeCharWidth: number }
export type SpatialMeasurementMode = 'browser-renderer-fonts-v1' | 'conservative-text-estimate-v1';
export type SpatialMeasureFn = ((region: SlideTeachingRegion, width: number, fontSize: number) => Promise<SpatialMeasurement>) & { measurementMode?: SpatialMeasurementMode };
export const SPATIAL_MEASUREMENT_UNAVAILABLE = 'SPATIAL_MEASUREMENT_UNAVAILABLE';
const MAX_BROWSER_ATTEMPTS = 2;
let browser: Browser | undefined;
let page: Page | undefined;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let warnedAboutFallback = false;
const cache = new Map<string, SpatialMeasurement>();
const authoredTextCache = new Map<string, TextMeasureResult>();
const assets = new Map<string, { body: Buffer; contentType: string }>();

export class SpatialMeasurementUnavailableError extends Error {
  readonly code = SPATIAL_MEASUREMENT_UNAVAILABLE;
  readonly isRetryable = true;

  constructor(cause: unknown) {
    super('页面空间前置度量暂时不可用', { cause });
    this.name = 'SpatialMeasurementUnavailableError';
  }
}

export function isSpatialMeasurementUnavailableError(error: unknown): error is SpatialMeasurementUnavailableError {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === SPATIAL_MEASUREMENT_UNAVAILABLE);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assetCss(cssPath: string, prefix: string): Promise<string> {
  const css = await readFile(cssPath, 'utf8');
  const matches = [...css.matchAll(/url\(['"]?(\.?\.?\/[^)'"\s]+)['"]?\)/g)];
  for (const match of matches) {
    const name = `${prefix}/${path.basename(match[1])}`;
    if (!assets.has(name)) assets.set(name, { body: await readFile(path.resolve(path.dirname(cssPath), match[1])), contentType: 'font/woff2' });
  }
  return css.replace(/url\(['"]?(\.?\.?\/[^)'"\s]+)['"]?\)/g, (_match, file: string) => `url('https://spatial.local/${prefix}/${path.basename(file)}')`);
}

async function executableExists(executablePath: string): Promise<boolean> {
  try { await access(executablePath); return true; }
  catch { return false; }
}

async function launchChromium(): Promise<Browser> {
  const configured = process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates: Array<string | undefined> = [configured || undefined, undefined];
  for (const systemPath of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome']) {
    if (await executableExists(systemPath)) candidates.push(systemPath);
  }
  const attempted = new Set<string>();
  let lastError: unknown;
  for (const executablePath of candidates) {
    const key = executablePath ?? 'playwright-default';
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Chromium executable is available');
}

async function getPage(): Promise<Page> {
  if (page && browser?.isConnected()) return page;
  browser = await launchChromium();
  page = await browser.newPage({ viewport: { width: 1000, height: 563 } });
  const [fontCss, katexCss] = await Promise.all([
    Promise.all([400, 700].map((weight) => assetCss(path.join(process.cwd(), `node_modules/@fontsource/noto-sans-sc/${weight}.css`), 'noto'))).then((styles) => styles.join('\n')),
    assetCss(path.join(process.cwd(), 'node_modules/katex/dist/katex.min.css'), 'katex'),
  ]);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const asset = url.hostname === 'spatial.local' ? assets.get(url.pathname.slice(1)) : undefined;
    if (asset) await route.fulfill({ ...asset, headers: { 'access-control-allow-origin': '*' } });
    else await route.abort();
  });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${fontCss}\n${katexCss}\n${SLIDE_RENDERER_STYLES}\nbody{margin:0;background:white}#measure{position:absolute;box-sizing:border-box;padding:10px;font-family:'Noto Sans SC';line-height:1.5;overflow-wrap:break-word;--paragraphSpace:5px}table{width:100%;border-collapse:collapse;table-layout:fixed}td{border:1px solid #888;padding:6px;line-height:1}</style><div id="measure" class="slide-renderer-prose"></div>`);
  return page;
}

async function resetBrowser(): Promise<void> {
  const closing = browser;
  browser = undefined;
  page = undefined;
  await closing?.close().catch(() => {});
}

function serialized<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const run = queue.catch(() => {}).then(async () => {
    if (idleTimer) clearTimeout(idleTimer);
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < MAX_BROWSER_ATTEMPTS; attempt += 1) {
        try { return await work(await getPage()); }
        catch (error) {
          lastError = error;
          await resetBrowser();
        }
      }
      throw new SpatialMeasurementUnavailableError(lastError);
    }
    finally {
      idleTimer = setTimeout(() => {
        const closing = browser;
        browser = undefined;
        page = undefined;
        void closing?.close();
      }, 30_000);
      idleTimer.unref?.();
    }
  });
  queue = run;
  return run;
}

function visibleText(region: SlideTeachingRegion): string {
  if (region.kind !== 'richtext') return region.content;
  return region.content
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function textUnits(text: string): number {
  return [...text].reduce((sum, character) => sum + (/^[\x00-\xff]$/.test(character) ? 0.55 : 1), 0);
}

/** Conservative fallback that keeps course generation available when Chromium is unhealthy. */
export const measureSlideRegionConservatively: SpatialMeasureFn = async (region, width, fontSize) => {
  const innerWidth = Math.max(fontSize, width - 2 * SPATIAL_PADDING);
  const unitsPerLine = Math.max(1, innerWidth / fontSize);
  if (region.kind === 'table') {
    const rows = region.tableCells?.length ? region.tableCells : [[region.content]];
    const lineCount = rows.reduce((total, row) => {
      const columns = Math.max(1, row.length);
      const cellUnitsPerLine = Math.max(1, (innerWidth / columns - 12) / fontSize);
      return total + Math.max(1, ...row.map((cell) => Math.ceil(textUnits(cell) / cellUnitsPerLine)));
    }, 0);
    return { width, height: 2 + lineCount * fontSize + rows.length * 12, representativeCharWidth: fontSize };
  }
  const paragraphs = visibleText(region).split(/\r?\n/);
  const lineCount = paragraphs.reduce((total, paragraph) => total + Math.max(1, Math.ceil(textUnits(paragraph) / unitsPerLine)), 0);
  return {
    width,
    height: 2 * SPATIAL_PADDING + lineCount * fontSize * SPATIAL_LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * 5,
    representativeCharWidth: fontSize,
  };
};
measureSlideRegionConservatively.measurementMode = 'conservative-text-estimate-v1';

/** Same browser fonts and box model for plain text, rich text, formulae and tables. */
export const measureSlideRegion: SpatialMeasureFn = async (region, width, fontSize) => {
  const key = JSON.stringify([region.kind, region.content, region.tableCells, width, fontSize]);
  const cached = cache.get(key);
  if (cached) return cached;
  let formulaHtml = '';
  if (region.kind === 'formula') {
    const katex = await import('katex');
    formulaHtml = katex.default.renderToString(region.content, { displayMode: true, throwOnError: true, trust: false, maxExpand: 1000 });
  }
  let result: SpatialMeasurement;
  try {
    result = await serialized(async (target) => target.evaluate(async ({ region, width, fontSize, formulaHtml }) => {
    const node = document.getElementById('measure')!;
    node.className = 'slide-renderer-prose';
    node.style.cssText = '';
    node.style.width = `${width}px`;
    node.style.fontSize = `${fontSize}px`;
    node.replaceChildren();
    if (region.kind === 'formula') node.innerHTML = formulaHtml;
    else if (region.kind === 'table') {
      const table = document.createElement('table');
      for (const row of region.tableCells ?? [[region.content]]) {
        const tr = table.insertRow();
        for (const text of row) tr.insertCell().textContent = text;
      }
      node.append(table);
    } else if (region.kind === 'richtext') {
      // Keep only renderer-supported text markup; planner HTML cannot load resources or execute code.
      const parsed = new DOMParser().parseFromString(region.content, 'text/html');
      const allowed = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'SPAN']);
      for (const el of [...parsed.body.querySelectorAll('*')].reverse()) {
        if (!allowed.has(el.tagName)) el.replaceWith(document.createTextNode(el.textContent ?? ''));
        else for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      }
      node.innerHTML = parsed.body.innerHTML;
    } else {
      for (const text of region.content.split('\n')) {
        const p = document.createElement('p');
        p.textContent = text || '\u00a0';
        node.append(p);
      }
    }
    await document.fonts.load(`${fontSize}px "Noto Sans SC"`, node.textContent || '教学');
    await document.fonts.ready;
    if (!document.fonts.check(`${fontSize}px "Noto Sans SC"`, node.textContent || '教学')) throw new Error('Slide font did not load');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.font = `${fontSize}px "Noto Sans SC"`;
    const rect = node.getBoundingClientRect();
    return { width: Math.max(rect.width, node.scrollWidth), height: Math.max(rect.height, node.scrollHeight), representativeCharWidth: context.measureText('教').width };
    }, { region, width, fontSize, formulaHtml }));
  } catch (error) {
    if (!isSpatialMeasurementUnavailableError(error)) throw error;
    measureSlideRegion.measurementMode = 'conservative-text-estimate-v1';
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.warn(`[SpatialMeasurement] Browser measurement unavailable after ${MAX_BROWSER_ATTEMPTS} attempts; using conservative estimates: ${errorDetail(error.cause)}`);
    }
    result = await measureSlideRegionConservatively(region, width, fontSize);
  }
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
};
measureSlideRegion.measurementMode = 'browser-renderer-fonts-v1';

/** Measure first-draft editable text with the same font assets and CSS as playback. */
export const measureAuthoredSlideText: TextMeasure = async (input: TextMeasureInput) => {
  const key = JSON.stringify(input);
  const cached = authoredTextCache.get(key);
  if (cached) return cached;
  const measured = await serialized(async (target) => target.evaluate(async (spec) => {
    const node = document.getElementById('measure')!;
    node.className = spec.tableCell ? 'slide-renderer-prose slide-renderer-cell-text' : 'slide-renderer-prose';
    node.style.cssText = '';
    node.style.width = `${spec.width}px`;
    node.style.fontSize = `${spec.fontSize}px`;
    node.style.fontWeight = String(spec.fontWeight);
    node.style.fontFamily = spec.fontFamily;
    node.style.padding = spec.paddingCss ?? `${spec.padding}px`;
    node.style.lineHeight = String(spec.lineHeight);
    node.style.textAlign = spec.align;
    node.style.setProperty('--paragraphSpace', `${spec.paragraphSpace}px`);
    const parsed = new DOMParser().parseFromString(spec.html, 'text/html');
    const allowed = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'SPAN', 'U', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE']);
    const typography = new Set(['font-size', 'font-weight', 'font-family', 'font-style', 'color', 'text-align', 'line-height', 'text-decoration', 'letter-spacing', 'white-space']);
    for (const element of [...parsed.body.querySelectorAll('*')].reverse()) {
      if (!allowed.has(element.tagName)) element.replaceWith(document.createTextNode(element.textContent ?? ''));
      else {
        const style = (element as HTMLElement).style;
        const retained = spec.preserveRichText ? [...typography].filter((property) => Boolean(style.getPropertyValue(property)))
          .map((property) => [property, style.getPropertyValue(property)] as const)
          .filter(([, value]) => !/url\s*\(|expression\s*\(|@import/i.test(value)) : [];
        for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
        for (const [property, value] of retained) style.setProperty(property, value);
      }
    }
    node.innerHTML = parsed.body.innerHTML;
    await Promise.all([400, 700].map((weight) => document.fonts.load(`${weight} ${spec.fontSize}px "Noto Sans SC"`, spec.text || '教学')));
    await document.fonts.ready;
    if (!document.fonts.check(`${spec.fontWeight} ${spec.fontSize}px "Noto Sans SC"`, spec.text || '教学')) throw new Error('Slide authoring font did not load');

    const natural = node.cloneNode(true) as HTMLElement;
    natural.style.width = 'max-content';
    natural.style.whiteSpace = 'nowrap';
    natural.style.position = 'absolute';
    natural.style.left = '-10000px';
    document.body.appendChild(natural);
    const naturalStyle = getComputedStyle(natural);
    const naturalWidth = Math.max(0, natural.getBoundingClientRect().width - parseFloat(naturalStyle.paddingLeft) - parseFloat(naturalStyle.paddingRight));
    natural.remove();

    const rows: Array<{ top: number; bottom: number; text: string }> = [];
    const box = node.getBoundingClientRect();
    let inkBottom = 0;
    let inkRight = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const value = textNode.textContent ?? '';
      for (let index = 0; index < value.length; index += 1) {
        // A preserved newline's Range can span both adjacent line boxes.
        // Only visible glyphs determine row grouping and ink bounds.
        if (value[index] === '\n' || value[index] === '\r') continue;
        const range = document.createRange();
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        inkBottom = Math.max(inkBottom, rect.bottom - box.top);
        inkRight = Math.max(inkRight, rect.right - box.left);
        // Mixed-size spans share a baseline but have different top coordinates.
        // Group overlapping glyph boxes, rather than reporting each font size as a new line.
        const row = rows.find((line) => Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top)
          >= Math.min(line.bottom - line.top, rect.height) * 0.5);
        if (row) {
          row.top = Math.min(row.top, rect.top);
          row.bottom = Math.max(row.bottom, rect.bottom);
          row.text += value[index];
        } else rows.push({ top: rect.top, bottom: rect.bottom, text: value[index] });
      }
    }
    const lines = rows.sort((a, b) => a.top - b.top).map((row) => row.text.trim()).filter(Boolean);
    return { naturalWidth, height: Math.ceil(box.height), lines, inkBottom, inkRight };
  }, input));
  authoredTextCache.set(key, measured);
  return measured;
};

/** Programmatic schematic, not model-generated artwork. */
export async function renderSpatialSketchSvg(svg: string): Promise<string> {
  return serialized(async (target) => {
    await target.evaluate((svg) => {
      document.getElementById('sketch')?.remove();
      const holder = document.createElement('div');
      holder.id = 'sketch';
      holder.style.cssText = 'position:absolute;left:0;top:0;width:1000px;height:563px;background:white;z-index:10';
      holder.innerHTML = svg;
      document.body.append(holder);
    }, svg);
    const png = await target.locator('#sketch').screenshot({ type: 'png' });
    await target.locator('#sketch').evaluate((el) => el.remove());
    return `data:image/png;base64,${png.toString('base64')}`;
  });
}

export async function closeSpatialMeasurementBrowser(): Promise<void> {
  await queue.catch(() => {});
  if (idleTimer) clearTimeout(idleTimer);
  await resetBrowser();
}
