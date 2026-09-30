import { describe, expect, it, vi } from 'vitest';
import { assertAuthoringContentCoverage, resolveAuthoringContent, type AuthoringContentItem } from '../src/authoring-content.js';
import { compileTextComponents, type TextMeasure } from '../src/text-layout-compiler.js';

const catalog: readonly AuthoringContentItem[] = Object.freeze([
  Object.freeze({ id: 'condition', text: '条件满足后，再选择方法。', sequence: { id: 'method', index: 0 } }),
  Object.freeze({ id: 'feedback', text: '根据反馈调整设计。', sequence: { id: 'method', index: 1 } }),
  Object.freeze({ id: 'optional', text: '补充示例。', required: false }),
]);

describe('immutable adopted presentation content', () => {
  it('resolves paragraph slots before measuring their real font without modifying either input', async () => {
    const source = { kind: 'textBox' as const, left: 60, top: 140, width: 880,
      role: 'body' as const, fontSize: 23, paragraphRefs: ['condition', 'feedback'] };
    const measure: TextMeasure = vi.fn(({ text, fontSize, padding, lineHeight }: Parameters<TextMeasure>[0]) => ({
      naturalWidth: Math.max(...text.split('\n').map((line) => [...line].length * fontSize)),
      height: padding * 2 + text.split('\n').length * fontSize * lineHeight, lines: text.split('\n'),
    }));
    const elements = await compileTextComponents([source], measure, { authoringContent: catalog });
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 23, text: expect.stringContaining(catalog[0].text) }));
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(catalog[1].text) }));
    expect(elements[0]).toMatchObject({ type: 'text', left: 60, top: 140, width: 880 });
    expect(() => assertAuthoringContentCoverage(elements, catalog)).not.toThrow();
    expect(source).not.toHaveProperty('paragraphs');
    expect(source.paragraphRefs).toEqual(['condition', 'feedback']);
  });

  it('preserves enclosing rich typography and binds real table and label-grid cells', () => {
    const source = { elements: [
      { type: 'text', contentRef: 'condition', content: '<p style="font-size:21px;color:#112233"><strong>model shorthand</strong></p>' },
      { type: 'table', data: [[{ text: 'placeholder', contentRef: 'feedback', style: { fontsize: 18, bold: true } }]] },
    ], components: [{ kind: 'labelGrid', rows: [{ header: '说明', cells: [{ paragraphRefs: ['condition', 'feedback'] }] }] }] };
    const resolved = resolveAuthoringContent(source, catalog);
    expect(resolved.elements[0]).toMatchObject({ content: `<p style="font-size:21px;color:#112233"><strong>${catalog[0].text}</strong></p>` });
    expect(resolved.elements[1]).toMatchObject({ data: [[{ text: catalog[1].text, style: { fontsize: 18, bold: true } }]] });
    expect(resolved.components[0].rows[0].cells).toEqual([`${catalog[0].text}\n\n${catalog[1].text}`]);
    expect(source.elements[0]).toHaveProperty('contentRef', 'condition');
    expect(() => assertAuthoringContentCoverage(resolved.elements, catalog)).not.toThrow();
  });

  it('escapes point text rather than interpreting it as native markup', () => {
    const items = [{ id: 'inequality', text: '阈值 < 3 & 条件 > 1' }];
    const resolved = resolveAuthoringContent({ elements: [{ type: 'text', contentRef: 'inequality' }] }, items);
    expect(resolved.elements[0]).toMatchObject({ content: '<p style="font-size:24px">阈值 &lt; 3 &amp; 条件 &gt; 1</p>' });
    expect(() => assertAuthoringContentCoverage(resolved.elements, items)).not.toThrow();
  });

  it.each([
    { components: [{ kind: 'textBox', contentRef: 'invented', text: 'valid-looking fallback' }] },
    { elements: [{ type: 'text', paragraphRefs: [] }] },
    { elements: [{ type: 'text', contentRef: 'condition', paragraphRefs: ['feedback'] }] },
    { metadata: { contentRef: 'condition' } },
  ])('rejects invalid or non-display references rather than treating them as content', (source) => {
    expect(() => resolveAuthoringContent(source, catalog)).toThrow(/Authoring content:/);
  });

  it('keeps missing and ordered-point gates strict on actual visible output', () => {
    expect(() => assertAuthoringContentCoverage([{ type: 'text', content: catalog[0].text, metadata: catalog[1].text }], catalog)).toThrow(/feedback/);
    expect(() => assertAuthoringContentCoverage([{ type: 'text', content: `${catalog[1].text}\n${catalog[0].text}` }], catalog)).toThrow(/out of order/);
    expect(() => assertAuthoringContentCoverage([{ type: 'text', content: `${catalog[0].text}\n${catalog[1].text}` }], catalog)).not.toThrow();
  });
});
