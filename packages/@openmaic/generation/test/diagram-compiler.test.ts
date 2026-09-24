import { describe, expect, it } from 'vitest';
import type { PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { compileDiagramComponent, compileMeasuredDiagramComponent, measureDiagramAllocations, type DiagramComponent } from '../src/diagram-compiler.js';

const cycle: DiagramComponent = {
  type: 'diagram', id: 'learning-cycle', topology: 'cycle',
  left: 50, top: 120, width: 900, height: 370,
  nodes: [
    { id: 'goal', label: '教学目标' },
    { id: 'start', label: '激活经验' },
    { id: 'teach', label: '新知讲解' },
    { id: 'show', label: '示范应用' },
    { id: 'practice', label: '强化练习' },
    { id: 'feedback', label: '即时反馈' },
    { id: 'adjust', label: '调整教学' },
  ],
  annotation: '闭环：依据反馈调整教学',
};

function absoluteStart(line: PPTLineElement): [number, number] {
  return [line.left + line.start[0], line.top + line.start[1]];
}

function absoluteEnd(line: PPTLineElement): [number, number] {
  return [line.left + line.end[0], line.top + line.end[1]];
}

function onBoundary(point: [number, number], node: PPTShapeElement): boolean {
  const [x, y] = point;
  const onVertical = Math.abs(x - node.left) < 0.01 || Math.abs(x - (node.left + node.width)) < 0.01;
  const onHorizontal = Math.abs(y - node.top) < 0.01 || Math.abs(y - (node.top + node.height)) < 0.01;
  return (onVertical && y >= node.top && y <= node.top + node.height)
    || (onHorizontal && x >= node.left && x <= node.left + node.width);
}

describe('compileDiagramComponent', () => {
  it('offers measured diagram rectangles before authoring instead of asking the model to guess capacity', async () => {
    const measure: import('../src/text-layout-compiler.js').TextMeasure = ({ text, fontSize, width, padding, lineHeight }) => {
      const perLine = Math.max(1, Math.floor((width - padding * 2) / fontSize));
      const lines = text.match(new RegExp(`.{1,${perLine}}`, 'gu')) ?? [];
      return { naturalWidth: [...text].length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
    };
    const plan = { topology: 'cycle' as const, nodes: ['目标分析', '情境创设', '资源设计', '自主学习', '协作环境', '效果评价', '强化练习'].map((label, i) => ({ id: String(i), label })), annotation: '强化练习的新问题回到目标分析，形成闭环。' };
    const choices = await measureDiagramAllocations(plan, measure);
    expect(choices.some((choice) => choice.width === 900)).toBe(true);
    expect(choices.some((choice) => choice.width <= 600)).toBe(true);
    for (const choice of choices) {
      const elements = await compileMeasuredDiagramComponent({ ...plan, ...choice, type: 'diagram', id: 'verified', left: 50, top: 140 }, measure);
      expect(elements.filter((element) => element.type === 'line')).toHaveLength(7);
    }
  });

  it('continues past an annotation that is taller than the first sequence candidate', async () => {
    const annotation = '四步的顺序不是为了走形式：先交代背景和目标，学生才知道要解决什么；先规划再动手，才能避免乱试；最后展示与评价既看作品质量，也看学习态度、合作与创新。';
    const measure: import('../src/text-layout-compiler.js').TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({
      naturalWidth: [...text].length * fontSize,
      height: text === annotation ? 128 : padding * 2 + fontSize * lineHeight,
      lines: [text],
    });
    const plan = { topology: 'sequence' as const, nodes: ['提出任务', '规划设计', '完成任务', '总结评价']
      .map((label, index) => ({ id: `t${index + 1}`, label })), annotation };
    const choices = await measureDiagramAllocations(plan, measure);
    expect(choices.some((choice) => choice.width === 900 && choice.height > 120)).toBe(true);
    for (const choice of choices) {
      const elements = await compileMeasuredDiagramComponent({ ...plan, ...choice,
        type: 'diagram', id: 'verified', left: 50, top: 140 }, measure);
      expect(elements.filter((element) => element.type === 'line')).toHaveLength(3);
      expect(elements.some((element) => element.id.endsWith('-annotation'))).toBe(true);
    }
  });

  it.each(['转化', '具体化', '依据实践逐步具体化'])('reserves measured connector space for sequence condition %s', (label) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'three-levels', topology: 'sequence',
      left: 50, top: 140, width: 900, height: 120,
      nodes: [{ id: 'theory', label: '教学理论' }, { id: 'model', label: '教学模式' }, { id: 'method', label: '教学方法' }],
      edges: [{ from: 'theory', to: 'model', label }, { from: 'model', to: 'method', label }] };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(labels).toHaveLength(2);
    for (const [index, text] of labels.entries()) {
      expect(text.left).toBeGreaterThan(nodes[index]!.left + nodes[index]!.width);
      expect(text.left + text.width).toBeLessThan(nodes[index + 1]!.left);
      expect(text.top).toBeGreaterThanOrEqual(diagram.top);
      expect(text.top + text.height).toBeLessThanOrEqual(diagram.top + diagram.height);
    }
    expect(() => compileDiagramComponent({ ...diagram, width: 440 })).toThrow(/sequence.*do not fit/);
    const vertical = compileDiagramComponent({ ...diagram, width: 300, height: 360 });
    const verticalNodes = vertical.filter((element): element is PPTShapeElement => element.type === 'shape');
    const verticalLabels = vertical.filter((element): element is PPTTextElement => element.type === 'text');
    for (const [index, text] of verticalLabels.entries()) {
      expect(text.top).toBeGreaterThan(verticalNodes[index]!.top + verticalNodes[index]!.height);
      expect(text.top + text.height).toBeLessThan(verticalNodes[index + 1]!.top);
    }
  });

  it('uses available edge-label space instead of rejecting a normal nine-character condition', () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'thermostat', topology: 'cycle', left: 50, top: 140, width: 900, height: 330,
      nodes: [{ id: 'measure', label: '测温' }, { id: 'compare', label: '比较' }, { id: 'heat', label: '加热' }, { id: 'change', label: '温度变化' }],
      edges: [{ from: 'compare', to: 'heat', label: '偏低接通，达到断开' }] };
    const elements = compileDiagramComponent(diagram);
    const label = elements.find((element) => element.type === 'text' && element.content.includes('偏低接通'))!;
    expect(label.width).toBeGreaterThan(150);
    expect(label.left).toBeGreaterThanOrEqual(diagram.left);
    expect(label.left + label.width).toBeLessThanOrEqual(diagram.left + diagram.width);
    expect(() => compileDiagramComponent({ ...diagram, edges: [{ from: 'compare', to: 'heat', label: '不应无限延长的条件'.repeat(20) }] })).toThrow(/edge label/);
  });

  it('makes a continuous seven-step editable cycle and keeps its explanation out of the steps', () => {
    const elements = compileDiagramComponent(cycle);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const notes = elements.filter((element): element is PPTTextElement => element.type === 'text');

    expect(nodes).toHaveLength(7);
    expect(lines).toHaveLength(7);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain('闭环');
    expect(nodes.some((node) => node.text?.content.includes('闭环'))).toBe(false);
    expect(lines.every((line) => line.points[1] === 'arrow' && line.cubic)).toBe(true);
    for (let index = 0; index < lines.length; index += 1) {
      expect(onBoundary(absoluteStart(lines[index]!), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), nodes[(index + 1) % nodes.length]!)).toBe(true);
    }
    const explanation = notes[0]!;
    expect(nodes.every((node) => explanation.left + explanation.width < node.left
      || node.left + node.width < explanation.left
      || explanation.top + explanation.height < node.top
      || node.top + node.height < explanation.top)).toBe(true);
  });

  it('places a long independent explanation across the full width outside the ring', () => {
    const annotation = '闭环说明：根据学习者在练习中的实际表现收集反馈，重新检查原有教学目标与活动设计，再依据证据调整后续教学安排。';
    const elements = compileDiagramComponent({ ...cycle, annotation });
    const note = elements.find((element) => element.id.endsWith('-annotation'))!;
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    expect(note.type).toBe('text');
    if (note.type !== 'text') return;
    expect(note.width).toBe(cycle.width);
    expect(note.content.replace(/<[^>]+>/g, '')).toBe(annotation);
    expect(nodes.every((node) => node.top >= note.top + note.height + 12)).toBe(true);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(7);
  });

  it.each([3, 4, 8])('closes a cycle with %i nodes', (count) => {
    const diagram: DiagramComponent = {
      ...cycle,
      annotation: undefined,
      nodes: Array.from({ length: count }, (_, index) => ({ id: `step-${index}`, label: `步骤${index + 1}` })),
    };
    const elements = compileDiagramComponent(diagram);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(count);
  });

  it('keeps a sequence and its one feedback edge topologically distinct', () => {
    const diagram: DiagramComponent = {
      type: 'diagram', id: 'lesson-flow', topology: 'sequence',
      left: 50, top: 140, width: 900, height: 320,
      nodes: [
        { id: 'goal', label: '确定目标' },
        { id: 'teach', label: '讲解新知' },
        { id: 'practice', label: '强化练习' },
        { id: 'review', label: '分析反馈' },
      ],
      edges: [{ from: 'review', to: 'goal', label: '调整' }],
      annotation: '根据学习证据调整教学',
    };
    const elements = compileDiagramComponent(diagram);
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3).every((line) => line.style === 'solid' && !line.cubic)).toBe(true);
    expect(lines[3]).toMatchObject({ style: 'dashed', points: ['', 'arrow'] });
    expect(lines[3]!.cubic).toHaveLength(2);
    expect(elements.filter((element) => element.type === 'text')).toHaveLength(2);
  });

  it('keeps labeled ring edges editable and uses a vertical sequence when width is constrained', () => {
    const labeledCycle = {
      ...cycle,
      edges: [{ from: 'goal', to: 'start', label: '进入' }],
    };
    const cycleElements = compileDiagramComponent(labeledCycle);
    expect(cycleElements.find((element) => element.id === 'learning-cycle-edge-label-0')).toMatchObject({ type: 'text' });

    const vertical: DiagramComponent = {
      type: 'diagram', id: 'vertical-flow', topology: 'sequence',
      left: 330, top: 50, width: 340, height: 450,
      nodes: [
        { id: 'observe', label: '观察' },
        { id: 'explain', label: '解释' },
        { id: 'apply', label: '应用' },
      ],
      edges: [{ from: 'apply', to: 'observe' }],
    };
    const verticalElements = compileDiagramComponent(vertical);
    const nodes = verticalElements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const edges = verticalElements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(nodes[0]!.top).toBeLessThan(nodes[1]!.top);
    expect(nodes[1]!.top).toBeLessThan(nodes[2]!.top);
    expect(edges[2]!.style).toBe('dashed');
    expect(edges[2]!.cubic).toHaveLength(2);
  });

  it('balances a long label and preserves escaped editable text', () => {
    const diagram = {
      ...cycle,
      nodes: cycle.nodes.map((node, index) => index === 0 ? { ...node, label: '显性线索识别能力' } : node),
    };
    const elements = compileDiagramComponent(diagram);
    const node = elements.find((element) => element.id === 'learning-cycle-node-goal') as PPTShapeElement;
    expect(node.text?.content).toMatch(/显性线索<br>识别能力/);
    const escaped = compileDiagramComponent({ ...diagram, nodes: [{ id: 'a', label: '<知识>' }, ...cycle.nodes.slice(1)] });
    expect((escaped.find((element) => element.id === 'learning-cycle-node-a') as PPTShapeElement).text?.content).toContain('&lt;知识&gt;');
  });

  it('fails explicitly for invalid relationships and impossible containers', () => {
    expect(() => compileDiagramComponent({ ...cycle, edges: [{ from: 'goal', to: 'practice' }] })).toThrow(/ordered ring/);
    expect(() => compileDiagramComponent({ ...cycle, width: 240, height: 100 })).toThrow(/cannot fit|overlap|do not fit/);
    expect(() => compileDiagramComponent({ ...cycle, nodes: [...cycle.nodes, { id: 'goal', label: 'duplicate' }] })).toThrow(/duplicate node/);
    expect(() => compileDiagramComponent({ ...cycle, nodes: [{ id: 'bad', label: '显性线索\n识别能力词' }, ...cycle.nodes.slice(1)], width: 450 })).toThrow();
  });
});
