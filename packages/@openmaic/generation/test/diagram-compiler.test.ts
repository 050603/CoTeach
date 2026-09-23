import { describe, expect, it } from 'vitest';
import type { PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { compileDiagramComponent, type DiagramComponent } from '../src/diagram-compiler.js';

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
      left: 330, top: 30, width: 340, height: 500,
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
