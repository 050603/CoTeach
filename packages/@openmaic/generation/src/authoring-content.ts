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
  /** Native slots can style literal substrings without rewriting adopted text. */
  emphasis?: Array<string | { text: string; color?: string; bold?: boolean }>;
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


type Emphasis = { text: string; color?: string; bold?: boolean };
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

/** Emphasis can style an adopted substring but cannot change its wording. */
function takeEmphasis(slot: RecordValue, texts: readonly string[], onDiagnostic?: (detail: string) => void): Emphasis[] {
  const value = slot.emphasis;
  delete slot.emphasis;
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value.map((item) => typeof item === 'string' ? { text: item } : item) : undefined;
  if (!entries || entries.some((item) => !record(item) || typeof item.text !== 'string' || !item.text.trim()
    || !texts.some((text) => text.includes(item.text as string))
    || (item.color !== undefined && (typeof item.color !== 'string' || !HEX_COLOR.test(item.color)))
    || (item.bold !== undefined && typeof item.bold !== 'boolean'))) {
    if (!onDiagnostic) throw new AuthoringContentError('emphasis must select literal substrings of the referenced content with safe hex colors and boolean bold');
    onDiagnostic('Authoring content: invalid emphasis was ignored without changing the referenced text');
    return [];
  }
  return [...new Map((entries as Emphasis[]).map((item) => [item.text, item])).values()]
    .sort((a, b) => b.text.length - a.text.length);
}

function emphasizedHtml(text: string, emphasis: readonly Emphasis[]): string {
  if (!emphasis.length) return escapeHtml(text);
  let output = '', offset = 0;
  while (offset < text.length) {
    const matches = emphasis.map((item) => ({ item, index: text.indexOf(item.text, offset) }))
      .filter((match) => match.index >= 0).sort((a, b) => a.index - b.index || b.item.text.length - a.item.text.length);
    const next = matches[0];
    if (!next) return output + escapeHtml(text.slice(offset));
    const { color, bold } = next.item;
    const word = escapeHtml(next.item.text);
    const styled = color || bold === false
      ? `<span style="${color ? `color:${color};` : ''}font-weight:${bold === false ? 400 : 700}">${word}</span>`
      : `<strong>${word}</strong>`;
    output += escapeHtml(text.slice(offset, next.index)) + styled;
    offset = next.index + next.item.text.length;
  }
  return output;
}

/** Retain the author's existing enclosing typography, without retaining rewritten prose. */
function referenceHtml(texts: string[], existing: unknown, tableCell = false, bodyFontSize = 24, emphasis: readonly Emphasis[] = []): string {
  // Each reference is a paragraph, rather than two line breaks inside a
  // paragraph. The renderer owns the ordinary 5px gap between paragraphs.
  // Fill authored slots individually; if there are more references, extend
  // the final slot (usually the body), preserving separate label typography.
  if (texts.length > 1 && typeof existing === 'string') {
    const paragraphs = /<p\b[^>]*>[\s\S]*?<\/p\s*>/gi;
    const slots = [...existing.matchAll(paragraphs)];
    const outside = existing.replace(paragraphs, '').replace(/<[^>]*>/g, '').trim();
    if (slots.length && !outside) {
      let index = 0;
      return existing.replace(paragraphs, (paragraph) => {
        const start = index++;
        if (start >= texts.length) return '';
        const end = start === slots.length - 1 ? texts.length : start + 1;
        return texts.slice(start, end).map((text) => referenceHtml([text], paragraph, tableCell, bodyFontSize, emphasis)).join('');
      });
    }
  }
  const prefix = typeof existing === 'string'
    ? existing.match(/^\s*((?:<(?:p|div|h[1-6]|span|strong|b|em|i|u)\b[^>]*>\s*)+)/i)?.[1] : undefined;
  if (texts.length > 1) {
    // Component migration can supply an unclosed shell, or native slots can
    // have only inline typography. Keep outer divs once and repeat the actual
    // paragraph/heading shell, putting inline-only shells inside real p tags.
    const tags = [...(prefix ?? '').matchAll(/<(p|div|h[1-6]|span|strong|b|em|i|u)\b[^>]*>/gi)];
    const block = tags.find((tag) => /^(?:p|h[1-6])$/i.test(tag[1]!));
    const innerStart = block?.index ?? tags.find((tag) => tag[1]!.toLowerCase() !== 'div')?.index ?? prefix?.length ?? 0;
    const outerPrefix = (prefix ?? '').slice(0, innerStart);
    const outerTags = tags.filter((tag) => tag.index! < innerStart).map((tag) => tag[1]);
    const innerPrefix = (prefix ?? '').slice(innerStart);
    const shell = block ? innerPrefix : `${prefix || tableCell ? '<p>' : `<p style="font-size:${bodyFontSize}px">`}${innerPrefix}`;
    return outerPrefix + texts.map((text) => referenceHtml([text], shell, false, bodyFontSize, emphasis)).join('')
      + outerTags.reverse().map((tag) => `</${tag}>`).join('');
  }
  const html = texts.map((text) => emphasizedHtml(text, emphasis).replace(/\n/g, '<br>')).join('');
  if (!prefix) return tableCell ? html : `<p style="font-size:${bodyFontSize}px">${html}</p>`;
  const tags = [...prefix.matchAll(/<(p|div|h[1-6]|span|strong|b|em|i|u)\b[^>]*>/gi)].map((match) => match[1]);
  return `${prefix}${html}${tags.reverse().map((tag) => `</${tag}>`).join('')}`;
}

/** Bind only real display slots, before any font measurement. Never append omitted content. */
export function resolveAuthoringContent<T>(authored: T, items: readonly AuthoringContentItem[], typography?: { bodyFontSize: number; titleFontSize?: number }, onDiagnostic?: (detail: string) => void): T {
  try { validateAuthoringContent(items); }
  catch (error) {
    if (!onDiagnostic) throw error;
    onDiagnostic(error instanceof Error ? error.message : String(error));
    items = items.filter((item) => record(item) && typeof item.id === 'string' && item.id.trim()
      && typeof item.text === 'string' && item.text.trim());
  }
  const catalog = new Map(items.map((item) => [item.id, item.text]));
  const clone = (value: unknown): unknown => Array.isArray(value) ? value.map(clone)
    : record(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
  const data = clone(authored);
  const texts = (slot: RecordValue): string[] | undefined => {
    const hasContent = Object.hasOwn(slot, 'contentRef');
    const hasParagraphs = Object.hasOwn(slot, 'paragraphRefs');
    if (!hasContent && !hasParagraphs) return undefined;
    if (hasContent && hasParagraphs) {
      if (!onDiagnostic) throw new AuthoringContentError('use contentRef or paragraphRefs, not both');
      onDiagnostic('Authoring content: both reference forms were supplied; retaining all resolvable referenced text');
    }
    const refs = hasContent && hasParagraphs ? [slot.contentRef, ...(Array.isArray(slot.paragraphRefs) ? slot.paragraphRefs : [])]
      : hasContent ? [slot.contentRef] : slot.paragraphRefs;
    if (!Array.isArray(refs) || !refs.length || refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
      if (!onDiagnostic) throw new AuthoringContentError('references must contain nonempty catalog ids');
      onDiagnostic('Authoring content: invalid references; retaining the authored text');
    }
    const result = (Array.isArray(refs) ? refs : []).flatMap((ref) => {
      const text = catalog.get(ref as string);
      if (text === undefined) {
        if (!onDiagnostic) throw new AuthoringContentError(`unknown content reference ${String(ref)}`);
        onDiagnostic(`Authoring content: unknown content reference ${String(ref)}; retaining any available authored text`);
        return [];
      }
      return [text];
    });
    delete slot.contentRef;
    delete slot.paragraphRefs;
    return result.length ? result : undefined;
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
      if (resolved) value.content = referenceHtml(resolved, value.content, false, typography?.bodyFontSize, takeEmphasis(value, resolved, onDiagnostic));
    } else if (value.type === 'shape' && record(value.text)) {
      const resolved = texts(value.text);
      if (resolved) value.text.content = referenceHtml(resolved, value.text.content, false, typography?.bodyFontSize, takeEmphasis(value.text, resolved, onDiagnostic));
    } else if (value.type === 'table' && Array.isArray(value.data)) {
      for (const row of value.data) if (Array.isArray(row)) for (const tableCell of row) if (record(tableCell)) {
        const resolved = texts(tableCell);
        if (resolved) tableCell.text = referenceHtml(resolved, tableCell.text, true, typography?.bodyFontSize, takeEmphasis(tableCell, resolved, onDiagnostic));
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
    if (Array.isArray(data.components)) {
      const native: RecordValue[] = [];
      data.components = data.components.filter((component, index) => {
        // Rich text belongs in native elements, where the actual HTML is measured.
        // Flow blocks and standalone plain-component compilation keep their grammar.
        if (!record(data.layout) && record(component) && component.kind === 'textBox' && component.emphasis !== undefined) {
          const resolved = texts(component);
          if (resolved) {
            const emphasis = takeEmphasis(component, resolved, onDiagnostic);
            if (emphasis.length) {
              const fontSize = typeof component.fontSize === 'number' && Number.isFinite(component.fontSize) && component.fontSize > 0
                ? component.fontSize : component.role === 'title' ? typography?.titleFontSize ?? 34 : typography?.bodyFontSize ?? 24;
              const color = typeof component.color === 'string' && HEX_COLOR.test(component.color) ? component.color : '#334155';
              const align = component.align === 'center' || component.align === 'right' ? component.align : 'left';
              const wrapper = `<p style="font-size:${fontSize}px;color:${color};font-weight:${component.bold ? 700 : 400};text-align:${align}">`;
              native.push({ id: component.id ?? `adopted-rich-text-${index}`, type: 'text',
                left: component.left ?? component.x, top: component.top ?? component.y, width: component.width,
                height: component.height ?? fontSize * 1.5 + 20, rotate: 0,
                content: referenceHtml(resolved, wrapper, false, fontSize, emphasis),
                defaultFontName: 'Noto Sans SC', defaultColor: color, lineHeight: 1.5, paragraphSpace: 5,
                vAlign: 'top', textType: component.role === 'title' ? 'title' : 'content' });
              return false;
            }
            delete component.text;
            component.paragraphs = resolved;
          }
        }
        block(component);
        return true;
      });
      if (native.length) data.elements = [...(Array.isArray(data.elements) ? data.elements : []), ...native];
    }
    if (Array.isArray(data.elements)) data.elements.forEach(element);
    if (record(data.layout) && Array.isArray(data.layout.groups)) data.layout.groups.forEach(block);
    if (data.kind || data.type) block(data);
  }
  const check = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(check);
    else if (record(value)) {
      if (Object.hasOwn(value, 'contentRef') || Object.hasOwn(value, 'paragraphRefs')) {
        if (!onDiagnostic) throw new AuthoringContentError('references belong in textBox, native text, table cells or labelGrid cells');
        onDiagnostic('Authoring content: references outside supported text slots were retained only as a quality finding');
        delete value.contentRef;
        delete value.paragraphRefs;
      }
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
