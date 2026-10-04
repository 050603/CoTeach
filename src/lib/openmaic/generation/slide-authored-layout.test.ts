import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PPTElement, SlidePresentationDesign, SlidePresentationItem } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import { layoutAuthoredGroups } from './slide-authored-layout';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { nativeSlideCollisions } from '../../../../packages/@openmaic/generation/src/native-slide-collision';

const items: SlidePresentationItem[] = [
  { id: 'question', label: '提出问题', text: '从现象提出可研究的问题。', emphasis: ['问题'], sourceContentIds: ['source-question'] },
  { id: 'evidence', label: '收集证据', text: '观察与实验提供证据。', sourceContentIds: ['source-reasoning'] },
  { id: 'conclusion', label: '形成解释', text: '依据证据论证，明确结论的适用条件。', sourceContentIds: ['source-reasoning'] },
];
const design: SlidePresentationDesign = { flow: 'rows', align: 'start', gap: 24, groups: [
  { id: 'focus', itemIds: ['question'], treatment: 'accent', span: 4 },
  { id: 'reasoning', itemIds: ['evidence', 'conclusion'], treatment: 'plain', span: 8, columns: 2 },
] };
const rect = { left: 50, top: 120, width: 900, height: 390 };
const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const length = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const lines = text.match(new RegExp(`.{1,${length}}`, 'gu')) ?? [''];
  return { naturalWidth: text.length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
};
const stripped = (element: PPTElement) => element.type === 'text' ? element.content.replace(/<[^>]*>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&') : '';
afterAll(closeSpatialMeasurementBrowser);

describe('authored composition primitives', () => {
  it('honors arbitrary group proportions and internal columns while preserving all source text', async () => {
    const original = structuredClone({ items, design });
    const result = await layoutAuthoredGroups({ ...original, rect, font: 20, measure });
    expect(result).not.toBeNull();
    expect(original).toEqual({ items, design });
    const focus = result!.elements.find((element) => element.id === 'infographic-authored-group-focus')!;
    expect(focus.width).toBeCloseTo((rect.width - design.gap) / 3);
    expect(result!.boxes.get('evidence')!.left).toBeCloseTo(rect.left + focus.width + design.gap);
    expect(result!.boxes.get('conclusion')!.left).toBeGreaterThan(result!.boxes.get('evidence')!.left);
    expect(result!.boxes.get('conclusion')!.top).toBe(result!.boxes.get('evidence')!.top);
    for (const item of items) {
      const ids = result!.mapping[item.sourceContentIds[0]!]!;
      const visible = result!.elements.filter((element) => ids.includes(element.id)).map(stripped).join('');
      expect(visible).toContain(item.label);
      expect(visible).toContain(item.text);
      expect(ids.every((id) => result!.elements.find((element) => element.id === id)?.type === 'text')).toBe(true);
    }
    expect(result!.elements.filter((element) => element.type === 'shape')).toHaveLength(1);
    expect(result!.elements.every((element) => element.id.startsWith('infographic-authored-'))).toBe(true);
    expect(nativeSlideCollisions(result!.elements)).toEqual([]);
  });

  it('stacks authored groups by measured heights and honors group order without extra numbering', async () => {
    const stacked: SlidePresentationDesign = { ...design, flow: 'columns', groups: [
      { id: 'comparison', itemIds: ['conclusion', 'evidence'], treatment: 'panel', span: 5, columns: 2 },
      { id: 'focus', itemIds: ['question'], treatment: 'plain', span: 7 },
    ] };
    const result = await layoutAuthoredGroups({ items, design: stacked, rect, font: 20, measure });
    expect(result).not.toBeNull();
    const panel = result!.elements.find((element) => element.type === 'shape')!;
    expect(result!.boxes.get('question')!.top).toBe(panel.top + panel.height + stacked.gap);
    expect(result!.boxes.get('conclusion')!.left).toBeLessThan(result!.boxes.get('evidence')!.left);
    expect(result!.height).toBe(result!.boxes.get('question')!.top + result!.boxes.get('question')!.height - rect.top);
    expect(result!.elements.filter((element) => element.type === 'text').map(stripped)).toEqual([
      items[2]!.label, items[2]!.text, items[1]!.label, items[1]!.text, items[0]!.label, items[0]!.text,
    ]);
  });

  it('rejects missing, duplicate and unknown items before starting measurement', async () => {
    const spy = vi.fn(measure);
    for (const groups of [
      [{ ...design.groups[0]!, itemIds: ['question', 'evidence'] }],
      [{ ...design.groups[0]!, itemIds: ['question', 'evidence', 'conclusion', 'question'] }],
      [{ ...design.groups[0]!, itemIds: ['question', 'evidence', 'conclusion', 'invented'] }],
      [{ ...design.groups[0]!, itemIds: ['question'] }, { ...design.groups[0]!, itemIds: ['evidence', 'conclusion'] }],
    ]) expect(await layoutAuthoredGroups({ items, design: { ...design, groups }, rect, font: 20, measure: spy })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid design values and widths below the minimum instead of changing the authored design', async () => {
    for (const patch of [{ gap: 15 }, { gap: 41 }, { groups: [{ ...design.groups[0]!, span: 0 }] },
      { groups: [{ ...design.groups[0]!, span: 13 }] }]) {
      expect(await layoutAuthoredGroups({ items, design: { ...design, ...patch }, rect, font: 20, measure })).toBeNull();
    }
    const narrow: SlidePresentationDesign = { ...design, groups: [{ id: 'all', itemIds: items.map((item) => item.id), treatment: 'panel', span: 12, columns: 3 }] };
    expect(await layoutAuthoredGroups({ items, design: narrow, rect: { ...rect, width: 400 }, font: 20, measure })).toBeNull();
  });

  it('declines overflow without shrinking fonts, truncating statements or mutating inputs', async () => {
    const spy = vi.fn(measure), original = structuredClone({ items, design });
    expect(await layoutAuthoredGroups({ ...original, rect: { ...rect, height: 40 }, font: 24, measure: spy })).toBeNull();
    expect(spy.mock.calls.every(([input]) => input.fontSize === 24)).toBe(true);
    expect(original).toEqual({ items, design });
  });

  it('fits a measured compact composition by keeping labels inline without losing wording or emphasis', async () => {
    const original = structuredClone({ items, design });
    const spacious = await layoutAuthoredGroups({ items, design, rect, font: 20, measure: measureAuthoredSlideText });
    expect(spacious).not.toBeNull();
    const height = spacious!.height - 20, spy = vi.fn(measureAuthoredSlideText);
    const compact = await layoutAuthoredGroups({ items, design, rect: { ...rect, height }, font: 20, measure: spy });
    expect(compact).not.toBeNull();
    expect(compact!.height).toBeLessThanOrEqual(height);
    expect(compact!.elements.some((element) => element.id.startsWith('infographic-authored-heading-'))).toBe(false);
    const focus = compact!.elements.find((element) => element.id === 'infographic-authored-group-focus')!;
    expect(focus.width).toBeCloseTo((rect.width - design.gap) / 3);
    for (const item of items) {
      const body = compact!.elements.find((element) => element.id === `infographic-authored-body-${item.id}`)!;
      expect(stripped(body)).toBe(`${item.label}：${item.text}`);
      expect(compact!.mapping[item.sourceContentIds[0]!]!).toContain(body.id);
      if (body.type === 'text') expect(body.content).toContain('font-size:20px');
    }
    expect(spy.mock.calls.every(([request]) => request.fontSize >= 20)).toBe(true);
    expect(spy.mock.calls.some(([request]) => request.text === `${items[0]!.label}：${items[0]!.text}`
      && request.html.includes('<strong style="font-size:20px') && request.html.includes('<strong style="color:#C2410C;white-space:nowrap">问题</strong>'))).toBe(true);
    expect(nativeSlideCollisions(compact!.elements)).toEqual([]);
    expect({ items, design }).toEqual(original);
    expect(await layoutAuthoredGroups({ items, design, rect: { ...rect, height: 40 }, font: 20, measure: measureAuthoredSlideText })).toBeNull();
  }, 30_000);

  it('bounds spacing adjustments while preserving group membership, proportions and column counts', async () => {
    const narrow: SlidePresentationDesign = { flow: 'rows', align: 'start', gap: 40,
      groups: items.map((item) => ({ id: item.id, itemIds: [item.id], span: 1, treatment: 'panel', columns: 1 })) };
    const original = structuredClone(narrow);
    // A previously accepted ~150px prose column must now be declined, even
    // when it is tall enough. Spacing can only recover readable-width columns.
    expect(await layoutAuthoredGroups({ items, design: narrow, rect: { ...rect, width: 532 }, font: 20, measure })).toBeNull();
    const result = await layoutAuthoredGroups({ items, design: narrow, rect, font: 20, measure });
    expect(result).not.toBeNull();
    const panels = result!.elements.filter((element) => element.type === 'shape');
    expect(panels).toHaveLength(3);
    for (const [index, panel] of panels.entries()) {
      expect(panel.width).toBeCloseTo((rect.width - 2 * 16) / 3);
      expect(result!.boxes.get(items[index]!.id)!.left).toBeCloseTo(panel.left + 10);
      expect(result!.boxes.get(items[index]!.id)!.width).toBeGreaterThanOrEqual(260);
    }
    expect(narrow).toEqual(original);
  });

  it('measures the same centered dark text with selective warm emphasis on a pale accent background', async () => {
    const spy = vi.fn(measureAuthoredSlideText), centered: SlidePresentationDesign = { ...design, align: 'center' };
    const result = await layoutAuthoredGroups({ items, design: centered, rect, font: 20, measure: spy });
    expect(result).not.toBeNull();
    expect(spy.mock.calls.every(([input]) => input.align === 'center' && input.html.includes('text-align:center')
      && input.fontFamily === 'Noto Sans SC' && input.padding === 10 && input.lineHeight === 1.5
      && input.paragraphSpace === 5 && input.preserveRichText)).toBe(true);
    const highlighted = result!.elements.find((element) => element.id === 'infographic-authored-body-question');
    expect(highlighted?.type).toBe('text');
    if (highlighted?.type === 'text') {
      expect(highlighted.defaultColor).toBe('#334155');
      expect(highlighted.content).toContain('<strong style="color:#C2410C;white-space:nowrap">问题</strong>');
    }
    for (const element of result!.elements) {
      if (element.type === 'line') continue;
      expect(element.left).toBeGreaterThanOrEqual(rect.left);
      expect(element.left + element.width).toBeLessThanOrEqual(rect.left + rect.width + 0.01);
      expect(element.top + element.height).toBeLessThanOrEqual(rect.top + rect.height);
    }
    expect(nativeSlideCollisions(result!.elements)).toEqual([]);
  }, 30_000);

  it('escapes authored HTML and keeps IDs collision-free when input names resemble generated IDs', async () => {
    const special = [{ ...items[0]!, id: 'same', label: '<观察>', text: '条件 A < B & C > D' },
      { ...items[1]!, id: 'same-heading' }];
    const simple: SlidePresentationDesign = { flow: 'columns', align: 'start', gap: 20,
      groups: [{ id: 'same', itemIds: special.map((item) => item.id), treatment: 'plain', span: 1 }] };
    const result = await layoutAuthoredGroups({ items: special, design: simple, rect, font: 20, measure });
    expect(result).not.toBeNull();
    expect(new Set(result!.elements.map((element) => element.id)).size).toBe(result!.elements.length);
    expect(result!.elements.map(stripped).join('')).toContain(special[0]!.text);
    expect(result!.elements.map(stripped).join('')).toContain(special[0]!.label);
  });

  it('propagates browser failures and rejects invalid measurement geometry', async () => {
    await expect(layoutAuthoredGroups({ items, design, rect, font: 20, measure: () => { throw new Error('font browser unavailable'); } })).rejects.toThrow('font browser unavailable');
    await expect(layoutAuthoredGroups({ items, design, rect, font: 20, measure: () => ({ height: NaN, naturalWidth: 10, lines: [] }) })).rejects.toThrow('invalid geometry');
  });
});
