import { describe, expect, it, vi } from 'vitest';
import { assertAuthoringContentCoverage, resolveAuthoringContent, type AuthoringContentItem } from '../src/authoring-content.js';
import { compileNativeTextLayout, compileTextComponents, type TextMeasure } from '../src/text-layout-compiler.js';
import { NativeContentBindings } from '../src/native-content-bindings.js';

const catalog: readonly AuthoringContentItem[] = Object.freeze([
  Object.freeze({ id: 'condition', text: '条件满足后，再选择方法。', sequence: { id: 'method', index: 0 } }),
  Object.freeze({ id: 'feedback', text: '根据反馈调整设计。', sequence: { id: 'method', index: 1 } }),
  Object.freeze({ id: 'optional', text: '补充示例。', required: false }),
]);

describe('immutable adopted presentation content', () => {
  it('binds safe colored emphasis in native slots and migrates emphasized text boxes before measurement without rewriting text', async () => {
    const items = [{ id: 'point', text: '先观察条件，再选择方法。' }];
    const emphasis = [{ text: '条件', color: '#DC2626', bold: true }, { text: '方法', color: '#2563EB', bold: false }, '观察'];
    const source = { elements: [
      { type: 'text', contentRef: 'point', emphasis },
      { type: 'shape', text: { contentRef: 'point', emphasis } },
      { type: 'table', data: [[{ contentRef: 'point', emphasis }]] },
    ], components: [{ kind: 'textBox', id: 'rich-box', left: 60, top: 140, width: 880, height: 90,
      fontSize: 18, contentRef: 'point', emphasis }] };
    const resolved = resolveAuthoringContent(source, items);
    const native = resolved.elements as unknown as Array<Record<string, unknown>>;
    const htmls = [native[0].content, (native[1].text as Record<string, unknown>).content,
      (native[2].data as Array<Array<Record<string, unknown>>>)[0][0].text, native[3].content];
    for (const html of htmls) {
      expect(String(html).replace(/<[^>]*>/g, '')).toBe(items[0].text);
      expect(html).toContain('<span style="color:#DC2626;font-weight:700">条件</span>');
      expect(html).toContain('<span style="color:#2563EB;font-weight:400">方法</span>');
      expect(html).toContain('<strong>观察</strong>');
    }
    expect(resolved.components).toEqual([]);
    expect(source.components[0]).toHaveProperty('contentRef', 'point');
    expect(() => assertAuthoringContentCoverage(native, items)).not.toThrow();
    const measure: TextMeasure = vi.fn(({ text }) => ({ naturalWidth: 300, height: 50, lines: [text] }));
    await compileNativeTextLayout([native[3]] as unknown as Parameters<typeof compileNativeTextLayout>[0], measure);
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('color:#DC2626;font-weight:700') }));
    for (const invalid of [{ text: '条件', color: 'red;position:fixed' }, { text: '不存在', color: '#DC2626' }]) {
      expect(() => resolveAuthoringContent({ elements: [{ type: 'text', contentRef: 'point', emphasis: [invalid] }] }, items))
        .toThrow(/literal substrings/);
    }
  });
  it('uses the adopted lecture font and literal keyword emphasis before measuring native text', () => {
    const resolved = resolveAuthoringContent({ elements: [{ type: 'text', contentRef: 'condition',
      emphasis: ['条件满足'], left: 60, top: 140, width: 880, height: 90 }] }, catalog, { bodyFontSize: 18 });
    expect(resolved.elements[0]).toMatchObject({ content: '<p style="font-size:18px"><strong>条件满足</strong>后，再选择方法。</p>' });
    expect(resolved.elements[0]).not.toHaveProperty('emphasis');
    expect(() => resolveAuthoringContent({ elements: [{ type: 'text', contentRef: 'condition',
      emphasis: ['条件不满足'] }] }, catalog)).toThrow(/literal substrings/);
  });
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

  it('fills matching paragraph templates without giving the explanation its label typography or extra blank lines', () => {
    const items = [{ id: 'label', text: '同化' }, { id: 'body', text: '新信息进入原有结构，但不改变结构本身。' }];
    const template = '<p style="font-size:18px;font-weight:700;color:#1E3A8A;line-height:1.5;"></p>'
      + '<p style="font-size:18px;font-weight:400;color:#334155;line-height:1.5;"></p>';
    const source = { elements: [
      { type: 'text', content: template, paragraphRefs: ['label', 'body'], emphasis: [{ text: '不改变', color: '#C2410C' }] },
      { type: 'shape', text: { content: template, paragraphRefs: ['label', 'body'] } },
    ] };
    const resolved = resolveAuthoringContent(source, items, { bodyFontSize: 18 });
    expect(resolved.elements[0].content).toBe('<p style="font-size:18px;font-weight:700;color:#1E3A8A;line-height:1.5;">同化</p>'
      + '<p style="font-size:18px;font-weight:400;color:#334155;line-height:1.5;">新信息进入原有结构，但<span style="color:#C2410C;font-weight:700">不改变</span>结构本身。</p>');
    expect(resolved.elements[1].text?.content).toBe(template.replace('</p>', '同化</p>').replace(/<\/p>$/, `${items[1]!.text}</p>`));
    expect(source.elements[0].content).toBe(template);
    expect(() => assertAuthoringContentCoverage(resolved.elements, items)).not.toThrow();
  });

  it('uses real paragraph spacing for multiple references in a single shell without growing the authored box or losing bindings', async () => {
    const items = [
      { id: 'observe', text: '① 观察材料的外观', sequence: { id: 'inspection', index: 0 } },
      { id: 'compare', text: '② 比较不同材料的用途', sequence: { id: 'inspection', index: 1 } },
      { id: 'record', text: '③ 根据结果记录差异', sequence: { id: 'inspection', index: 2 } },
    ];
    const shell = '<p style="font-size:16px;color:#334155;line-height:1.5;"></p>';
    const source = { elements: [{ id: 'inspection', type: 'text' as const, left: 636, top: 246, width: 288, height: 104, rotate: 0,
      defaultFontName: '', defaultColor: '#334155', content: shell, paragraphRefs: items.map((item) => item.id),
      emphasis: [{ text: '不同材料', color: '#1E3A8A', bold: true }] }] };
    const bindings = new NativeContentBindings(items);
    bindings.capture(source, 'inspection-page');
    const resolved = resolveAuthoringContent(source, items, { bodyFontSize: 18 });
    // This host metric distinguishes DOM paragraphs from actual blank lines;
    // it models three 24px lines, two 5px gaps, and the renderer's 20px padding.
    const measure: TextMeasure = vi.fn(({ html, padding, fontSize, lineHeight, paragraphSpace }) => {
      const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)];
      const lines = paragraphs.map((paragraph) => paragraph[1]!.replace(/<[^>]*>/g, ''));
      const lineCount = paragraphs.reduce((count, paragraph) => count + 1 + (paragraph[1]!.match(/<br\s*\/?\s*>/g)?.length ?? 0), 0);
      return { naturalWidth: 240, height: padding * 2 + lineCount * fontSize * lineHeight + (paragraphs.length - 1) * paragraphSpace, lines };
    });
    const diagnostics: string[] = [];
    const elements = await compileNativeTextLayout(resolved.elements, measure, { onDiagnostic: (detail) => diagnostics.push(detail) });
    expect(elements[0]).toMatchObject({ left: 636, top: 246, width: 288, height: 104 });
    expect(elements[0]!.type === 'text' && elements[0].content.match(/<p\b/g)).toHaveLength(3);
    expect(elements[0]!.type === 'text' && elements[0].content).not.toContain('<br>');
    expect(elements[0]!.type === 'text' && elements[0].content).toContain('<span style="color:#1E3A8A;font-weight:700">不同材料</span>');
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 16, paragraphSpace: 5, preserveRichText: true }));
    expect(diagnostics).toEqual([]);
    expect(bindings.resolve(elements, new Map())).toEqual(items.map((item) => ({ sourceContentId: item.id, elementId: 'inspection' })));
    expect(() => assertAuthoringContentCoverage(elements, items)).not.toThrow();
    expect(source.elements[0]).toMatchObject({ content: shell, paragraphRefs: items.map((item) => item.id) });
  });

  it('extends the final body template when reference counts differ, preserving labels, inline styles and within-paragraph newlines', () => {
    const items = [{ id: 'label', text: '材料检查' }, { id: 'body', text: '观察外观\n再记录结果。' }, { id: 'note', text: '随后比较不同材料。' }];
    const template = '<div style="color:#334155">'
      + '<p style="font-size:18px;color:#1E3A8A;font-weight:700"><strong>label</strong></p>'
      + '<p style="font-size:16px;font-weight:400"><em>body</em></p></div>';
    const resolved = resolveAuthoringContent({ elements: [{ type: 'text', content: template, paragraphRefs: items.map((item) => item.id) }] }, items);
    expect(resolved.elements[0].content).toBe('<div style="color:#334155">'
      + '<p style="font-size:18px;color:#1E3A8A;font-weight:700"><strong>材料检查</strong></p>'
      + '<p style="font-size:16px;font-weight:400"><em>观察外观<br>再记录结果。</em></p>'
      + '<p style="font-size:16px;font-weight:400"><em>随后比较不同材料。</em></p></div>');
    expect(() => assertAuthoringContentCoverage(resolved.elements, items)).not.toThrow();
    const excess = resolveAuthoringContent({ elements: [{ type: 'text', content: template + '<p>unused</p>', paragraphRefs: ['label', 'body'] }] }, items);
    expect(excess.elements[0].content).not.toContain('unused');
    expect(excess.elements[0].content.match(/<p\b/g)).toHaveLength(2);
  });

  it('uses independent paragraphs in native shape and table slots, retaining inherited cell typography', () => {
    const items = [{ id: 'first', text: '先观察。' }, { id: 'second', text: '再比较。' }];
    const refs = items.map((item) => item.id);
    const resolved = resolveAuthoringContent({ elements: [
      { type: 'shape', text: { content: '<p style="font-size:16px"><strong></strong></p>', paragraphRefs: refs } },
      { type: 'table', data: [[{ text: '', paragraphRefs: refs, style: { fontsize: 16 } }]] },
      { type: 'text', content: '<div style="font-size:16px"><em></em></div>', paragraphRefs: refs },
      { type: 'text', paragraphRefs: refs },
    ] }, items, { bodyFontSize: 18 });
    expect(resolved.elements[0].text?.content).toBe('<p style="font-size:16px"><strong>先观察。</strong></p><p style="font-size:16px"><strong>再比较。</strong></p>');
    expect(resolved.elements[1].data?.[0]?.[0]).toMatchObject({ text: '<p>先观察。</p><p>再比较。</p>', style: { fontsize: 16 } });
    expect(resolved.elements[2].content).toBe('<div style="font-size:16px"><p><em>先观察。</em></p><p><em>再比较。</em></p></div>');
    expect(resolved.elements[3].content).toBe('<p style="font-size:18px">先观察。</p><p style="font-size:18px">再比较。</p>');
    expect(() => assertAuthoringContentCoverage(resolved.elements, items)).not.toThrow();
  });

  it('keeps emphasized measured component paragraphs as separate rich paragraphs when migrating an open shell', () => {
    const items = [{ id: 'one', text: '观察条件。' }, { id: 'two', text: '比较结果。' }];
    const resolved = resolveAuthoringContent({ components: [{ kind: 'textBox', id: 'rich-list', left: 60, top: 140, width: 400,
      height: 80, fontSize: 18, paragraphRefs: items.map((item) => item.id), emphasis: ['条件', '结果'] }] }, items);
    expect(resolved.components).toEqual([]);
    const migrated = (resolved as unknown as { elements: Array<Record<string, unknown>> }).elements[0]!;
    expect(migrated).toMatchObject({ id: 'rich-list', lineHeight: 1.5, paragraphSpace: 5, height: 80 });
    expect(migrated.content).toBe('<p style="font-size:18px;color:#334155;font-weight:400;text-align:left">观察<strong>条件</strong>。</p>'
      + '<p style="font-size:18px;color:#334155;font-weight:400;text-align:left">比较<strong>结果</strong>。</p>');
    expect(() => assertAuthoringContentCoverage([migrated], items)).not.toThrow();
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
