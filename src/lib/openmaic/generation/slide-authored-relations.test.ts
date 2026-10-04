import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PPTElement, SlidePresentationItem } from '@openmaic/dsl';
import type { TextMeasure } from '@openmaic/generation';
import { layoutAuthoredRelations } from './slide-authored-relations';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

const items: SlidePresentationItem[] = [
  { id: 'root', label: '学习', text: '主动建构', sourceContentIds: ['source-learning'] },
  { id: 'evidence', label: '路径', text: '收集证据', sourceContentIds: ['source-path'] },
  { id: 'meaning', label: '目标', text: '理解意义', sourceContentIds: ['source-goal'] },
];
const links = [{ from: 'root', to: 'evidence' }, { from: 'root', to: 'meaning' }];
const rect = { left: 50, top: 150, width: 900, height: 350 };
const measure: TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({
  naturalWidth: Array.from(text).length * fontSize, height: fontSize * lineHeight + padding * 2, lines: [text],
});
const stripped = (element: PPTElement) => (element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '')
  .replace(/<[^>]*>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
afterAll(closeSpatialMeasurementBrowser);

describe('authored relation graphs', () => {
  it('gives the fish-and-frog relation a readable caption instead of a tall narrow strip', async () => {
    const observation = [
      { id: 'description', label: '青蛙的描述', text: '“牛”头上有两只角、四条腿、吃草，身上有花斑', sourceContentIds: ['case-description'] },
      { id: 'imagination', label: '小鱼的想象', text: '仍基于鱼的形态想象“牛”', sourceContentIds: ['case-imagination'] },
    ];
    const result = await layoutAuthoredRelations({ items: observation, links: [{ from: 'description', to: 'imagination', label: '经原有经验解释' }],
      rect, font: 18, measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    const caption = result!.elements.find((element) => element.type === 'text')!;
    expect(stripped(caption)).toBe('经原有经验解释');
    if (caption.type === 'text') {
      expect(caption.width).toBeGreaterThanOrEqual(180);
      expect(caption.height).toBeLessThan(caption.width);
      expect(caption.content).toContain('font-size:20px');
    }
    for (const node of result!.elements.filter((element) => element.type === 'shape')) {
      expect(node.width).toBeGreaterThanOrEqual(260);
      expect(stripped(node)).not.toMatch(/(?:青蛙的描述|小鱼的想象)：/u);
    }
    expect(result!.elements.filter((element) => element.type === 'line')).toHaveLength(1);
  }, 30_000);

  it('renders exactly the authored fork without adding sibling adjacency and maps every full statement', async () => {
    const original = structuredClone({ items, links });
    const result = await layoutAuthoredRelations({ ...original, rect, font: 20, measure });
    expect(result).not.toBeNull();
    expect(original).toEqual({ items, links });
    expect(result!.elements.filter((element) => element.type === 'line')).toHaveLength(2);
    const nodes = result!.elements.filter((element) => element.type === 'shape');
    expect(nodes).toHaveLength(3);
    expect(result!.boxes.size).toBe(3);
    for (const item of items) {
      const id = `infographic-authored-relations-node-${item.id}`;
      const element = nodes.find((node) => node.id === id)!;
      expect(stripped(element)).toBe(`${item.label}${item.text}`);
      expect(result!.mapping[item.sourceContentIds[0]!]).toEqual([id]);
    }
    expect(nodes.find((node) => node.id.endsWith('-root'))!.fill).toBe('#EFF6FF');
    expect(nodes.find((node) => node.id.endsWith('-root'))!.text?.defaultColor).toBe('#334155');
    expect(nodes.find((node) => node.id.endsWith('-root'))!.text?.content).not.toMatch(/(?:^|[;"\s])color\s*:/u);
    expect(nodes.find((node) => node.id.endsWith('-meaning'))!.fill).toBe('#FFF7ED');
  });

  it('preserves explicit edge labels as editable text and introduces no extra facts', async () => {
    const labeled = [{ from: 'root', to: 'evidence', label: '通过' }];
    const result = await layoutAuthoredRelations({ items: items.slice(0, 2), links: labeled, rect, font: 20, measure });
    expect(result).not.toBeNull();
    expect(result!.elements.filter((element) => element.type === 'line')).toHaveLength(1);
    expect(result!.elements.filter((element) => element.type === 'text').map(stripped)).toEqual(['通过']);
  });

  it('rejects absent endpoints, unused statements, duplicate edges, cycles and independent roots before measurement', async () => {
    const spy = vi.fn(measure);
    for (const invalid of [
      [{ from: 'root', to: 'missing' }],
      [{ from: 'root', to: 'evidence' }],
      [...links, links[0]!],
      [...links, { from: 'meaning', to: 'root' }],
      [{ from: 'root', to: 'meaning' }, { from: 'evidence', to: 'meaning' }],
    ]) expect(await layoutAuthoredRelations({ items, links: invalid, rect, font: 20, measure: spy })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('retains a real skip-level link in a DAG rather than converting it to a sequence', async () => {
    const dag = [...links, { from: 'evidence', to: 'meaning' }];
    const result = await layoutAuthoredRelations({ items, links: dag, rect, font: 20, measure });
    expect(result).not.toBeNull();
    expect(result!.elements.filter((element) => element.type === 'line')).toHaveLength(3);
  });

  it('measures the native node font and keeps graph geometry inside the supplied rectangle', async () => {
    const spy = vi.fn(measureAuthoredSlideText);
    const result = await layoutAuthoredRelations({ items, links, rect, font: 18, measure: spy });
    expect(result).not.toBeNull();
    expect(spy.mock.calls.every(([request]) => request.fontSize === 20)).toBe(true);
    for (const element of result!.elements) {
      expect(element.left).toBeGreaterThanOrEqual(rect.left);
      expect(element.top).toBeGreaterThanOrEqual(rect.top);
      if (element.type === 'line') {
        for (const point of [element.start, element.end, ...(element.cubic ?? [])]) {
          expect(element.left + point[0]).toBeLessThanOrEqual(rect.left + rect.width);
          expect(element.top + point[1]).toBeLessThanOrEqual(rect.top + rect.height);
        }
      } else {
        expect(element.left + element.width).toBeLessThanOrEqual(rect.left + rect.width);
        expect(element.top + element.height).toBeLessThanOrEqual(rect.top + rect.height);
        if (element.type === 'shape') expect(element.text?.content).toContain('font-size:20px');
      }
    }
    expect(result!.height).toBeLessThanOrEqual(rect.height);
  }, 30_000);

  it('returns null on actual capacity failure without using the unverified fallback renderer', async () => {
    expect(await layoutAuthoredRelations({ items, links, rect: { ...rect, height: 40 }, font: 20, measure })).toBeNull();
    const long = items.map((item) => ({ ...item, text: item.text.repeat(40) }));
    expect(await layoutAuthoredRelations({ items: long, links, rect, font: 20, measure })).toBeNull();
    const spy = vi.fn(measure);
    expect(await layoutAuthoredRelations({ items, links, rect, font: 24, measure: spy })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('propagates measurement infrastructure failures and invalid geometry', async () => {
    await expect(layoutAuthoredRelations({ items, links, rect, font: 20, measure: () => { throw new Error('browser unavailable'); } })).rejects.toThrow('browser unavailable');
    await expect(layoutAuthoredRelations({ items, links, rect, font: 20, measure: () => ({ height: 20, naturalWidth: NaN, lines: [] }) })).rejects.toThrow('invalid geometry');
  });
});
