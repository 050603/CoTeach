import { describe, expect, it } from 'vitest';
import type { PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { compileDiagramComponent, compileMeasuredDiagramComponent, measureDiagramAllocations, resolveDiagramSequenceGroups, normalizeDiagramComponent, isDiagramComponent, DiagramAllocationError, type DiagramComponent } from '../src/diagram-compiler.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';

const fontMeasure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const count = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const lines = text.match(new RegExp(`.{1,${count}}`, 'gu')) ?? [];
  return { naturalWidth: [...text].length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
};

const fullStepNames = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计',
  '协作学习环境设计', '学习效果评价设计', '强化练习设计'];

const parallelSequences: DiagramComponent = {
  type: 'diagram', id: 'parallel-flows', topology: 'sequence', left: 50, top: 140, width: 900, height: 360,
  nodes: [
    ...['回顾旧知', '提问与讨论', '实践与探究', '辩证思考与讨论', '课堂小结'].map((label, i) => ({ id: `a${i + 1}`, label })),
    ...['提出问题', '任务分析', '任务分解与程序搭建', '反思总结'].map((label, i) => ({ id: `b${i + 1}`, label })),
  ],
  edges: [{ from: 'a1', to: 'a2' }, { from: 'a2', to: 'a3' }, { from: 'a3', to: 'a4' }, { from: 'a4', to: 'a5' },
    { from: 'b1', to: 'b2' }, { from: 'b2', to: 'b3' }, { from: 'b3', to: 'b4' }],
  annotation: '第一类用于介绍新概念，共五步；第二类用于综合项目实现，共四步。',
};

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

const branch: DiagramComponent = {
  type: 'diagram', id: 'visualization-options', topology: 'branch',
  left: 50, top: 120, width: 900, height: 360,
  nodes: [
    { id: 'n1', label: '确定核心关系' },
    { id: 'n2', label: '正反例对比' },
    { id: 'n3', label: '演示动画' },
    { id: 'n4', label: '具身体验' },
  ],
  edges: [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }, { from: 'n1', to: 'n4' }],
  annotation: '先确定核心关系，再根据内容和学段选择一种或多种呈现方式。',
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
  it('normalizes a kind diagram without changing its graph, styling or authored allocation', () => {
    const { type: _type, ...plan } = branch;
    expect(_type).toBe('diagram');
    const authored = Object.freeze({ ...plan, kind: 'diagram', accentColor: '#1E3A8A' });
    const normalized = normalizeDiagramComponent(authored);
    expect(authored).not.toHaveProperty('type');
    expect(isDiagramComponent(normalized)).toBe(true);
    if (!isDiagramComponent(normalized)) throw new Error('expected canonical diagram');
    expect(normalized).toMatchObject({ ...authored, type: 'diagram' });
    expect(normalized.nodes).toBe(authored.nodes);
    expect(normalized.edges).toBe(authored.edges);
    expect(compileDiagramComponent(normalized)).toEqual(compileDiagramComponent({ ...branch, accentColor: '#1E3A8A' }));
  });

  it.each([{ type: 'text', kind: 'diagram' }, { type: 'diagram', kind: 'textBox' }])(
    'rejects conflicting diagram discriminators rather than hiding or reclassifying a component', (tags) => {
      expect(() => normalizeDiagramComponent({ ...branch, ...tags })).toThrow(/type and kind must not conflict/);
    });

  it('keeps two complete explicit sequences independent without inventing a connecting edge', async () => {
    const groups = resolveDiagramSequenceGroups(parallelSequences);
    expect(groups?.map((group) => group.nodeIds)).toEqual([['a1', 'a2', 'a3', 'a4', 'a5'], ['b1', 'b2', 'b3', 'b4']]);
    const choices = await measureDiagramAllocations(parallelSequences, fontMeasure);
    const choice = choices.find((allocation) => allocation.width === 900)!;
    const elements = await compileMeasuredDiagramComponent({ ...parallelSequences, ...choice }, fontMeasure);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const edges = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(parallelSequences.nodes.map((node) => node.label));
    expect(nodes.every((node) => node.text?.content.includes('font-size:20px'))).toBe(true);
    expect(edges).toHaveLength(parallelSequences.edges!.length);
    for (const [index, edge] of parallelSequences.edges!.entries()) {
      const from = nodes.find((node) => node.id.endsWith(`-node-${edge.from}`))!;
      const to = nodes.find((node) => node.id.endsWith(`-node-${edge.to}`))!;
      expect(onBoundary(absoluteStart(edges[index]!), from)).toBe(true);
      expect(onBoundary(absoluteEnd(edges[index]!), to)).toBe(true);
    }
    expect(Math.max(...nodes.slice(0, 5).map((node) => node.top + node.height)))
      .toBeLessThan(Math.min(...nodes.slice(5).map((node) => node.top)));
  });

  it('strictly checks explicit sequence membership, order and complete within-group edges', () => {
    const sequenceGroups = resolveDiagramSequenceGroups(parallelSequences)!;
    const plan = { ...parallelSequences, annotation: undefined, sequenceGroups };
    expect(() => compileDiagramComponent(plan)).not.toThrow();
    expect(() => compileDiagramComponent({ ...plan, edges: [...plan.edges!, { from: 'a5', to: 'b1' }] })).toThrow(/cross-group/);
    expect(() => compileDiagramComponent({ ...plan, edges: plan.edges!.slice(1) })).toThrow(/every consecutive edge/);
    expect(() => compileDiagramComponent({ ...plan, sequenceGroups: sequenceGroups.slice(0, 1) })).toThrow(/cover every/);
    expect(() => compileDiagramComponent({ ...plan, sequenceGroups: [{ ...sequenceGroups[0]!, nodeIds: ['a2', 'a1', 'a3', 'a4', 'a5'] }, sequenceGroups[1]!] })).toThrow(/preserve node order/);
    expect(() => compileDiagramComponent({ ...plan, sequenceGroups: [sequenceGroups[0]!, { ...sequenceGroups[1]!, nodeIds: ['a5', ...sequenceGroups[1]!.nodeIds] }] })).toThrow(/exactly once/);
    const labelled = compileDiagramComponent({ ...plan, sequenceGroups: sequenceGroups.map((group, i) => ({ ...group, label: `流程${i + 1}` })) });
    expect(labelled.filter((element) => element.type === 'text')).toHaveLength(2);
  });

  it('retains implicit adjacency for old partial edge labels and single-chain feedback', () => {
    const partial = { ...parallelSequences, annotation: undefined, edges: [{ from: 'a1', to: 'a2', label: '回顾' }] };
    expect(resolveDiagramSequenceGroups(partial)).toBeUndefined();
    const elements = compileDiagramComponent({ ...partial, height: 360 });
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(partial.nodes.length - 1);
    expect(resolveDiagramSequenceGroups({ ...parallelSequences, edges: [{ from: 'b4', to: 'a1', label: '反馈' }] })).toBeUndefined();
  });

  it('uses the exact remaining safe height and reports actionable full-plan allocations', async () => {
    const plan = { topology: 'sequence' as const, nodes: fullStepNames.map((label, i) => ({ id: `s${i}`, label })), annotation: '完整映射说明' };
    const measure: TextMeasure = (input) => input.text === plan.annotation
      ? { naturalWidth: 200, height: 152, lines: [input.text] } : fontMeasure(input);
    const choices = await measureDiagramAllocations(plan, measure);
    expect(choices).toContainEqual({ width: 900, height: 372.5 });
    const elements = await compileMeasuredDiagramComponent({ ...plan, ...choices[0]!, type: 'diagram', id: 'safe-height', left: 50, top: 140 }, measure);
    expect(elements.filter((element) => element.type === 'shape')).toHaveLength(7);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    const authored = { ...plan, type: 'diagram' as const, id: 'too-small', left: 50, top: 272, width: 900, height: 240 };
    await expect(compileMeasuredDiagramComponent(authored, measure, { feasibleAllocations: choices })).rejects.toMatchObject({
      name: 'DiagramAllocationError', code: 'diagram-allocation', authoredAllocation: { left: 50, top: 272, width: 900, height: 240 }, feasibleAllocations: choices,
      message: expect.stringContaining('900×372.5px'),
    });
    await expect(measureDiagramAllocations(plan, measure, { maxHeight: 360 })).rejects.toMatchObject({
      availableArea: { left: 50, top: 140, width: 900, height: 360 }, feasibleAllocations: [],
    });
  });

  it('measures exact custom region widths while rejecting space outside the real safe area', async () => {
    const plan = { topology: 'sequence' as const, nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '推理' }] };
    const choices = await measureDiagramAllocations(plan, fontMeasure, { left: 500, top: 280, maxWidth: 328, maxHeight: 232.5 });
    expect(choices.some((choice) => choice.width === 328)).toBe(true);
    expect(choices.every((choice) => choice.width <= 328 && choice.height <= 232.5)).toBe(true);
    await expect(measureDiagramAllocations(plan, fontMeasure, { left: 49 })).rejects.toThrow(/safe slide area/);
  });

  it('continues past compatible text-fit errors but propagates unexpected measurement errors', async () => {
    const plan = { topology: 'sequence' as const, nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '推理' }], annotation: '说明' };
    let first = true;
    const measure: TextMeasure = (input) => {
      if (first) {
        first = false;
        const foreignError = new Error('Text layout: textBox content needs 128px but its maximum allocation is 120px high');
        foreignError.name = 'TextLayoutError';
        throw foreignError;
      }
      return fontMeasure(input);
    };
    expect((await measureDiagramAllocations(plan, measure)).length).toBeGreaterThan(0);
    const failure = new Error('renderer unavailable');
    await expect(measureDiagramAllocations(plan, () => { throw failure; })).rejects.toBe(failure);
    expect(failure).not.toBeInstanceOf(DiagramAllocationError);
  });

  it('measures a symmetric seven-node ring with wider labels instead of uneven perimeter rows', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'symmetric-ring', topology: 'cycle', left: 50, top: 140, width: 900, height: 300,
      nodes: fullStepNames.map((label, index) => ({ id: `s${index}`, label })),
      edges: fullStepNames.map((_, index) => ({ from: `s${index}`, to: `s${(index + 1) % fullStepNames.length}`, label: '进入' })),
    };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(new Set(nodes.map((node) => Math.round(node.top))).size).toBe(4);
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(nodes.every((node) => node.text?.content.includes('font-size:20px'))).toBe(true);
    expect(lines).toHaveLength(7);
    expect(labels).toHaveLength(7);
    for (const [index, line] of lines.entries()) {
      expect(onBoundary(absoluteStart(line), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(line), nodes[(index + 1) % nodes.length]!)).toBe(true);
      expect(line).toMatchObject({ style: 'solid', points: ['', 'arrow'] });
    }
    await expect(compileMeasuredDiagramComponent({ ...diagram, height: 180 }, fontMeasure)).rejects.toMatchObject({
      name: 'DiagramAllocationError', authoredAllocation: { width: 900, height: 180 },
    });
    const choices = await measureDiagramAllocations(diagram, fontMeasure);
    expect(choices.every((choice) => choice.height > 180)).toBe(true);
    expect(() => compileDiagramComponent({ ...diagram, edges: [...diagram.edges!, { from: 's0', to: 's3' }] })).toThrow(/ordered ring/);
  });
  it('renders the failed lesson branch with every original node and explicit fork intact', () => {
    const elements = compileDiagramComponent(branch);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const byId = new Map(nodes.map((node) => [node.id, node]));

    expect(nodes.map((node) => node.id)).toEqual(branch.nodes.map((node) => `${branch.id}-node-${node.id}`));
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(branch.nodes.map((node) => node.label));
    expect(lines).toHaveLength(3);
    for (const [index, edge] of branch.edges!.entries()) {
      expect(onBoundary(absoluteStart(lines[index]!), byId.get(`${branch.id}-node-${edge.from}`)!)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), byId.get(`${branch.id}-node-${edge.to}`)!)).toBe(true);
      expect(lines[index]).toMatchObject({ style: 'solid', points: ['', 'arrow'] });
    }
    const root = byId.get(`${branch.id}-node-n1`)!;
    const leaves = branch.nodes.slice(1).map((node) => byId.get(`${branch.id}-node-${node.id}`)!);
    expect(leaves.every((node) => node.top > root.top + root.height)).toBe(true);
    expect(new Set(leaves.map((node) => node.top)).size).toBe(1);
    expect(elements.some((element) => element.type === 'text' && element.content.includes('一种或多种'))).toBe(true);
  });

  it('keeps fork-and-merge edges and finds the root independently of declaration order', () => {
    const diagram: DiagramComponent = { ...branch, annotation: undefined,
      nodes: [{ id: 'left', label: '方案一' }, { id: 'end', label: '综合评价' },
        { id: 'root', label: '确定问题' }, { id: 'right', label: '方案二' }],
      edges: [{ from: 'root', to: 'left' }, { from: 'root', to: 'right' },
        { from: 'left', to: 'end' }, { from: 'right', to: 'end' }] };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(lines).toHaveLength(4);
    for (const [index, edge] of diagram.edges!.entries()) {
      expect(onBoundary(absoluteStart(lines[index]!), byId.get(`${diagram.id}-node-${edge.from}`)!)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), byId.get(`${diagram.id}-node-${edge.to}`)!)).toBe(true);
    }
    expect(byId.get(`${diagram.id}-node-root`)!.top).toBeLessThan(byId.get(`${diagram.id}-node-left`)!.top);
    expect(byId.get(`${diagram.id}-node-end`)!.top).toBeGreaterThan(byId.get(`${diagram.id}-node-right`)!.top);
  });

  it('routes a level-skipping branch edge around the intervening node', () => {
    const diagram: DiagramComponent = { ...branch, annotation: undefined,
      nodes: [{ id: 'root', label: '原始证据' }, { id: 'middle', label: '分析证据' }, { id: 'end', label: '形成结论' }],
      edges: [{ from: 'root', to: 'middle' }, { from: 'middle', to: 'end' }, { from: 'root', to: 'end' }] };
    const elements = compileDiagramComponent(diagram);
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    expect(lines).toHaveLength(3);
    const skip = lines[2]!;
    expect(skip.cubic).toHaveLength(2);
    expect(onBoundary(absoluteStart(skip), nodes[0]!)).toBe(true);
    expect(onBoundary(absoluteEnd(skip), nodes[2]!)).toBe(true);
    const start = absoluteStart(skip);
    const end = absoluteEnd(skip);
    const controls = skip.cubic!.map(([x, y]) => [skip.left + x, skip.top + y]);
    const middle = nodes[1]!;
    for (let step = 1; step < 64; step += 1) {
      const t = step / 64;
      const point = [0, 1].map((axis) => (1 - t) ** 3 * start[axis]!
        + 3 * (1 - t) ** 2 * t * controls[0]![axis]!
        + 3 * (1 - t) * t ** 2 * controls[1]![axis]! + t ** 3 * end[axis]!);
      expect(point[0]! < middle.left || point[0]! > middle.left + middle.width
        || point[1]! < middle.top || point[1]! > middle.top + middle.height).toBe(true);
    }
  });

  it('measures branch allocations while retaining readable nodes, labels and annotation', async () => {
    const diagram: DiagramComponent = { ...branch,
      edges: branch.edges!.map((edge, index) => ({ ...edge, label: ['对比特征', '观察过程', '亲身参与'][index] })) };
    const measure: import('../src/text-layout-compiler.js').TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({
      naturalWidth: [...text].length * fontSize, height: padding * 2 + fontSize * lineHeight, lines: [text],
    });
    const allocations = await measureDiagramAllocations(diagram, measure);
    expect(allocations.some((allocation) => allocation.width === 900)).toBe(true);
    const elements = await compileMeasuredDiagramComponent(diagram, measure);
    expect(elements.filter((element) => element.type === 'shape')).toHaveLength(4);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(3);
    expect(elements.filter((element) => element.type === 'text')).toHaveLength(4);
    expect(() => compileDiagramComponent({ ...diagram, annotation: undefined, width: 240, height: 100 })).toThrow(/do not fit|cannot fit/);
    expect(() => compileDiagramComponent({ ...diagram,
      nodes: diagram.nodes.map((node) => ({ ...node, label: '不能塞进小节点的完整解释段落'.repeat(4) })) })).toThrow(/cannot fit/);
  });

  it('rejects missing branch edges, multiple roots, unreachable cycles and directed cycles', () => {
    expect(() => compileDiagramComponent({ ...branch, edges: undefined })).toThrow(/explicit directed edges/);
    expect(() => compileDiagramComponent({ ...branch, edges: [{ from: 'n1', to: 'n2' }] })).toThrow(/exactly one root/);
    expect(() => compileDiagramComponent({ ...branch,
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n2' }, { from: 'n3', to: 'n4' }] })).toThrow(/acyclic/);
    expect(() => compileDiagramComponent({ ...branch,
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n3', to: 'n4' }, { from: 'n4', to: 'n3' }] })).toThrow(/reachable/);
    expect(() => compileDiagramComponent({ ...branch, edges: [...branch.edges!, branch.edges![0]!] })).toThrow(/duplicate directed edge/);
  });

  it('continues to reject the branch edges when incorrectly declared as a sequence', () => {
    expect(() => compileDiagramComponent({ ...branch, topology: 'sequence' })).toThrow(/cross-links must point backward/);
  });

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

  it.each([3, 4, 5, 6, 7, 8, 9])('keeps %i ring nodes evenly spaced, symmetric and readable', (count) => {
    const diagram: DiagramComponent = { ...cycle, annotation: undefined, height: 370,
      nodes: Array.from({ length: count }, (_, index) => ({ id: String(index), label: `步骤${index + 1}` })) };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const axis = diagram.left + diagram.width / 2;
    expect(nodes).toHaveLength(count);
    expect(lines).toHaveLength(count);
    expect(nodes[0]!.left + nodes[0]!.width / 2).toBeCloseTo(axis);
    expect(nodes[0]!.top).toBe(Math.min(...nodes.map((node) => node.top)));
    for (let index = 1; index < count; index += 1) {
      const node = nodes[index]!;
      const reflected = nodes[count - index]!;
      expect(node.left + node.width / 2 + reflected.left + reflected.width / 2).toBeCloseTo(axis * 2);
      expect(node.top).toBeCloseTo(reflected.top);
    }
    const topY = nodes[0]!.top + nodes[0]!.height / 2;
    const maxSin = Math.max(...nodes.map((_, index) => Math.sin(-Math.PI / 2 + index * Math.PI * 2 / count)));
    const radiusY = (Math.max(...nodes.map((node) => node.top + node.height / 2)) - topY) / (maxSin + 1);
    const centreY = topY + radiusY;
    const radiusX = (nodes[1]!.left + nodes[1]!.width / 2 - axis) / Math.cos(-Math.PI / 2 + Math.PI * 2 / count);
    for (const [index, node] of nodes.entries()) {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
      expect((node.left + node.width / 2 - axis) / radiusX).toBeCloseTo(Math.cos(angle));
      expect((node.top + node.height / 2 - centreY) / radiusY).toBeCloseTo(Math.sin(angle));
      expect(node.text?.content).toContain('font-size:20px');
      expect(node.left >= diagram.left && node.left + node.width <= diagram.left + diagram.width
        && node.top >= diagram.top && node.top + node.height <= diagram.top + diagram.height).toBe(true);
      expect(lines[index]!.cubic).toHaveLength(2);
      expect(onBoundary(absoluteStart(lines[index]!), node)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), nodes[(index + 1) % count]!)).toBe(true);
      for (const other of nodes.slice(index + 1)) expect(node.left + node.width <= other.left
        || other.left + other.width <= node.left || node.top + node.height <= other.top
        || other.top + other.height <= node.top).toBe(true);
    }
  });

  it.each([5, 7, 9, 10, 11])('centres every wrapped row for %i ordered steps', (count) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'centred-flow', topology: 'sequence',
      left: 50, top: 140, width: 600, height: 360,
      nodes: Array.from({ length: count }, (_, index) => ({ id: String(index), label: `步骤${index + 1}` })) };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const rows = [...new Set(nodes.map((node) => node.top))].map((top) => nodes.filter((node) => node.top === top));
    expect(rows.length).toBeGreaterThan(1);
    expect(Math.max(...rows.map((row) => row.length)) - Math.min(...rows.map((row) => row.length))).toBeLessThanOrEqual(1);
    for (const row of rows) {
      expect((Math.min(...row.map((node) => node.left)) + Math.max(...row.map((node) => node.left + node.width))) / 2)
        .toBeCloseTo(diagram.left + diagram.width / 2);
      const ordered = [...row].sort((a, b) => a.left - b.left);
      for (let index = 2; index < ordered.length; index += 1) expect(ordered[index]!.left - ordered[index - 1]!.left)
        .toBeCloseTo(ordered[1]!.left - ordered[0]!.left);
    }
    expect(lines).toHaveLength(count - 1);
    for (const [index, line] of lines.entries()) {
      expect(onBoundary(absoluteStart(line), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(line), nodes[index + 1]!)).toBe(true);
      if (nodes[index]!.top !== nodes[index + 1]!.top) expect(line.cubic).toHaveLength(2);
      const start = absoluteStart(line);
      const end = absoluteEnd(line);
      for (let step = 1; step < 64; step += 1) {
        const t = step / 64;
        const point = line.cubic
          ? [0, 1].map((axis) => (1 - t) ** 3 * start[axis]!
            + 3 * (1 - t) ** 2 * t * (line.cubic![0]![axis]! + (axis ? line.top : line.left))
            + 3 * (1 - t) * t ** 2 * (line.cubic![1]![axis]! + (axis ? line.top : line.left)) + t ** 3 * end[axis]!)
          : [0, 1].map((axis) => start[axis]! + t * (end[axis]! - start[axis]!));
        for (const node of nodes.filter((_, nodeIndex) => nodeIndex !== index && nodeIndex !== index + 1)) {
          expect(point[0]! < node.left || point[0]! > node.left + node.width
            || point[1]! < node.top || point[1]! > node.top + node.height).toBe(true);
        }
      }
    }
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

  it('folds seven four-character steps into readable rows with all directed edges and labels', async () => {
    const diagram: DiagramComponent = {
      type: 'diagram', id: 'seven-steps', topology: 'sequence',
      left: 50, top: 140, width: 900, height: 240,
      nodes: ['提出问题', '分析情境', '建立模型', '验证假设', '交流结果', '改进方案', '迁移应用']
        .map((label, index) => ({ id: `step-${index}`, label })),
      edges: [
        { from: 'step-1', to: 'step-2', label: '依据证据' },
        { from: 'step-3', to: 'step-4', label: '进入实践' },
        { from: 'step-6', to: 'step-0', label: '调整' },
      ],
    };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');

    expect(nodes).toHaveLength(7);
    expect(lines).toHaveLength(7);
    expect(labels).toHaveLength(3);
    expect(new Set(nodes.map((node) => node.top)).size).toBe(2);
    expect(nodes[0]!.left).toBeLessThan(nodes[3]!.left);
    expect(nodes[4]!.left).toBeGreaterThan(nodes[6]!.left);
    for (let index = 0; index < 6; index += 1) {
      expect(onBoundary(absoluteStart(lines[index]!), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), nodes[index + 1]!)).toBe(true);
      expect(lines[index]!.points[1]).toBe('arrow');
    }
    const rows = [...new Set(nodes.map((node) => node.top))].map((top) => nodes.filter((node) => node.top === top));
    const rowCentre = (row: PPTShapeElement[]) => (Math.min(...row.map((node) => node.left))
      + Math.max(...row.map((node) => node.left + node.width))) / 2;
    expect(rowCentre(rows[0]!)).toBeCloseTo(rowCentre(rows[1]!));
    expect(absoluteStart(lines[3]!)[0]).toBeGreaterThan(absoluteEnd(lines[3]!)[0]);
    expect(lines[3]!.cubic).toHaveLength(2);
    expect(absoluteStart(lines[3]!)[1]).toBeLessThan(absoluteEnd(lines[3]!)[1]);
    expect(lines[6]).toMatchObject({ style: 'dashed', points: ['', 'arrow'] });
    expect(lines[6]!.cubic).toHaveLength(2);
    for (const label of labels) {
      expect(label.left).toBeGreaterThanOrEqual(diagram.left);
      expect(label.left + label.width).toBeLessThanOrEqual(diagram.left + diagram.width);
      expect(label.top).toBeGreaterThanOrEqual(diagram.top);
      expect(label.top + label.height).toBeLessThanOrEqual(diagram.top + diagram.height);
      expect(nodes.every((node) => label.left + label.width <= node.left
        || node.left + node.width <= label.left
        || label.top + label.height <= node.top
        || node.top + node.height <= label.top)).toBe(true);
    }

    const measure: import('../src/text-layout-compiler.js').TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({
      naturalWidth: [...text].length * fontSize,
      height: padding * 2 + fontSize * lineHeight,
      lines: [text],
    });
    const allocations = await measureDiagramAllocations(diagram, measure);
    expect(allocations.some((choice) => choice.width === 900)).toBe(true);
    const measured = await compileMeasuredDiagramComponent(diagram, measure);
    expect(measured.filter((element) => element.type === 'line')).toHaveLength(7);
  });

  it('rejects a seven-step sequence only when no row arrangement fits the container', () => {
    const diagram: DiagramComponent = {
      type: 'diagram', id: 'too-small', topology: 'sequence',
      left: 50, top: 140, width: 300, height: 120,
      nodes: ['提出问题', '分析情境', '建立模型', '验证假设', '交流结果', '改进方案', '迁移应用']
        .map((label, index) => ({ id: `step-${index}`, label })),
    };
    expect(() => compileDiagramComponent(diagram)).toThrow(/sequence nodes and edge labels do not fit/);
  });

  it('routes a wrapped feedback edge around the right side when both nodes end their rows there', () => {
    const diagram: DiagramComponent = {
      type: 'diagram', id: 'right-feedback', topology: 'sequence',
      left: 50, top: 140, width: 500, height: 180,
      nodes: ['提出问题', '建立模型', '验证假设', '迁移应用']
        .map((label, index) => ({ id: `step-${index}`, label })),
      edges: [{ from: 'step-2', to: 'step-1', label: '回看' }],
    };
    const elements = compileDiagramComponent(diagram);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const feedback = elements.find((element): element is PPTLineElement => element.id === 'right-feedback-edge-3' && element.type === 'line')!;
    const label = elements.find((element): element is PPTTextElement => element.id === 'right-feedback-edge-label-3' && element.type === 'text')!;
    expect(new Set(nodes.map((node) => node.top)).size).toBe(2);
    expect(feedback.style).toBe('dashed');
    expect(absoluteStart(feedback)[0]).toBeCloseTo(nodes[2]!.left + nodes[2]!.width);
    expect(absoluteEnd(feedback)[0]).toBeCloseTo(nodes[1]!.left + nodes[1]!.width);
    expect(feedback.cubic![0][0] + feedback.left).toBeGreaterThan(absoluteStart(feedback)[0]);
    expect(label.left).toBeGreaterThan(nodes[1]!.left + nodes[1]!.width);
    expect(label.left + label.width).toBeLessThanOrEqual(diagram.left + diagram.width);
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
