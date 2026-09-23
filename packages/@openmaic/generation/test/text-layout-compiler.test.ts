import { describe, expect, it } from 'vitest';
import type { PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import {
  compileTextComponents,
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
          x: 42,
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
        left: 20,
        top: 30,
        width: 137,
        height: 85,
        role: 'label',
        text: '识别图中显性线索',
      },
    ], measure));

    expect(label.content).toContain('识别图中<br>显性线索');
    expect(label.content).toContain('font-size:20px');
    expect(label.width).toBe(137);
    expect(label.height).toBe(85);
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

  it('preserves an explicit short-label line break and keeps punctuation off a new line', async () => {
    const elements = await compileTextComponents([
      {
        kind: 'textBox', left: 0, top: 0, width: 130, height: 90,
        role: 'label', text: '观察AI图像\n比较差异',
      },
      {
        kind: 'textBox', left: 140, top: 0, width: 120, height: 90,
        role: 'label', text: '观察变化，解释原因',
      },
    ], measure);
    const [explicit, balanced] = texts(elements);
    expect(explicit.content).toContain('观察AI图像<br>比较差异');
    expect(balanced.content).toContain('<br>');
    expect(balanced.content).not.toMatch(/<br>[，。！？；：]/);
  });

  it('fails when content cannot fit the declared width or height, without truncation', async () => {
    await expect(compileTextComponents([
      {
        kind: 'textBox', left: 0, top: 0, width: 125, height: 39,
        role: 'label', text: '识别图中显性线索',
      },
    ], measure)).rejects.toThrow(/needs .* but its container is 39px high/);

    await expect(compileTextComponents([
      {
        kind: 'labelGrid', left: 0, top: 0, width: 100, height: 180,
        rows: [{ cells: ['识别图中显性线索', '比较已有图式与新证据'] }],
      },
    ], measure)).rejects.toThrow(TextLayoutError);

    await expect(compileTextComponents([
      { kind: 'textBox', left: 0, top: 0, width: 200, height: 90, text: 'A', paragraphs: ['B'] },
    ], measure)).rejects.toThrow(/text or paragraphs/);
  });
});
