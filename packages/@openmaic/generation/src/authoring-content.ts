/** Already adopted display points. Source passages and narration are separate inputs. */
export interface AuthoringContentItem {
  id: string;
  text: string;
  /** Required by default; optional supporting points may be omitted. */
  required?: boolean;
  /** Only explicit ordered teaching relationships constrain display order. */
  sequence?: { id: string; index: number };
}

export interface AuthoringContentReference {
  contentRef?: string;
  paragraphRefs?: string[];
}

/** A measured plain native-text rectangle; mixed rich typography is measured separately. */
export interface AuthoringTextAllocation {
  contentRef: string;
  fontSize: number;
  width: number;
  height: number;
}

export class AuthoringContentError extends Error {
  readonly code = 'authoring-content';
  constructor(message: string) {
    super(`Authoring content: ${message}`);
    this.name = 'AuthoringContentError';
  }
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateAuthoringContent(items: readonly AuthoringContentItem[]): void {
  if (!Array.isArray(items)) throw new AuthoringContentError('catalog must be an array');
  const ids = new Set<string>();
  const positions = new Set<string>();
  for (const item of items) {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim()
      || typeof item.text !== 'string' || !item.text.trim()) {
      throw new AuthoringContentError('each catalog item needs a nonempty id and text');
    }
    if (ids.has(item.id)) throw new AuthoringContentError(`duplicate catalog id ${item.id}`);
    ids.add(item.id);
    if (item.required !== undefined && typeof item.required !== 'boolean') throw new AuthoringContentError(`invalid required flag for ${item.id}`);
    if (item.sequence !== undefined) {
      const sequence = item.sequence;
      if (!record(sequence) || typeof sequence.id !== 'string' || !sequence.id.trim()
        || typeof sequence.index !== 'number' || !Number.isInteger(sequence.index) || sequence.index < 0) throw new AuthoringContentError(`invalid sequence for ${item.id}`);
      const position = JSON.stringify([sequence.id, sequence.index]);
      if (positions.has(position)) throw new AuthoringContentError(`duplicate sequence position for ${item.id}`);
      positions.add(position);
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Retain the author's existing enclosing typography, without retaining rewritten prose. */
function referenceHtml(texts: string[], existing: unknown, tableCell = false): string {
  const html = texts.map((text) => escapeHtml(text).replace(/\n/g, '<br>')).join('<br><br>');
  const prefix = typeof existing === 'string'
    ? existing.match(/^\s*((?:<(?:p|div|h[1-6]|span|strong|b|em|i|u)\b[^>]*>\s*)+)/i)?.[1] : undefined;
  if (!prefix) return tableCell ? html : `<p style="font-size:24px">${html}</p>`;
  const tags = [...prefix.matchAll(/<(p|div|h[1-6]|span|strong|b|em|i|u)\b[^>]*>/gi)].map((match) => match[1]);
  return `${prefix}${html}${tags.reverse().map((tag) => `</${tag}>`).join('')}`;
}

/** Bind only real display slots, before any font measurement. Never append omitted content. */
export function resolveAuthoringContent<T>(authored: T, items: readonly AuthoringContentItem[]): T {
  validateAuthoringContent(items);
  const catalog = new Map(items.map((item) => [item.id, item.text]));
  const clone = (value: unknown): unknown => Array.isArray(value) ? value.map(clone)
    : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
  const data = clone(authored);
  const texts = (slot: RecordValue): string[] | undefined => {
    const hasContent = Object.hasOwn(slot, 'contentRef');
    const hasParagraphs = Object.hasOwn(slot, 'paragraphRefs');
    if (!hasContent && !hasParagraphs) return undefined;
    if (hasContent && hasParagraphs) throw new AuthoringContentError('use contentRef or paragraphRefs, not both');
    const refs = hasContent ? [slot.contentRef] : slot.paragraphRefs;
    if (!Array.isArray(refs) || !refs.length || refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
      throw new AuthoringContentError('references must contain nonempty catalog ids');
    }
    const result = refs.map((ref) => {
      const text = catalog.get(ref as string);
      if (text === undefined) throw new AuthoringContentError(`unknown content reference ${String(ref)}`);
      return text;
    });
    delete slot.contentRef;
    delete slot.paragraphRefs;
    return result;
  };
  const cell = (value: unknown): unknown => {
    if (!record(value)) return value;
    const resolved = texts(value);
    return resolved ? resolved.join('\n\n') : value;
  };
  const element = (value: unknown): void => {
    if (!record(value)) return;
    if (value.type === 'text') {
      const resolved = texts(value);
      if (resolved) value.content = referenceHtml(resolved, value.content);
    } else if (value.type === 'shape' && record(value.text)) {
      const resolved = texts(value.text);
      if (resolved) value.text.content = referenceHtml(resolved, value.text.content);
    } else if (value.type === 'table' && Array.isArray(value.data)) {
      for (const row of value.data) if (Array.isArray(row)) for (const tableCell of row) if (record(tableCell)) {
        const resolved = texts(tableCell);
        if (resolved) tableCell.text = referenceHtml(resolved, tableCell.text, true);
      }
    }
  };
  const block = (value: unknown): void => {
    if (!record(value)) return;
    if (value.kind === 'textBox') {
      const resolved = texts(value);
      if (resolved) {
        delete value.text;
        delete value.paragraphs;
        value.paragraphs = resolved;
      }
    } else if (value.kind === 'labelGrid' && Array.isArray(value.rows)) {
      for (const row of value.rows) if (record(row)) {
        if (row.header !== undefined) row.header = cell(row.header);
        if (Array.isArray(row.cells)) row.cells = row.cells.map(cell);
      }
    } else if ((value.kind === 'row' || value.kind === 'column') && Array.isArray(value.children)) value.children.forEach(block);
    else if (value.kind === 'native') element(value.element);
    else element(value);
  };
  if (Array.isArray(data)) data.forEach(block);
  else if (record(data)) {
    if (Array.isArray(data.components)) data.components.forEach(block);
    if (Array.isArray(data.elements)) data.elements.forEach(element);
    if (record(data.layout) && Array.isArray(data.layout.groups)) data.layout.groups.forEach(block);
    if (data.kind || data.type) block(data);
  }
  const check = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(check);
    else if (record(value)) {
      if (Object.hasOwn(value, 'contentRef') || Object.hasOwn(value, 'paragraphRefs')) throw new AuthoringContentError('references belong in textBox, native text, table cells or labelGrid cells');
      Object.values(value).forEach(check);
    }
  };
  check(data);
  return data as T;
}

function visibleHtmlText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<br\s*\/?\s*>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&(?:apos|#39);/gi, "'").replace(/&amp;/gi, '&');
}

/** Check compiled visible elements, not model metadata or unrendered reference declarations. */
export function assertAuthoringContentCoverage(elements: readonly unknown[], items: readonly AuthoringContentItem[]): void {
  validateAuthoringContent(items);
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
  const visible = elements.filter(record).slice().sort((a, b) =>
    (typeof a.top === 'number' && typeof b.top === 'number' ? a.top - b.top : 0)
    || (typeof a.left === 'number' && typeof b.left === 'number' ? a.left - b.left : 0)).flatMap((element) => {
    if (element.type === 'text') return [visibleHtmlText(element.content)];
    if (element.type === 'shape' && record(element.text)) return [visibleHtmlText(element.text.content)];
    if (element.type === 'table' && Array.isArray(element.data)) return element.data.flatMap((row) => Array.isArray(row)
      ? row.filter(record).map((cell) => visibleHtmlText(cell.text)) : []);
    return [];
  }).map(normalize);
  const missing = items.filter((item) => item.required !== false && !visible.some((text) => text.includes(normalize(item.text))));
  if (missing.length) throw new AuthoringContentError(`required adopted points are missing: ${missing.map((item) => item.id).join(', ')}`);
  const readingText = visible.join('\n');
  const groups = new Map<string, AuthoringContentItem[]>();
  for (const item of items) if (item.sequence) groups.set(item.sequence.id, [...(groups.get(item.sequence.id) ?? []), item]);
  for (const [id, group] of groups) {
    let cursor = 0;
    for (const item of group.sort((a, b) => a.sequence!.index - b.sequence!.index)) {
      const text = normalize(item.text);
      if (item.required === false && !visible.some((visibleText) => visibleText.includes(text))) continue;
      const position = readingText.indexOf(text, cursor);
      if (position < 0) throw new AuthoringContentError(`adopted sequence ${id} is out of order at ${item.id}`);
      cursor = position + text.length;
    }
  }
}
