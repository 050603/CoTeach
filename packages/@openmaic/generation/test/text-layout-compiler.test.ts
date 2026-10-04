import { describe, expect, it } from 'vitest';
import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import {
  compileTextComponents,
  compileNativeTextLayout,
  TextLayoutError,
  type TextMeasure,
  type TextMeasureInput,
} from '../src/text-layout-compiler.js';

function glyphWidth(character: string, fontSize: number): number {
  if (/\s/.test(character)) return fontSize * 0.3;
  if (/[\x00-\x7f]/.test(character)) return fontSize * 0.55;
  return fontSize;
}

/** A deterministic stand-in for the host's browser measurement contract. */
const measure: TextMeasure = async (input: TextMeasureInput) => {
  const contentWidth = input.width - input.padding * 2;
  const paragraphs = input.text.split('\n\n');
  const explicitLines = paragraphs.map((paragraph) => paragraph.split('\n'));
  const naturalWidth = Math.max(
    ...explicitLines.flat().map((line) =>
      Array.from(line).reduce((sum, character) => sum + glyphWidth(character, input.fontSize), 0),
    ),
  );
  const lines: string[] = [];
  for (const paragraph of explicitLines) {
    for (const explicitLine of paragraph) {
      let current = '';
      let currentWidth = 0;
      for (const character of Array.from(explicitLine)) {
        const width = glyphWidth(character, input.fontSize);
        if (current && currentWidth + width > contentWidth + 0.01) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }
        current += character;
        currentWidth += width;
      }
      lines.push(current);
    }
  }
  return {
    naturalWidth,
    height:
      input.padding * 2 +
      lines.length * input.fontSize * input.lineHeight +
      (paragraphs.length - 1) * input.paragraphSpace,
    lines,
  };
};

function texts(elements: Awaited<ReturnType<typeof compileTextComponents>>): PPTTextElement[] {
  return elements.filter((element): element is PPTTextElement => element.type === 'text');
}

function shapes(elements: Awaited<ReturnType<typeof compileTextComponents>>): PPTShapeElement[] {
  return elements.filter((element): element is PPTShapeElement => element.type === 'shape');
}

describe('generation-time text layout', () => {
  it('uses renderer metrics and preserves mixed text, explicit breaks, HTML-sensitive characters, and paragraphs', async () => {
    const inputs: TextMeasureInput[] = [];
    const capture: TextMeasure = async (input) => {
      inputs.push(input);
      return measure(input);
    };
    const elements = await compileTextComponents(
      [
        {
          kind: 'textBox',
          id: 'intro',
          x: 50,
          y: 65,
          width: 440,
          height: 190,
          role: 'body',
          fontSize: 24,
          bold: true,
          color: '#123456',
          text: 'AI观察：牛与鱼\n对比 <真实> & 想象',
        },
        {
          kind: 'textBox',
          id: 'definition',
          left: 500,
          top: 65,
          width: 450,
          height: 220,
          paragraphs: ['同化：把新信息纳入已有图式。', '顺应：调整图式，以解释新的证据。'],
        },
      ],
      capture,
    );

    expect(elements).toHaveLength(2);
    const [intro, definition] = texts(elements);
    expect(intro.id).toBe('intro');
    expect(intro.defaultFontName).toBe('Noto Sans SC');
    expect(intro.content).toContain('font-size:24px;font-weight:700');
    expect(intro.content).toContain('AI观察：牛与鱼<br>对比 &lt;真实&gt; &amp; 想象');
    expect(definition.content.match(/<p /g)).toHaveLength(2);
    expect(definition.content).toContain('同化：把新信息纳入已有图式。');
    expect(definition.content).toContain('顺应：调整图式，以解释新的证据。');
    expect(inputs.every((input) => input.fontFamily === 'Noto Sans SC')).toBe(true);
    expect(inputs.every((input) => input.padding === 10 && input.lineHeight === 1.5 && input.paragraphSpace === 5)).toBe(true);
    expect(inputs.some((input) => input.fontWeight === 700)).toBe(true);
  });

  it('balances an eight-character short label instead of leaving one Chinese character on the last line', async () => {
    const [label] = texts(await compileTextComponents([
      {
        kind: 'textBox',
        left: 50,
        top: 50,
        width: 137,
        height: 85,
        role: 'label',
        text: '识别图中显性线索',
      },
    ], measure));

    expect(label.content).toContain('识别图中<br>显性线索');
    expect(label.content).toContain('font-size:20px');
    expect(label.width).toBe(137);
    expect(label.height).toBe(80);
  });

  it('allocates grid columns from measured needs and keeps editable backgrounds and labels inside bounds', async () => {
    const elements = await compileTextComponents([
      {
        kind: 'labelGrid',
        id: 'clues',
        left: 60,
        top: 100,
        width: 600,
        height: 205,
        gapX: 14,
        gapY: 10,
        rows: [
          { header: '显性线索', cells: ['观察', '对比想象中的牛和真实的牛'] },
          { header: '隐性线索', cells: ['解释', '把已有知识与新的证据相联系'] },
        ],
      },
    ], measure);

    expect(elements).toHaveLength(12);
    expect(shapes(elements)).toHaveLength(6);
    expect(texts(elements)).toHaveLength(6);
    expect(texts(elements)[0].content).toContain('font-weight:700');
    const boxes = shapes(elements);
    expect(boxes[2].width).toBeGreaterThan(boxes[1].width);
    for (let index = 0; index < elements.length; index += 2) {
      const shape = elements[index] as PPTShapeElement;
      const label = elements[index + 1] as PPTTextElement;
      expect(shape.groupId).toBe(label.groupId);
      expect(shape.left).toBe(label.left);
      expect(shape.top).toBe(label.top);
      expect(shape.left).toBeGreaterThanOrEqual(60);
      expect(shape.top).toBeGreaterThanOrEqual(100);
      expect(shape.left + shape.width).toBeLessThanOrEqual(660.01);
      expect(shape.top + shape.height).toBeLessThanOrEqual(305.01);
    }
  });

  it('lays out four narrow eight-character labels with two complete lines each', async () => {
    const elements = await compileTextComponents([
      {
        kind: 'labelGrid', left: 50, top: 50, width: 286, height: 180,
        rows: [
          { cells: ['识别图中显性线索', '说明事物关键特征'] },
          { cells: ['分析图中隐性线索', '联系已有知识经验'] },
        ],
      },
    ], measure);
    const labels = texts(elements);
    expect(labels).toHaveLength(4);
    for (const label of labels) {
      const visible = label.content.replace(/<[^>]+>/g, '');
      const segments = label.content.match(/>([^<>]*)<br>([^<>]*)<\/p>/);
      expect(segments).not.toBeNull();
      expect(Array.from(segments![1])).toHaveLength(4);
      expect(Array.from(segments![2])).toHaveLength(4);
      expect(visible).toHaveLength(8);
    }
  });

  it('preserves an explicit short-label line break and keeps punctuation off a new line', async () => {
    const elements = await compileTextComponents([
      {
        kind: 'textBox', left: 50, top: 50, width: 130, height: 90,
        role: 'label', text: '观察AI图像\n比较差异',
      },
      {
        kind: 'textBox', left: 190, top: 50, width: 120, height: 90,
        role: 'label', text: '观察变化，解释原因',
      },
    ], measure);
    const [explicit, balanced] = texts(elements);
    expect(explicit.content).toContain('观察AI图像<br>比较差异');
    expect(balanced.content).toContain('<br>');
    expect(balanced.content).not.toMatch(/<br>[，。！？；：]/);
  });

  it('uses measured height despite a small model hint, while honoring an explicit maximum', async () => {
    const [sized] = texts(await compileTextComponents([
      { kind: 'textBox', left: 50, top: 50, width: 125, height: 39,
        role: 'label', text: '识别图中显性线索' },
    ], measure));
    expect(sized.height).toBeGreaterThan(39);

    await expect(compileTextComponents([
      {
        kind: 'textBox', left: 50, top: 50, width: 125, maxHeight: 39,
        role: 'label', text: '识别图中显性线索',
      },
    ], measure)).rejects.toThrow(/needs .* but its maximum allocation is 39px high/);

    await expect(compileTextComponents([
      {
        kind: 'labelGrid', left: 50, top: 50, width: 100, height: 180,
        rows: [{ cells: ['识别图中显性线索', '比较已有图式与新证据'] }],
      },
    ], measure)).rejects.toThrow(TextLayoutError);

    await expect(compileTextComponents([
      { kind: 'textBox', left: 50, top: 50, width: 200, height: 90, text: 'A', paragraphs: ['B'] },
    ], measure)).rejects.toThrow(/text or paragraphs/);
  });

  it('rejects containers outside the slide safe area while allowing ordinary body wrapping', async () => {
    await expect(compileTextComponents([
      { kind: 'textBox', left: 49, top: 50, width: 160, height: 90, text: '越界' },
    ], measure)).rejects.toThrow(/safe area/);
    await expect(compileTextComponents([
      { kind: 'textBox', left: 800, top: 50, width: 151, height: 90, text: '越界' },
    ], measure)).rejects.toThrow(/safe area/);
    await expect(compileTextComponents([
      { kind: 'textBox', left: 50, top: 500, width: 150, height: 13, text: '越界' },
    ], measure)).rejects.toThrow(/maximum allocation/);

    const body = texts(await compileTextComponents([
      { kind: 'textBox', left: 50, top: 50, width: 80, height: 180, role: 'body', text: '几个字符' },
    ], measure));
    expect(body[0].content).toContain('几个字符');
  });
});


describe('native slide typography preservation', () => {
  const native = (content: string, width = 90, height = 100): PPTTextElement => ({
    id: 'stable-label', type: 'text', left: 80, top: 140, width, height, rotate: 0,
    content, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', lineHeight: 1.5,
  });

  it('rebalances a rich label with punctuation without changing its styles or allocation', async () => {
    const element = native('<p style="font-size:16px;color:#223388"><strong>显性线索栏。</strong></p>');
    const [compiled] = await compileNativeTextLayout([element], measure);
    expect(compiled).toMatchObject({ ...element, content: expect.stringContaining('<br>') });
    if (compiled.type !== 'text') throw new Error('Expected native text');
    expect(compiled.content.replace('<br>', '')).toBe(element.content);
  });

  it('repairs a model-authored one-character break while retaining inline emphasis', async () => {
    const element = native('<p style="font-size:16px">显性<strong>线<br>索。</strong></p>', 130);
    const [compiled] = await compileNativeTextLayout([element], measure);
    if (compiled.type !== 'text') throw new Error('Expected native text');
    expect(compiled.content).not.toContain('线<br>索。');
    expect(compiled.content.replace(/<br>/g, '')).toBe(element.content.replace(/<br>/g, ''));
  });

  it('widens a short orphaned label only when measured free space is available', async () => {
    const element = native('<p style="font-size:16px">建构主义的原理</p>', 70, 75);
    const [repaired] = await compileNativeTextLayout([element], measure);
    expect(repaired).toMatchObject({ id: element.id, content: element.content });
    expect(repaired.width).toBeGreaterThan(element.width);

    const neighbor = { ...native('<p style="font-size:16px">旁边</p>', 100, 75),
      id: 'neighbor', left: 152 };
    await expect(compileNativeTextLayout([element, neighbor], measure))
      .rejects.toThrow(/single-character wrapped line/);
  });

  it('measures every native text but preserves fitting paragraphs and intentional preformatted breaks', async () => {
    const inputs: TextMeasureInput[] = [];
    const element = native('<p style="font-size:16px">先观察可见证据。</p><p style="font-size:16px">再解释推理依据。</p>', 400);
    const preformatted = native('<p style="white-space:pre">山<br>水</p>', 100);
    const results = await compileNativeTextLayout([element, preformatted], (input) => { inputs.push(input); return measure(input); });
    expect(results).toEqual([element, preformatted]);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.preserveRichText)).toBe(true);
  });

  it('reports an allocation failure without shrinking fonts, deleting words or adding pages', async () => {
    const element = native('<p style="font-size:16px">显性线索。</p>', 70, 30);
    await expect(compileNativeTextLayout([element], measure)).rejects.toThrow(/native text stable-label/);
    expect(element.width).toBe(70);
    expect(element.content).toContain('显性线索。');
  });

  it('uses measured free space for a small native text overflow without overlapping neighboring content', async () => {
    const body = { ...native('<p style="font-size:16px">四个步骤的完整说明</p>', 540, 142),
      id: 'text_steps', left: 80, top: 180 };
    const card = { id: 'card', type: 'shape', left: 70, top: 170, width: 560, height: 200,
      rotate: 0 } as unknown as PPTShapeElement;
    const neighbor = { ...native('<p style="font-size:16px">下一项</p>', 200, 30),
      id: 'next_item', left: 80, top: 340 };
    const browserBounds: TextMeasure = async (input) => input.text.includes('四个步骤')
      ? { height: 146, inkBottom: 146, inkRight: 382, naturalWidth: 382, lines: ['四个步骤的完整说明'] }
      : { height: 30, inkBottom: 30, inkRight: 80, naturalWidth: 80, lines: ['下一项'] };

    const compiled = await compileNativeTextLayout([card, body, neighbor], browserBounds);
    expect(compiled[1]).toMatchObject({ id: 'text_steps', height: 146, content: body.content });
    expect(compiled[0]).toBe(card);
    await expect(compileNativeTextLayout([card, body, { ...neighbor, top: 323 }], browserBounds))
      .rejects.toThrow(/text_steps needs 146px but would overlap next_item/);
  });

  it('uses actual measured glyph ink for growth collisions while retaining genuine text overlap and unknown-area checks', async () => {
    const body = { ...native('<p style="font-size:18px">完整说明</p>', 400, 40), id: 'body', left: 60, top: 180 };
    const neighbor = { ...native('<p style="font-size:18px">后续说明</p>', 400, 30), id: 'next', left: 60, top: 222 };
    const inkMeasure = (neighborInkTop: number, unknown = false): TextMeasure => ({ text }) => text === '完整说明'
      ? { height: 48, inkBottom: 48, naturalWidth: 100, inkRight: 110, lines: [text],
        inkRects: [{ left: 10, top: 10, width: 100, height: 38 }] }
      : { height: 30, inkBottom: 30, naturalWidth: 100, inkRight: 110, lines: [text],
        ...(unknown ? {} : { inkRects: [{ left: 10, top: neighborInkTop, width: 100, height: 14 }] }) };
    const clear = await compileNativeTextLayout([body, neighbor], inkMeasure(14));
    expect(clear[0]).toMatchObject({ id: 'body', height: 48, content: body.content });
    await expect(compileNativeTextLayout([body, neighbor], inkMeasure(3)))
      .rejects.toThrow(/body needs 48px but would overlap next/);
    await expect(compileNativeTextLayout([body, neighbor], inkMeasure(14, true)))
      .rejects.toThrow(/body needs 48px but would overlap next/);
  });

  it('does not mistake background paint behind a neighboring source caption for a foreground collision', async () => {
    const panel = { id: 'diagram-background', type: 'shape', left: 54, top: 124, width: 252, height: 332,
      rotate: 0, fill: '#EFF6FF' } as unknown as PPTShapeElement;
    const caption = { ...native('<p style="font-size:16px">完整来源图注</p>', 880, 24), id: 'source', left: 60, top: 96 };
    const measured: TextMeasure = ({ text }) => ({ height: 29, inkBottom: 29, inkRight: 200,
      naturalWidth: 180, lines: [text], inkRects: [{ left: 10, top: 10, width: 180, height: 19 }] });
    expect(await compileNativeTextLayout([panel, caption], measured)).toMatchObject([panel, { ...caption, height: 29 }]);
    await expect(compileNativeTextLayout([caption, panel], measured)).rejects.toThrow(/would overlap diagram-background/);
    const peer = { ...caption, id: 'other-words', left: 60, top: 120, height: 30 };
    const colliding: TextMeasure = (input) => input.text === '完整来源图注' && input.width === 880
      ? measured(input) : { height: 20, inkBottom: 20, inkRight: 150, naturalWidth: 130, lines: [input.text],
        inkRects: [{ left: 10, top: 0, width: 130, height: 20 }] };
    peer.content = '<p style="font-size:16px">真实邻近正文</p>';
    await expect(compileNativeTextLayout([panel, caption, peer], colliding)).rejects.toThrow(/would overlap other-words/);
  });

  it('recognizes a preceding background by its original glyph ownership without ignoring ink that spills out', async () => {
    const card = { id: 'header-background', type: 'shape', left: 50, top: 170, width: 420, height: 52,
      rotate: 0, fill: '#1E3A8A' } as unknown as PPTShapeElement;
    const body = { ...native('<p style="font-size:18px">蓝色表头</p>', 400, 40), id: 'header', left: 60, top: 180 };
    const withinBackground: TextMeasure = ({ text }) => ({ height: 48, inkBottom: 48, inkRight: 120,
      naturalWidth: 100, lines: [text], inkRects: [{ left: 10, top: 10, width: 100, height: 27 }] });
    expect(await compileNativeTextLayout([card, body], withinBackground))
      .toMatchObject([card, { ...body, height: 48 }]);
    const outsideBackground: TextMeasure = ({ text }) => ({ height: 48, inkBottom: 48, inkRight: 120,
      naturalWidth: 100, lines: [text], inkRects: [{ left: 10, top: 10, width: 100, height: 38 }] });
    await expect(compileNativeTextLayout([card, body], outsideBackground))
      .rejects.toThrow(/header needs 48px but would overlap header-background/);
  });

  const panelColumn = (id: string, left: number, text: string): PPTElement[] => [
    { id: `${id}-panel`, type: 'shape', left, top: 224, width: 204, height: 142,
      rotate: 0, fill: '#FFFFFF' } as PPTShapeElement,
    { ...native('<p style="font-size:18px;color:#1E3A8A;font-weight:700;line-height:1.5">材料特点</p>', 180, 46),
      id: `${id}-head`, left: left + 12, top: 228 },
    { ...native(`<p style="font-size:16px;color:#334155;line-height:1.5">${text}</p>`, 180, 82),
      id: `${id}-body`, left: left + 12, top: 274 },
  ];
  const panelInkMeasure: TextMeasure = (input) => {
    const count = input.fontSize === 18 ? 1 : input.text.includes('较长') ? input.width < 204 ? 4 : 3 : 2;
    const inkRects = Array.from({ length: count }, (_, index) => ({ left: 10, top: 17 + index * 24,
      width: Math.min(140, input.width - 20), height: input.fontSize === 18 ? 16 : 14 }));
    return { naturalWidth: 400, height: 20 + count * 24, inkBottom: 17 + (count - 1) * 24 + inkRects[0]!.height,
      inkRight: 150, inkRects, lines: Array.from({ length: count }, () => '实际内容') };
  };

  it('uses the existing text-only owning panel width before overflow, aligning safe same-row peers without changing fonts or facts', async () => {
    const first = panelColumn('one', 100, '较长材料说明保留全部事实。');
    const second = panelColumn('two', 316, '另一材料的完整说明。');
    const outer = { id: 'group', type: 'shape', left: 80, top: 174, width: 660, height: 204,
      rotate: 0, fill: '#EFF6FF' } as PPTShapeElement;
    const source = [outer, first[0]!, second[0]!, ...first.slice(1), ...second.slice(1)];
    const unchanged = structuredClone(source);
    const diagnostics: string[] = [];
    const compiled = await compileNativeTextLayout(source, panelInkMeasure, {
      preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail),
    });
    expect(diagnostics).toEqual([]);
    expect(compiled.slice(0, 3)).toEqual(source.slice(0, 3));
    for (const element of compiled.filter((element): element is PPTTextElement => element.type === 'text')) {
      const original = source.find((item) => item.id === element.id)!;
      expect(element).toEqual({ ...original, left: element.id.startsWith('one') ? 100 : 316, width: 204 });
    }
    expect(source).toEqual(unchanged);
  });

  it('leaves fitting panels and legacy native compilation unchanged', async () => {
    const fitting = panelColumn('fitting', 100, '完整简短说明。');
    expect(await compileNativeTextLayout(fitting, panelInkMeasure, { preserveNativeComposition: true })).toEqual(fitting);
    const overflowing = panelColumn('legacy', 100, '较长说明。');
    const diagnostics: string[] = [];
    const compiled = await compileNativeTextLayout(overflowing, panelInkMeasure, { onDiagnostic: (detail) => diagnostics.push(detail) });
    expect(compiled.find((element) => element.id === 'legacy-body')).toMatchObject({ left: 112, width: 180 });
    expect(diagnostics.some((detail) => detail.includes('exceeds its authored'))).toBe(true);
  });

  it.each(['still-overflows', 'unknown-ink', 'mixed-column', 'media', 'connector', 'hidden-panel', 'hidden-text', 'outside-safe-area'] as const)(
    'keeps genuine diagnostics and the original geometry when the panel-width candidate is unsafe: %s', async (condition) => {
      const source = panelColumn('conservative', condition === 'outside-safe-area' ? 40 : 100, '较长完整说明。');
      let measured = panelInkMeasure;
      if (condition === 'mixed-column') source[1] = { ...source[1]!, left: source[1]!.left + 4 };
      if (condition === 'media') source.splice(1, 0, { id: 'retained-media', type: 'image', left: 270, top: 250,
        width: 20, height: 20, rotate: 0, src: 'source-image' } as PPTElement);
      if (condition === 'connector') source.splice(1, 0, { id: 'real-connector', type: 'line', left: 100, top: 295, width: 1,
        start: [0, 0], end: [200, 0], style: 'solid', color: '#334155', points: ['', 'arrow'] });
      if (condition === 'hidden-panel') source[0] = { ...source[0] as PPTShapeElement, opacity: 0 };
      if (condition === 'hidden-text') source[2] = { ...source[2] as PPTTextElement, opacity: 0 };
      if (condition === 'still-overflows') measured = (input) => panelInkMeasure({ ...input, width: 180 });
      if (condition === 'unknown-ink') measured = async (input) => {
        const { inkRects: _unknown, ...result } = await panelInkMeasure(input);
        return result;
      };
      const diagnostics: string[] = [];
      const compiled = await compileNativeTextLayout(source, measured, {
        preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail),
      });
      const originalBody = source.find((element) => element.id === 'conservative-body')!;
      expect(compiled.find((element) => element.id === 'conservative-body')).toMatchObject({
        left: originalBody.left, width: originalBody.width, content: (originalBody as PPTTextElement).content,
      });
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(compiled.filter((element) => element.type !== 'text')).toEqual(source.filter((element) => element.type !== 'text'));
    },
  );

  it('rejects widened glyphs that would overlap another foreground even when their original frame did not own that foreground', async () => {
    const source = panelColumn('collision', 100, '较长完整说明。');
    const neighbor = { ...native('<p style="font-size:16px">旁注</p>', 30, 30), id: 'side-note', left: 90, top: 290 };
    source.push(neighbor);
    const measured: TextMeasure = (input) => input.text === '旁注'
      ? { naturalWidth: 10, height: 20, inkBottom: 15, inkRight: 25, lines: ['旁注'],
        inkRects: [{ left: 15, top: 0, width: 10, height: 15 }] }
      : panelInkMeasure(input);
    const diagnostics: string[] = [];
    const compiled = await compileNativeTextLayout(source, measured, {
      preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail),
    });
    expect(compiled.find((element) => element.id === 'collision-body')).toMatchObject({ left: 112, width: 180 });
    expect(compiled.find((element) => element.id === 'side-note')).toEqual(neighbor);
    expect(diagnostics.some((detail) => detail.includes('panel-width candidate was not safe'))).toBe(true);
  });

  it('measures native table cells with authored widths, cell padding and font sizes', async () => {
    const inputs: TextMeasureInput[] = [];
    const table = { id: 'comparison', type: 'table' as const, left: 60, top: 120, width: 800, height: 120, rotate: 0,
      colWidths: [0.25, 0.75], cellMinHeight: 60, rowHeights: [60], outline: { width: 1, color: '#999999' },
      data: [[{ id: 'dimension', text: '<strong>显性线索</strong>', colspan: 1, rowspan: 1, style: { fontsize: '16', bold: true }, padding: '4px 8px' },
        { id: 'meaning', text: '学习者可观察到的任务推进', colspan: 1, rowspan: 1, style: { fontsize: '18' } }]] } as import('@openmaic/dsl').PPTTableElement;
    const [compiled] = await compileNativeTextLayout([table], (input) => { inputs.push(input); return measure(input); });
    expect(compiled).toEqual(table);
    expect(inputs.map((input) => input.width)).toEqual([198, 598]);
    expect(inputs.map((input) => input.fontSize)).toEqual([16, 18]);
    expect(inputs[0]).toMatchObject({ tableCell: true, padding: 0, paddingCss: '4px 8px', fontWeight: 700, preserveRichText: true });
  });
});
