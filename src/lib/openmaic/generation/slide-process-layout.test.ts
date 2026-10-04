import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PPTElement, PPTTextElement, SlidePresentationItem } from '@openmaic/dsl';
import type { DiagramPlan, TextMeasure } from '@openmaic/generation';
import { layoutTeachingSequence } from './slide-process-layout';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

const labels = ['创设情境', '进行“抛锚”', '自主探索', '拓展延伸', '讨论交流', '效果评价'];
const explanations = ['用信息技术创设接近现实的学习情境。', '选择真实且有挑战性的中心问题。', '学生探索并制定方案，教师提供线索。', '围绕“锚”设计相关拓展问题。', '围绕问题共享观点，相互启发。', '评价学习过程，记录反思并调整教学。'];
const diagram: DiagramPlan = { topology: 'sequence', nodes: labels.map((label, index) => ({ id: `step-${index}`, label })) };
const items: (SlidePresentationItem & { diagramNodeId?: string })[] = labels.map((label, index) => ({
  id: `item-${index}`, label, text: explanations[index]!, sourceContentIds: [`source-${index}`], diagramNodeId: `step-${index}`,
}));
const rect = { left: 50, top: 140, width: 900, height: 370 };
const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const glyphWidth = /^\d+$/u.test(text) ? fontSize * 0.55 : fontSize;
  const length = Math.max(1, Math.floor((width - padding * 2) / glyphWidth));
  const lines = text.match(new RegExp(`.{1,${length}}`, 'gu')) ?? [''];
  return { naturalWidth: text.length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
};
const stripped = (element: PPTElement) => element.type === 'text' ? element.content.replace(/<[^>]*>/gu, '') : '';
afterAll(closeSpatialMeasurementBrowser);

describe('integrated teaching sequence', () => {
  it('places all six explanations beside their own steps with a consistent reading direction and routed row returns', async () => {
    const input = structuredClone({ diagram, items });
    const result = await layoutTeachingSequence({ ...input, measure, font: 18, rect });
    expect(result).not.toBeNull();
    expect(input).toEqual({ diagram, items });
    const nodes = diagram.nodes.map((node) => result!.elements.find((element) => element.id === `infographic-diagram-node-${node.id}`) as PPTTextElement);
    expect(nodes[0]!.left).toBeLessThan(nodes[1]!.left);
    expect(nodes[1]!.left).toBeLessThan(nodes[2]!.left);
    expect(nodes[3]!.left).toBe(nodes[0]!.left);
    expect(nodes[3]!.left).toBeLessThan(nodes[4]!.left);
    expect(nodes[4]!.left).toBeLessThan(nodes[5]!.left);
    expect(nodes[0]!.top).toBe(nodes[2]!.top);
    expect(nodes[3]!.top).toBeGreaterThan(nodes[0]!.top);
    const lines = result!.elements.filter((element) => element.type === 'line');
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => {
      const points = [line.start, ...(line.broken ? [line.broken] : []), ...(line.broken2 ? [line.broken2] : []), line.end];
      return points.slice(1).every((point, index) => point[0] === points[index]![0] || point[1] === points[index]![1]);
    })).toBe(true);
    for (const [index, item] of items.entries()) {
      const mapped = result!.mapping[item.sourceContentIds[0]!]!;
      expect(mapped).toContain(nodes[index]!.id);
      expect(mapped).toContain(item.id);
      const body = result!.elements.find((element) => element.id === item.id)!;
      expect(stripped(body)).toContain(item.text);
      expect(body.top).toBeGreaterThan(nodes[index]!.top);
      expect(result!.mapping[`diagram-node:step-${index}`]).toContain(nodes[index]!.id);
    }
    expect(result!.elements.filter((element) => element.type === 'shape').every((shape) => shape.height === 1)).toBe(true);
  });

  it('preserves edge labels and rejects labels that cannot fit without shrinking', async () => {
    const shortDiagram = { ...diagram, nodes: diagram.nodes.slice(0, 2), edges: [{ from: 'step-0', to: 'step-1', label: '然后' }] };
    const result = await layoutTeachingSequence({ diagram: shortDiagram, items: items.slice(0, 2), measure, font: 18, rect });
    expect(result?.elements.some((element) => stripped(element) === '然后')).toBe(true);
    expect(await layoutTeachingSequence({ diagram: { ...shortDiagram, edges: [{ from: 'step-0', to: 'step-1', label: '无法容纳的必要边标签'.repeat(100) }] },
      items: items.slice(0, 2), measure, font: 18, rect })).toBeNull();
  });

  it('keeps original numbered titles once without adding a second step number', async () => {
    const numbered = { ...diagram, nodes: diagram.nodes.map((node, index) => ({ ...node, label: `${index + 1} ${node.label}` })) };
    const numberedItems = items.map((item, index) => ({ ...item, label: numbered.nodes[index]!.label }));
    const result = await layoutTeachingSequence({ diagram: numbered, items: numberedItems, measure, font: 18, rect });
    expect(result).not.toBeNull();
    expect(result!.elements.filter((element) => /^infographic-step-step-/u.test(element.id))).toHaveLength(0);
    for (const [index, node] of numbered.nodes.entries()) {
      const heading = result!.elements.find((element) => element.id === `infographic-diagram-node-${node.id}`)!;
      const body = result!.elements.find((element) => element.id === numberedItems[index]!.id)!;
      expect(stripped(heading)).toBe(node.label);
      expect(heading.left).toBe(body.left);
      expect(stripped(body)).toBe(numberedItems[index]!.text);
      expect(result!.mapping[`diagram-node:${node.id}`]).toContain(heading.id);
      expect(result!.mapping[`source-${index}`]).toContain(heading.id);
    }
  });

  it('preserves the sequence adjacency contract when only one transition has a label', async () => {
    const result = await layoutTeachingSequence({ diagram: { ...diagram, nodes: diagram.nodes.slice(0, 3),
      edges: [{ from: 'step-0', to: 'step-1', label: '然后' }] }, items: items.slice(0, 3), measure, font: 18, rect });
    expect(result).not.toBeNull();
    expect(result!.elements.filter((element) => element.type === 'line')).toHaveLength(2);
    expect(result!.elements.some((element) => stripped(element) === '然后')).toBe(true);
  });

  it('never joins independent chains, removes feedback, or reorders a branch', async () => {
    for (const patch of [
      { sequenceGroups: [{ id: 'a', nodeIds: ['step-0', 'step-1', 'step-2'] }, { id: 'b', nodeIds: ['step-3', 'step-4', 'step-5'] }] },
      { edges: [{ from: 'step-0', to: 'step-1' }, { from: 'step-2', to: 'step-3' }, { from: 'step-4', to: 'step-5' }] },
      { edges: [{ from: 'step-5', to: 'step-0', label: '反馈' }] },
      { edges: [{ from: 'step-0', to: 'step-2' }] },
      { topology: 'branch' as const },
    ]) expect(await layoutTeachingSequence({ diagram: { ...diagram, ...patch }, items, measure, font: 18, rect })).toBeNull();
  });

  it('matches stable IDs and legacy numbered labels, retaining all item labels', async () => {
    const input = [{ ...items[0]!, label: '教师的引导' }, { ...items[1]!, diagramNodeId: undefined, label: '2 进行“抛锚”' }];
    const result = await layoutTeachingSequence({ diagram: { ...diagram, nodes: diagram.nodes.slice(0, 2) }, items: input, measure, font: 18, rect });
    expect(result!.mapping[input[0]!.sourceContentIds[0]!]!.map((id) => stripped(result!.elements.find((element) => element.id === id)!)).join('')).toContain('教师的引导');
    const second = result!.elements.find((element) => element.id === input[1]!.id)!;
    expect(stripped(second)).toBe(input[1]!.text);
    expect(await layoutTeachingSequence({ diagram, items: [{ ...items[0]!, diagramNodeId: 'missing' }], measure, font: 18, rect })).toBeNull();
  });

  it('declines capacity overflow, preserves font sizes, and supports seven short steps', async () => {
    expect(await layoutTeachingSequence({ diagram, items, measure, font: 18, rect: { ...rect, height: 80 } })).toBeNull();
    const seven = { ...diagram, nodes: [...diagram.nodes, { id: 'step-6', label: '总结' }] };
    const result = await layoutTeachingSequence({ diagram: seven, items: [], measure, font: 18, rect });
    expect(result?.elements.filter((element) => element.id.startsWith('infographic-diagram-node-'))).toHaveLength(7);
  });

  it('uses renderer typography for actual rich text and propagates infrastructure failures', async () => {
    const spy = vi.fn(measureAuthoredSlideText);
    const result = await layoutTeachingSequence({ diagram, items: items.map((item) => ({ ...item, emphasis: ['学习'] })), measure: spy, font: 18, rect });
    expect(result).not.toBeNull();
    expect(spy.mock.calls.every(([input]) => input.fontFamily === 'Noto Sans SC' && input.padding === 10
      && input.lineHeight === 1.5 && input.paragraphSpace === 5 && input.preserveRichText)).toBe(true);
    expect(spy.mock.calls.some(([input]) => input.html.includes('<strong'))).toBe(true);
    for (const element of result!.elements) {
      if (element.type === 'line') continue;
      expect(element.left).toBeGreaterThanOrEqual(rect.left);
      expect(element.left + element.width).toBeLessThanOrEqual(rect.left + rect.width + 0.01);
      expect(element.top + element.height).toBeLessThanOrEqual(rect.top + rect.height);
    }
    await expect(layoutTeachingSequence({ diagram, items, font: 18, rect, measure: () => { throw new Error('browser unavailable'); } })).rejects.toThrow('browser unavailable');
    await expect(layoutTeachingSequence({ diagram, items, font: 18, rect, measure: () => ({ height: NaN, naturalWidth: 10, lines: [] }) })).rejects.toThrow('invalid geometry');
  }, 30_000);
});
