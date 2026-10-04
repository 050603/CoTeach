import { describe, expect, it } from 'vitest';
import type { PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { compileDiagramComponent, compileMeasuredDiagramComponent, measureDiagramAllocations, resolveDiagramSequenceGroups, normalizeDiagramComponent, isDiagramComponent, DiagramAllocationError, type DiagramComponent } from '../src/diagram-compiler.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';
import { nativeSlideCollisions } from '../src/native-slide-collision.js';

const fontMeasure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const count = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const lines = text.match(new RegExp(`.{1,${count}}`, 'gu')) ?? [];
  return { naturalWidth: [...text].length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
};

const fullStepNames = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计',
  '协作学习环境设计', '学习效果评价设计', '强化练习设计'];

const ordinalFontMeasure: TextMeasure = (input) => ({ ...fontMeasure(input), naturalWidth: [...input.text].reduce((width, char) =>
  width + (/\s/u.test(char) ? input.fontSize * 2 / 9 : /[0-9]/u.test(char) ? input.fontSize * 5 / 9 : input.fontSize), 0) });

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

// Same two-level relationship as the saved section-3 authoring response:
// four framework stages plus a separate five-step implementation loop.
const frameworkAndImplementation: DiagramComponent = {
  type: 'diagram', id: 'framework-implementation', topology: 'sequence', left: 50, top: 112, width: 900, height: 394,
  nodes: [
    ...['前期分析', '核心要素设计', '教学过程实施', '教学评价'].map((label, index) => ({ id: `stage${index + 1}`, label })),
    ...['情境/环境创设', '正向引导', '具身体验', '生成内化', '引导修正'].map((label, index) => ({ id: `imp${index + 1}`, label })),
  ],
  edges: [
    { from: 'stage1', to: 'stage2' }, { from: 'stage2', to: 'stage3' }, { from: 'stage3', to: 'stage4' },
    { from: 'imp1', to: 'imp2' }, { from: 'imp2', to: 'imp3' }, { from: 'imp3', to: 'imp4' }, { from: 'imp4', to: 'imp5' },
    { from: 'imp5', to: 'imp1', label: '循环往复、不断深化' },
  ],
  sequenceGroups: [
    { id: 'framework', label: '具身教学设计框架四阶段', nodeIds: ['stage1', 'stage2', 'stage3', 'stage4'] },
    { id: 'implementation', label: '教学过程实施五步循环', nodeIds: ['imp1', 'imp2', 'imp3', 'imp4', 'imp5'] },
  ],
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
  it('fits a narrow seven-step native side column using real text padding and a local connector lane', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'seven-step-side-column', topology: 'sequence',
      left: 60, top: 180, width: 185, height: 332,
      nodes: fullStepNames.map((label, index) => ({ id: `step${index + 1}`, label })),
      edges: fullStepNames.slice(1).map((_, index) => ({ from: `step${index + 1}`, to: `step${index + 2}` })),
      nodeFill: '#EFF6FF', accentColor: '#1E40AF', textColor: '#1E3A8A' };
    const original = structuredClone(diagram);
    const diagnostics: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) });
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const edges = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(nodes.every((node) => node.height === 42.5 && node.width >= 164
      && node.text?.content.includes('font-size:18px') && node.text?.lineHeight === 1.25
      && !node.text.content.includes('<br>'))).toBe(true);
    expect(new Set(nodes.map((node) => node.left)).size).toBe(1);
    expect(nodes.every((node) => node.left >= 60 && node.left + node.width <= 245
      && node.top >= 180 && node.top + node.height <= 512)).toBe(true);
    expect(edges).toHaveLength(6);
    edges.forEach((edge, index) => {
      expect(onBoundary(absoluteStart(edge), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(edge), nodes[index + 1]!)).toBe(true);
      expect(edge.cubic).toHaveLength(2);
      expect(edge.cubic!.every(([x, y]) => edge.left + x <= 245 && edge.left + x > nodes[index]!.left + nodes[index]!.width
        && edge.top + y >= 180 && edge.top + y <= 512)).toBe(true);
    });
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(diagram).toEqual(original);
    await expect(compileMeasuredDiagramComponent({ ...diagram, height: 280 }, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    expect(diagnostics).toEqual([]);
  });

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

  it.each([false, true])('keeps all framework and implementation-loop nodes, groups and local feedback routes (measured: %s)', async (measured) => {
    const plan = structuredClone(frameworkAndImplementation);
    const original = structuredClone(plan);
    const elements = measured
      ? await compileMeasuredDiagramComponent(plan, fontMeasure, { preserveNativeComposition: true })
      : compileDiagramComponent(plan);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const texts = elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(nodes.map((node) => node.text!.content.replace(/<[^>]+>/gu, ''))).toEqual(plan.nodes.map((node) => node.label));
    expect(nodes.every((node) => node.text!.content.includes('font-size:20px'))).toBe(true);
    expect(lines).toHaveLength(8);
    expect(texts).toHaveLength(3);
    expect(texts.filter((element) => element.id.includes('-group-')).map((element) => element.content.replace(/<[^>]+>/gu, '')))
      .toEqual(plan.sequenceGroups!.map((group) => group.label));
    for (const edge of plan.edges!) {
      const from = nodes.find((node) => node.id.endsWith(`-node-${edge.from}`))!;
      const to = nodes.find((node) => node.id.endsWith(`-node-${edge.to}`))!;
      expect(lines.filter((line) => onBoundary(absoluteStart(line), from) && onBoundary(absoluteEnd(line), to))).toHaveLength(1);
    }
    const feedback = lines.find((line) => line.style === 'dashed')!;
    expect(lines.filter((line) => line.style === 'dashed')).toHaveLength(1);
    const implementationTitle = texts.find((element) => element.id.endsWith('-group-implementation'))!;
    const feedbackLabel = texts.find((element) => element.id.includes('-edge-label-'))!;
    expect(feedbackLabel.content.replace(/<[^>]+>/gu, '')).toBe('循环往复、不断深化');
    for (const [x, y] of [absoluteStart(feedback), absoluteEnd(feedback), ...feedback.cubic!.map(([x, y]) => [x + feedback.left, y + feedback.top])]) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(plan.left);
      expect(x).toBeLessThanOrEqual(plan.left + plan.width);
      expect(y).toBeGreaterThanOrEqual(implementationTitle.top + implementationTitle.height);
      expect(y).toBeLessThanOrEqual(plan.top + plan.height);
    }
    expect(feedbackLabel.top).toBeGreaterThanOrEqual(implementationTitle.top + implementationTitle.height);
    expect(feedbackLabel.top + feedbackLabel.height).toBeLessThanOrEqual(plan.top + plan.height);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(plan).toEqual(original);
  });

  it('routes one feedback per independent group inside its own band without NaN, false connectors or label collisions', async () => {
    const plan: DiagramComponent = { type: 'diagram', id: 'two-feedback-groups', topology: 'sequence',
      left: 50, top: 112, width: 900, height: 394,
      nodes: ['a', 'b'].flatMap((prefix) => ['观察', '实验', '交流', '反思'].map((label, index) => ({ id: `${prefix}${index + 1}`, label }))),
      edges: ['a', 'b'].flatMap((prefix) => [
        { from: `${prefix}1`, to: `${prefix}2` }, { from: `${prefix}2`, to: `${prefix}3` }, { from: `${prefix}3`, to: `${prefix}4` },
        { from: `${prefix}4`, to: `${prefix}1`, label: `${prefix === 'a' ? '调整方法' : '再次探究'}` },
      ]),
      sequenceGroups: ['a', 'b'].map((prefix) => ({ id: prefix, label: `${prefix === 'a' ? '概念学习' : '实践应用'}`,
        nodeIds: [1, 2, 3, 4].map((index) => `${prefix}${index}`) })),
    };
    const elements = await compileMeasuredDiagramComponent(plan, fontMeasure, { preserveNativeComposition: true });
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const titles = elements.filter((element): element is PPTTextElement => element.type === 'text' && element.id.includes('-group-'));
    expect(lines).toHaveLength(8);
    expect(lines.filter((line) => line.style === 'dashed')).toHaveLength(2);
    for (const [index, group] of plan.sequenceGroups!.entries()) {
      const title = titles.find((element) => element.id.endsWith(`-group-${group.id}`))!;
      const bottom = index === 0 ? titles[1]!.top - 20 : plan.top + plan.height;
      for (const edge of plan.edges!.filter((edge) => group.nodeIds.includes(edge.from))) {
        const from = nodes.find((node) => node.id.endsWith(`-node-${edge.from}`))!;
        const to = nodes.find((node) => node.id.endsWith(`-node-${edge.to}`))!;
        const matches = lines.filter((line) => onBoundary(absoluteStart(line), from) && onBoundary(absoluteEnd(line), to));
        expect(matches).toHaveLength(1);
        const line = matches[0]!;
        for (const [x, y] of [absoluteStart(line), absoluteEnd(line), ...(line.cubic ?? []).map(([x, y]) => [x + line.left, y + line.top])]) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(x).toBeGreaterThanOrEqual(plan.left);
          expect(x).toBeLessThanOrEqual(plan.left + plan.width);
          expect(y).toBeGreaterThanOrEqual(title.top + title.height);
          expect(y).toBeLessThanOrEqual(bottom);
        }
        if (edge.label) {
          const label = elements.find((element): element is PPTTextElement => element.type === 'text'
            && element.id === line.id.replace('-edge-', '-edge-label-'))!;
          expect(label.content.replace(/<[^>]+>/gu, '')).toBe(edge.label);
          expect(label.top).toBeGreaterThanOrEqual(title.top + title.height);
          expect(label.top + label.height).toBeLessThanOrEqual(bottom);
          expect(label.left).toBeGreaterThanOrEqual(plan.left);
          expect(label.left + label.width).toBeLessThanOrEqual(plan.left + plan.width);
        }
      }
    }
    expect(nativeSlideCollisions(elements)).toEqual([]);
  });

  it('still rejects cross-group edges, forward skips and multiple feedback edges in one group', () => {
    for (const [edge, error] of [
      [{ from: 'stage4', to: 'imp1' }, /cross-group/],
      [{ from: 'imp1', to: 'imp4' }, /point backward/],
      [{ from: 'imp4', to: 'imp2' }, /at most one feedback/],
    ] as const) expect(() => compileDiagramComponent({ ...frameworkAndImplementation,
      edges: [...frameworkAndImplementation.edges!, edge] })).toThrow(error);
  });

  it('reports insufficient group allocation instead of dropping the feedback or returning an overflowing native fallback', async () => {
    const diagnostics: string[] = [];
    await expect(compileMeasuredDiagramComponent({ ...frameworkAndImplementation, height: 180 }, fontMeasure,
      { preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) }))
      .rejects.toMatchObject({ name: 'DiagramAllocationError', code: 'diagram-allocation' });
    expect(diagnostics).toEqual([]);
  });

  it('retains implicit adjacency for old partial edge labels and single-chain feedback', () => {
    const partial = { ...parallelSequences, nodes: parallelSequences.nodes.slice(0, 3), annotation: undefined, edges: [{ from: 'a1', to: 'a2', label: '回顾' }] };
    expect(resolveDiagramSequenceGroups(partial)).toBeUndefined();
    const elements = compileDiagramComponent({ ...partial, height: 360 });
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(partial.nodes.length - 1);
    expect(resolveDiagramSequenceGroups({ ...parallelSequences, edges: [{ from: 'b4', to: 'a1', label: '反馈' }] })).toBeUndefined();
  });

  it('uses the exact remaining safe height and reports actionable full-plan allocations', async () => {
    const plan = { topology: 'sequence' as const, nodes: fullStepNames.slice(4).map((label, i) => ({ id: `s${i}`, label })), annotation: '完整映射说明' };
    const measure: TextMeasure = (input) => input.text === plan.annotation
      ? { naturalWidth: 200, height: 246, lines: [input.text] } : fontMeasure(input);
    const choices = await measureDiagramAllocations(plan, measure);
    expect(choices).toContainEqual({ width: 900, height: 372.5 });
    const elements = await compileMeasuredDiagramComponent({ ...plan, ...choices[0]!, type: 'diagram', id: 'safe-height', left: 50, top: 140 }, measure);
    expect(elements.filter((element) => element.type === 'shape')).toHaveLength(plan.nodes.length);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(plan.nodes.length - 1);
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

  it('reserves readable label height when a multi-level conditional branch must flow horizontally', async () => {
    const diagram: DiagramComponent = { ...branch, top: 112, height: 394, annotation: undefined,
      nodes: [{ id: 'input', label: '读取记录' }, { id: 'decision', label: '是否一致' },
        { id: 'accepted', label: '保存结果' }, { id: 'mismatch', label: '重新核对' },
        { id: 'corrected', label: '记录修正' }],
      edges: [{ from: 'input', to: 'decision' }, { from: 'decision', to: 'accepted', label: '是' },
        { from: 'decision', to: 'mismatch', label: '否' }, { from: 'mismatch', to: 'corrected', label: '核对完成' }] };
    for (const elements of [compileDiagramComponent(diagram), await compileMeasuredDiagramComponent(diagram, fontMeasure)]) {
      const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
      const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
      const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');
      const byId = new Map(nodes.map((node) => [node.id, node]));
      expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(diagram.nodes.map((node) => node.label));
      expect(lines).toHaveLength(diagram.edges!.length);
      expect(labels).toHaveLength(3);
      const decision = byId.get(`${diagram.id}-node-decision`)!;
      const input = byId.get(`${diagram.id}-node-input`)!;
      expect(decision.left).toBeGreaterThan(input.left + input.width);
      for (const [index, edge] of diagram.edges!.entries()) {
        expect(onBoundary(absoluteStart(lines[index]!), byId.get(`${diagram.id}-node-${edge.from}`)!)).toBe(true);
        expect(onBoundary(absoluteEnd(lines[index]!), byId.get(`${diagram.id}-node-${edge.to}`)!)).toBe(true);
      }
      for (const [index, label] of labels.entries()) {
        for (const other of [...nodes, ...labels.slice(index + 1)]) {
          expect(label.left + label.width + 4 <= other.left || other.left + other.width + 4 <= label.left
            || label.top + label.height + 4 <= other.top || other.top + other.height + 4 <= label.top).toBe(true);
        }
      }
    }
    expect(() => compileDiagramComponent({ ...diagram, width: 220, height: 160 })).toThrow(/do not fit|cannot fit/);
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

  it.each([5, 7, 9, 10, 11])('reports insufficient space instead of folding %i ordinary steps into reverse rows', async (count) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'straight-flow', topology: 'sequence',
      left: 50, top: 140, width: 600, height: 360,
      nodes: Array.from({ length: count }, (_, index) => ({ id: String(index), label: `步骤${index + 1}` })) };
    const before = structuredClone(diagram);
    expect(() => compileDiagramComponent(diagram)).toThrow(/sequence nodes and edge labels do not fit/);
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure)).rejects.toMatchObject({
      name: 'DiagramAllocationError', code: 'diagram-allocation',
      authoredAllocation: { left: 50, top: 140, width: 600, height: 360 },
    });
    expect(diagram).toEqual(before);
  });

  it.each([
    { width: 900, height: 360, vertical: false },
    { width: 320, height: 360, vertical: true },
  ])('keeps the complete sequence straight in a $width × $height allocation', async ({ width, height, vertical }) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'straight-flow', topology: 'sequence',
      left: 50, top: 140, width, height,
      nodes: ['观察现象', '解释证据', '迁移应用'].map((label, index) => ({ id: String(index), label })),
      edges: [{ from: '0', to: '1', label: '解释' }, { from: '1', to: '2', label: '应用' }] };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure);
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(diagram.nodes.map((node) => node.label));
    expect(nodes.every((node) => node.text?.content.includes('font-size:20px'))).toBe(true);
    expect(lines).toHaveLength(2);
    expect(labels.map((label) => label.content.replace(/<[^>]+>/gu, ''))).toEqual(['解释', '应用']);
    expect(new Set(nodes.map((node) => vertical ? node.left : node.top)).size).toBe(1);
    for (const [index, line] of lines.entries()) {
      expect(line.cubic).toBeUndefined();
      expect(vertical ? nodes[index + 1]!.top : nodes[index + 1]!.left)
        .toBeGreaterThan(vertical ? nodes[index]!.top : nodes[index]!.left);
      expect(onBoundary(absoluteStart(line), nodes[index]!)).toBe(true);
      expect(onBoundary(absoluteEnd(line), nodes[index + 1]!)).toBe(true);
    }
  });

  it.each([220, 206])('packs all fork and merge nodes and six edges at 18px in a 440×%spx local rectangle', async (height) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'six-native-nodes', topology: 'branch',
      left: 60, top: 170, width: 440, height,
      nodes: [{ id: 'info', label: '新信息或经验' }, { id: 'compatible', label: '与原有结构兼容' },
        { id: 'assimilation', label: '同化' }, { id: 'conflict', label: '与原有结构冲突' },
        { id: 'accommodation', label: '顺应' }, { id: 'development', label: '认知发展' }],
      edges: [{ from: 'info', to: 'compatible' }, { from: 'compatible', to: 'assimilation' },
        { from: 'info', to: 'conflict' }, { from: 'conflict', to: 'accommodation' },
        { from: 'assimilation', to: 'development' }, { from: 'accommodation', to: 'development' }] };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 });
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(nodes.map((node) => node.id)).toEqual(diagram.nodes.map((node) => `${diagram.id}-node-${node.id}`));
    expect(lines).toHaveLength(diagram.edges!.length);
    expect(nodes.every((node) => node.text?.content.includes('font-size:18px'))).toBe(true);
    for (const [index, edge] of diagram.edges!.entries()) {
      const from = nodes.find((node) => node.id === `${diagram.id}-node-${edge.from}`)!;
      const to = nodes.find((node) => node.id === `${diagram.id}-node-${edge.to}`)!;
      expect(onBoundary(absoluteStart(lines[index]!), from)).toBe(true);
      expect(onBoundary(absoluteEnd(lines[index]!), to)).toBe(true);
    }
    for (const node of nodes) {
      expect(node.height).toBeGreaterThanOrEqual(32.5);
      expect(node.top).toBeGreaterThanOrEqual(diagram.top);
      expect(node.top + node.height).toBeLessThanOrEqual(diagram.top + diagram.height);
    }
  });

  it('honors an authored vertical sequence instead of switching it into a fitting horizontal row', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'chosen-direction', topology: 'sequence',
      left: 60, top: 180, width: 880, height: 100, orientation: 'vertical',
      nodes: ['观察', '说明', '应用'].map((label, index) => ({ id: String(index), label })) };
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    const horizontal = await compileMeasuredDiagramComponent({ ...diagram, orientation: 'horizontal' }, fontMeasure, { nodeFontSize: 18 });
    expect(new Set(horizontal.filter((element) => element.type === 'shape').map((element) => element.top)).size).toBe(1);
  });

  it('compiles a clear seven-step vertical list with actual canonical labels, separate circles and six adjacent connectors', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'open-steps', topology: 'sequence',
      left: 60, top: 150, width: 360, height: 350, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `s${index + 1}`, label })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}` })) };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(labels.map((element) => element.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(labels.every((element) => element.text?.content.includes('font-size:18px') && element.fill === 'transparent')).toBe(true);
    expect(numbers.map((element) => element.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(lines).toHaveLength(6);
    for (const [index, line] of lines.entries()) {
      expect(line.width).toBe(1.5);
      expect(line.cubic).toBeUndefined();
      expect(absoluteStart(line)).toEqual([numbers[index]!.left + 14, numbers[index]!.top + 28]);
      expect(absoluteEnd(line)).toEqual([numbers[index + 1]!.left + 14, numbers[index + 1]!.top]);
      expect(labels[index + 1]!.top).toBeGreaterThan(labels[index]!.top + labels[index]!.height);
    }
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(elements.filter((element) => element.type === 'shape').every((element) => element.top + element.height <= 500)).toBe(true);
  });

  it('uses a bounded native spacing retry for all seven steps in 390×322 without changing fonts, circles or canonical edges', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'native-seven', topology: 'sequence',
      left: 560, top: 186, width: 390, height: 322, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `s${index + 1}`, label })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}` })) };
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    const diagnostics: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, {
      nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail),
    });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(diagnostics).toEqual([]);
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(labels.every((label) => label.height === 30.5 && label.text?.content.includes('font-size:18px'))).toBe(true);
    expect(numbers.every((number) => number.width === 28 && number.height === 28)).toBe(true);
    expect(lines.map((line) => line.id)).toEqual(diagram.edges!.map((_, index) => `${diagram.id}-edge-${index}`));
    for (const [index, line] of lines.entries()) {
      expect(absoluteStart(line)).toEqual([numbers[index]!.left + 14, numbers[index]!.top + 28]);
      expect(absoluteEnd(line)).toEqual([numbers[index + 1]!.left + 14, numbers[index + 1]!.top]);
      expect(labels[index + 1]!.top - labels[index]!.top - labels[index]!.height).toBeGreaterThanOrEqual(12);
    }
    expect(elements.filter((element) => element.type === 'shape').every((element) => element.top + element.height <= 508)).toBe(true);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    const ordinary = { ...diagram, top: 150, height: 350 };
    expect(await compileMeasuredDiagramComponent(ordinary, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true }))
      .toEqual(await compileMeasuredDiagramComponent(ordinary, fontMeasure, { nodeFontSize: 18 }));
  });

  it('uses the actual vertical native frame for single-line labels rather than the 174px card preference', async () => {
    const names = ['搭脚手架：明确学习任务', '进入情境：分析实际问题', '独立探索：解决具体问题', '协作学习：共享探索成果', '效果评价：完成意义建构'];
    const diagram: DiagramComponent = { type: 'diagram', id: 'wide-vertical-steps', topology: 'sequence',
      left: 60, top: 128, width: 440, height: 300, orientation: 'vertical', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `s${index + 1}`, label: `${index + 1} ${label}` })),
      edges: names.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}` })) };
    const original = structuredClone(diagram);
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    const edges = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(labels.map((element) => element.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(names);
    expect(labels.every((label) => !label.text?.content.includes('<br>') && label.text?.content.includes('font-size:18px'))).toBe(true);
    const naturalWidth = Math.max(...names.map((label) => [...label].length * 18));
    expect(labels.every((label) => label.width === naturalWidth + 30 && label.width > 174)).toBe(true);
    expect(labels.every((label) => label.left + label.width < diagram.left + diagram.width - 12)).toBe(true);
    expect(numbers.map((number) => number.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(['1', '2', '3', '4', '5']);
    expect(edges).toHaveLength(4);
    for (const [index, edge] of edges.entries()) {
      expect(absoluteStart(edge)).toEqual([numbers[index]!.left + 14, numbers[index]!.top + 28]);
      expect(absoluteEnd(edge)).toEqual([numbers[index + 1]!.left + 14, numbers[index + 1]!.top]);
      expect(edge.cubic).toBeUndefined();
    }
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(diagram).toEqual(original);
    const allocations = await measureDiagramAllocations(diagram, fontMeasure,
      { left: 60, top: 128, maxWidth: 440, maxHeight: 300 },
      { nodeFontSize: 18, preserveNativeComposition: true, orientation: 'vertical', presentation: 'steps' });
    // The first-pass space reference and final compilation use the same widths
    // and fit the complete source labels within the same measured rectangle.
    expect(allocations).toContainEqual({ width: 440, height: 240 });
    const compiled = await compileMeasuredDiagramComponent({ ...diagram, ...allocations.find((allocation) => allocation.width === 440)! }, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true });
    expect(compiled.filter((element) => element.type === 'shape' && element.id.includes('-node-')))
      .toEqual(expect.arrayContaining(labels.map((label) => expect.objectContaining({ width: label.width, text: label.text }))));
    // Legacy vertical and native cards keep their existing card-width policy.
    const legacy = await compileMeasuredDiagramComponent({ ...diagram, height: 380 }, fontMeasure, { nodeFontSize: 18 });
    expect(legacy.filter((element) => element.type === 'shape' && element.id.includes('-node-'))
      .every((element) => element.type === 'shape' && element.width === 174 && element.text?.content.includes('<br>'))).toBe(true);
    const cards = { ...diagram, left: 50, width: 900, presentation: 'cards' as const, height: 380,
      nodes: diagram.nodes.slice(0, 3), edges: diagram.edges!.slice(0, 2) };
    expect(await compileMeasuredDiagramComponent(cards, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true }))
      .toEqual(await compileMeasuredDiagramComponent(cards, fontMeasure, { nodeFontSize: 18 }));
  });

  it('still wraps complete vertical native labels in a narrow real frame and diagnoses genuinely insufficient space', async () => {
    const names = ['搭脚手架：明确学习任务', '进入情境：分析实际问题', '独立探索：解决具体问题'];
    const diagram: DiagramComponent = { type: 'diagram', id: 'narrow-vertical-steps', topology: 'sequence',
      left: 60, top: 128, width: 240, height: 280, orientation: 'vertical', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `s${index + 1}`, label })) };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(names);
    expect(labels.every((label) => label.text?.content.includes('<br>') && label.text?.content.includes('font-size:18px'))).toBe(true);
    expect(labels.every((label) => label.left + label.width <= diagram.left + diagram.width - 12)).toBe(true);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    await expect(compileMeasuredDiagramComponent({ ...diagram, width: 150 }, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true })).rejects.toBeInstanceOf(DiagramAllocationError);
    await expect(measureDiagramAllocations(diagram, fontMeasure,
      { left: 60, top: 128, maxWidth: 150, maxHeight: 280 },
      { nodeFontSize: 18, preserveNativeComposition: true, orientation: 'vertical', presentation: 'steps' }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
  });

  it('keeps labeled edge space instead of certifying the compact seven-step profile when labels still cannot fit', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'labeled-seven', topology: 'sequence',
      left: 60, top: 150, width: 390, height: 322, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `s${index + 1}`, label })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}`, label: '完成后' })) };
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
  });

  it('fits numbered seven-step labels in the original 240×327 region without duplicating their visible ordinals', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'live-seven', topology: 'sequence',
      left: 60, top: 128, width: 240, height: 327, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `step${index + 1}`, label: `${index + 1} ${label}` })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `step${index + 1}`, to: `step${index + 2}` })) };
    const original = structuredClone(diagram);
    await expect(compileMeasuredDiagramComponent(diagram, ordinalFontMeasure, { nodeFontSize: 18 }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    const diagnostics: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, ordinalFontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(numbers.map((number, index) => `${number.text?.content.replace(/<[^>]+>/gu, '')} ${labels[index]!.text?.content.replace(/<[^>]+>/gu, '')}`))
      .toEqual(diagram.nodes.map((node) => node.label));
    expect(labels.every((label) => !label.text?.content.includes('<br>') && label.text?.content.includes('font-size:18px'))).toBe(true);
    expect(elements.filter((element) => element.type === 'shape').every((element) => element.top + element.height <= 455.001)).toBe(true);
    expect(labels.at(-1)!.top + labels.at(-1)!.height).toBeCloseTo(443);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(diagnostics).toEqual([]);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(diagram).toEqual(original);
    const { id: _id, type: _type, left: _left, top: _top, width: _width, height: _height, ...plan } = diagram;
    expect([_id, _type, _left, _top, _width, _height]).toHaveLength(6);
    const allocations = await measureDiagramAllocations(plan, ordinalFontMeasure,
      { left: 60, top: 128, maxWidth: 240, maxHeight: 327 },
      { nodeFontSize: 18, preserveNativeComposition: true, orientation: 'vertical', presentation: 'steps' });
    expect(allocations).toEqual([{ width: 240, height: 320 }]);
    await expect(compileMeasuredDiagramComponent({ ...diagram, ...allocations[0] }, ordinalFontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true })).resolves.toHaveLength(elements.length);
  });

  it.each([' ', '\t', '. ', '． ', '、', ') ', '）'])('measures the real display-label wrap after a %j ordinal and fits all five steps in the authored 852×124 frame', async (separator) => {
    const names = ['搭脚手架：明确任务', '进入情境：分析问题', '独立探索：解决问题', '协作学习：集思广益', '效果评价：完成建构'];
    const diagram: DiagramComponent = { type: 'diagram', id: 'five-complete-steps', topology: 'sequence',
      left: 74, top: 118, width: 852, height: 124, orientation: 'horizontal', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `step${index + 1}`, label: `${index + 1}${separator}${label}` })),
      edges: names.slice(0, -1).map((_, index) => ({ from: `step${index + 1}`, to: `step${index + 2}` })) };
    const before = structuredClone(diagram);
    const measured = new Map<string, { fontSize: number; fontWeight: number; fontFamily: string }>();
    const measure: TextMeasure = async (input) => {
      measured.set(input.text, input);
      return fontMeasure(input);
    };
    const diagnostics: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, measure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    const edges = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(measured.get('搭脚')).toMatchObject({ fontSize: 18, fontWeight: 400, fontFamily: 'Noto Sans SC' });
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(names);
    expect(labels.every((label) => label.text?.content.includes('<br>') && label.text?.content.includes('font-size:18px;font-weight:400'))).toBe(true);
    expect(numbers.map((number) => number.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(['1', '2', '3', '4', '5']);
    expect(edges).toHaveLength(4);
    for (const [index, edge] of edges.entries()) {
      expect(edge.id).toBe(`${diagram.id}-edge-${index}`);
      expect(absoluteStart(edge)).toEqual([numbers[index]!.left + 28, numbers[index]!.top + 14]);
      expect(absoluteEnd(edge)).toEqual([numbers[index + 1]!.left, numbers[index + 1]!.top + 14]);
      expect(edge.cubic).toBeUndefined();
    }
    expect([...labels, ...numbers].every((element) => element.left >= 74 && element.top >= 118
      && element.left + element.width <= 926.001 && element.top + element.height <= 242.001)).toBe(true);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(diagram).toEqual(before);
    // A genuine lack of readable width is still a typed geometry diagnosis.
    await expect(compileMeasuredDiagramComponent({ ...diagram, width: 600 }, measure,
      { nodeFontSize: 18, preserveNativeComposition: true })).rejects.toBeInstanceOf(DiagramAllocationError);
    const allocations = await measureDiagramAllocations(diagram, measure,
      { left: 74, top: 118, maxWidth: 852, maxHeight: 124 },
      { nodeFontSize: 18, preserveNativeComposition: true, orientation: 'horizontal', presentation: 'steps' });
    expect(allocations).toContainEqual({ width: 852, height: 120 });
    await expect(compileMeasuredDiagramComponent({ ...diagram, ...allocations[0] }, measure,
      { nodeFontSize: 18, preserveNativeComposition: true })).resolves.toHaveLength(elements.length);
  });

  it.each(['Error', 'AbortError'])('propagates a real %s while measuring an ordinal-stripped label instead of using approximate geometry', async (name) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'ordinal-measure-failure', topology: 'sequence',
      left: 74, top: 118, width: 852, height: 124, orientation: 'horizontal', presentation: 'steps',
      nodes: [{ id: 'first', label: '1 搭脚手架：明确任务' }, { id: 'second', label: '2 进入情境：分析问题' }] };
    const failure = new Error('renderer measurement unavailable');
    failure.name = name;
    const diagnostics: string[] = [];
    await expect(compileMeasuredDiagramComponent(diagram, async (input) => {
      if (input.text === '搭脚') throw failure;
      return fontMeasure(input);
    }, { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) })).rejects.toBe(failure);
    expect(diagnostics).toEqual([]);
  });

  it('removes only an exact steps ordinal and keeps mismatched, decimal and semantic numbers in their canonical labels', async () => {
    const names = ['1. 教学目标分析', '8 情境创设', '3.5比例条件', '4/5达标条件', '5：2配比', '6、学习效果评价设计', '7) 强化练习设计'];
    const diagram: DiagramComponent = { type: 'diagram', id: 'safe-ordinals', topology: 'sequence',
      left: 60, top: 128, width: 390, height: 350, orientation: 'vertical', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `step${index + 1}`, label })) };
    const original = structuredClone(diagram);
    const elements = await compileMeasuredDiagramComponent(diagram, ordinalFontMeasure, { nodeFontSize: 18, preserveNativeComposition: true });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, '')))
      .toEqual(['教学目标分析', '8 情境创设', '3.5比例条件', '4/5达标条件', '5：2配比', '学习效果评价设计', '强化练习设计']);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(elements.filter((element) => element.type === 'shape' && element.id.includes('-number-'))).toHaveLength(7);
    expect(diagram).toEqual(original);
    expect(nativeSlideCollisions(elements)).toEqual([]);
  });

  it('keeps existing unnumbered steps rendering byte-for-byte unchanged', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'unchanged-steps', topology: 'sequence',
      left: 60, top: 128, width: 390, height: 350, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `step${index + 1}`, label })) };
    const ordinary = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 });
    expect(await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true })).toEqual(ordinary);
  });

  it('measures each compact vertical step height instead of propagating one two-line label to every row', async () => {
    const names = [...fullStepNames];
    names[4] = '协作学习环境与资源设计';
    const diagram: DiagramComponent = { type: 'diagram', id: 'variable-steps', topology: 'sequence',
      left: 60, top: 128, width: 240, height: 350, orientation: 'vertical', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `step${index + 1}`, label })) };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(names);
    expect(labels[4]!.height).toBe(53);
    expect(labels.filter((_, index) => index !== 4).every((label) => label.height === 30.5)).toBe(true);
    expect(labels.every((label) => label.text?.content.includes('font-size:18px') && label.top + label.height <= 478.001)).toBe(true);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(nativeSlideCollisions(elements)).toEqual([]);
  });

  it('fits the original labeled five-node fork and merge into 420×288 by measuring actual ranks and their own labeled gaps', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'live-branch', topology: 'branch',
      left: 60, top: 106, width: 420, height: 288, orientation: 'vertical',
      nodes: [{ id: 'new-info', label: '新信息' }, { id: 'compatible', label: '与原有认知结构相容？' },
        { id: 'assimilation', label: '同化：融入现有结构' }, { id: 'accommodation', label: '顺应：调整或重塑结构' },
        { id: 'new-understanding', label: '新的理解' }],
      edges: [{ from: 'new-info', to: 'compatible' }, { from: 'compatible', to: 'assimilation', label: '相容' },
        { from: 'compatible', to: 'accommodation', label: '冲突或不兼容' },
        { from: 'assimilation', to: 'new-understanding' }, { from: 'accommodation', to: 'new-understanding' }] };
    const original = structuredClone(diagram), diagnostics: string[] = [];
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) });
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const labels = elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(diagram.nodes.map((node) => node.label));
    expect(nodes[1]!.width).toBe(210);
    expect(nodes[0]!.height).toBe(34.5);
    expect(nodes[2]!.height).toBe(57);
    expect(nodes[2]!.text?.content).toContain('同化：<br>融入现有结构');
    expect(nodes[3]!.text?.content).toContain('顺应：<br>调整或重塑结构');
    expect(nodes[2]!.top).toBe(nodes[3]!.top);
    expect(nodes[2]!.top - nodes[1]!.top - nodes[1]!.height).toBeGreaterThanOrEqual(56);
    expect(labels.map((label) => label.content.replace(/<[^>]+>/gu, ''))).toEqual(['相容', '冲突或不兼容']);
    expect(labels.every((label) => label.content.includes('font-size:16px'))).toBe(true);
    expect(nodes.every((node) => node.text?.content.includes('font-size:18px') && node.top + node.height <= 394)).toBe(true);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(5);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(diagram).toEqual(original);
  });

  it.each(['unknown-node', 'invalid-measurement'] as const)('does not downgrade %s to a native allocation diagnosis', async (failure) => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'invalid-native', topology: 'branch',
      left: 60, top: 106, width: 420, height: 288, orientation: 'vertical',
      nodes: [{ id: 'root', label: '新信息' }, { id: 'child', label: '同化' }],
      edges: [{ from: 'root', to: failure === 'unknown-node' ? 'unknown' : 'child' }] };
    const measure: TextMeasure = failure === 'invalid-measurement'
      ? (input) => ({ ...fontMeasure(input), naturalWidth: NaN }) : fontMeasure;
    const diagnostics: string[] = [];
    await expect(compileMeasuredDiagramComponent(diagram, measure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) }))
      .rejects.not.toBeInstanceOf(DiagramAllocationError);
    expect(diagnostics).toEqual([]);
  });

  it('measures horizontal step labels individually and puts their numbered circles above a clear straight sequence in 880×128', async () => {
    const names = ['创设情境', '进行“抛锚”', '自主探索', '拓展延伸', '讨论交流', '效果评价'];
    const diagram: DiagramComponent = { type: 'diagram', id: 'horizontal-steps', topology: 'sequence',
      left: 60, top: 256, width: 880, height: 128, orientation: 'horizontal', presentation: 'steps',
      nodes: names.map((label, index) => ({ id: `a${index + 1}`, label })),
      edges: names.slice(0, -1).map((_, index) => ({ from: `a${index + 1}`, to: `a${index + 2}` })) };
    const requestedWeights: number[] = [];
    const diagnostics: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, (input) => {
      requestedWeights.push(input.fontWeight);
      return fontMeasure(input);
    }, { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) });
    const labels = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-node-'));
    const numbers = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.includes('-number-'));
    const lines = elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(diagnostics).toEqual([]);
    expect(new Set(requestedWeights)).toEqual(new Set([400]));
    expect(labels.map((label) => label.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(names);
    expect(labels.map((label) => label.width)).toEqual([104, 138, 104, 104, 104, 104]);
    for (const [index, label] of labels.entries()) {
      expect(label.text?.content).toContain('font-size:18px;font-weight:400');
      expect(label.text?.content).not.toContain('<br>');
      expect(numbers[index]!.left + 14).toBe(label.left + label.width / 2);
      expect(numbers[index]!.top + 28 + 8).toBe(label.top);
      expect(label.left + label.width).toBeLessThanOrEqual(940);
      expect(label.top + label.height).toBeLessThanOrEqual(384);
    }
    expect(new Set(numbers.map((number) => number.top)).size).toBe(1);
    expect(lines).toHaveLength(5);
    for (const [index, line] of lines.entries()) {
      expect(line.id).toBe(`${diagram.id}-edge-${index}`);
      expect(line.width).toBe(1.5);
      expect(line.cubic).toBeUndefined();
      expect(absoluteStart(line)).toEqual([numbers[index]!.left + 28, numbers[index]!.top + 14]);
      expect(absoluteEnd(line)).toEqual([numbers[index + 1]!.left, numbers[index + 1]!.top + 14]);
      expect(labels[index + 1]!.left - labels[index]!.left - labels[index]!.width).toBeGreaterThanOrEqual(16);
    }
    expect(nativeSlideCollisions(elements)).toEqual([]);
    const diagnosticsTooNarrow: string[] = [];
    await expect(compileMeasuredDiagramComponent({ ...diagram, width: 700 }, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnosticsTooNarrow.push(detail) }))
      .rejects.toBeInstanceOf(DiagramAllocationError);
    expect(diagnosticsTooNarrow).toEqual([]);
  });

  it('refuses the simple steps style for a graph with a real feedback relation instead of dropping its extra edge', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'feedback-steps', topology: 'sequence',
      left: 60, top: 150, width: 880, height: 350, orientation: 'horizontal', presentation: 'steps',
      nodes: ['观察', '练习', '评估'].map((label, index) => ({ id: `s${index}`, label })),
      edges: [{ from: 's0', to: 's1' }, { from: 's1', to: 's2' }, { from: 's2', to: 's0', label: '再练习' }] };
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true }))
      .rejects.toThrow('steps presentation needs one real ordered sequence');
  });

  it('reports a typed native allocation failure for an infeasible shallow area instead of returning a grid or off-canvas directional draft', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'shallow-steps', topology: 'sequence',
      left: 60, top: 262, width: 880, height: 152, orientation: 'vertical', presentation: 'steps',
      nodes: fullStepNames.map((label, index) => ({ id: `s${index + 1}`, label })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}` })) };
    const diagnostics: string[] = [];
    const original = structuredClone(diagram);
    await expect(compileMeasuredDiagramComponent(diagram, fontMeasure,
      { nodeFontSize: 18, preserveNativeComposition: true, onDiagnostic: (detail) => diagnostics.push(detail) }))
      .rejects.toMatchObject({ name: 'DiagramAllocationError', code: 'diagram-allocation',
        authoredAllocation: { left: 60, top: 262, width: 880, height: 152 }, feasibleAllocations: [] });
    expect(diagnostics).toEqual([]);
    expect(diagram).toEqual(original);
    const legacy = await compileMeasuredDiagramComponent(diagram, fontMeasure,
      { nodeFontSize: 18, onDiagnostic: (detail) => diagnostics.push(detail) });
    expect(legacy.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(diagnostics).toEqual([expect.stringContaining('basic editable layout')]);
  });

  it('reserves the measured full caption before retaining an overloaded local graph for review', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'captioned-review', topology: 'sequence',
      left: 60, top: 280, width: 880, height: 190, orientation: 'vertical',
      annotation: '围绕同一个真实情境展开分析，保留必要条件和观察材料。'.repeat(4),
      nodes: fullStepNames.map((label, index) => ({ id: `s${index + 1}`, label })),
      edges: fullStepNames.slice(0, -1).map((_, index) => ({ from: `s${index + 1}`, to: `s${index + 2}` })) };
    const saved = structuredClone(diagram), diagnoses: string[] = [];
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure,
      { nodeFontSize: 18, onDiagnostic: (value) => diagnoses.push(value) });
    const annotation = elements.find((element): element is PPTTextElement => element.type === 'text'
      && element.id === `${diagram.id}-annotation`)!;
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    expect(annotation.height).toBeGreaterThan(60);
    expect(annotation.content.replace(/<[^>]+>/gu, '')).toBe(diagram.annotation);
    expect(nodes).toHaveLength(7);
    expect(nodes.every((node) => node.top >= annotation.top + annotation.height + 12)).toBe(true);
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(fullStepNames);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(diagnoses).toEqual([expect.stringContaining('basic editable layout')]);
    expect(diagram).toEqual(saved);
  });

  it('preserves the approved six-node vertical fork/merge composition in its 520×260 region', async () => {
    const diagram: DiagramComponent = { type: 'diagram', id: 'approved-branch', topology: 'branch',
      left: 60, top: 176, width: 520, height: 260, orientation: 'vertical',
      nodes: [{ id: 'info', label: '新信息或经验' }, { id: 'compatible', label: '与原有结构兼容' },
        { id: 'assimilation', label: '同化' }, { id: 'conflict', label: '与原有结构冲突' },
        { id: 'accommodation', label: '顺应' }, { id: 'development', label: '认知发展' }],
      edges: [{ from: 'info', to: 'compatible' }, { from: 'compatible', to: 'assimilation' },
        { from: 'info', to: 'conflict' }, { from: 'conflict', to: 'accommodation' },
        { from: 'assimilation', to: 'development' }, { from: 'accommodation', to: 'development' }] };
    const elements = await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18 });
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape');
    const byId = new Map(nodes.map((node) => [node.id.replace(`${diagram.id}-node-`, ''), node]));
    expect(byId.get('compatible')!.top).toBe(byId.get('conflict')!.top);
    expect(byId.get('assimilation')!.top).toBe(byId.get('accommodation')!.top);
    expect(byId.get('info')!.top).toBeLessThan(byId.get('compatible')!.top);
    expect(byId.get('assimilation')!.top).toBeGreaterThan(byId.get('compatible')!.top);
    expect(byId.get('development')!.top).toBeGreaterThan(byId.get('assimilation')!.top);
    expect(nodes.every((node) => node.text?.content.includes('font-size:18px') && node.top + node.height <= 436)).toBe(true);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(nativeSlideCollisions(elements)).toEqual([]);
    expect(await compileMeasuredDiagramComponent(diagram, fontMeasure, { nodeFontSize: 18, preserveNativeComposition: true }))
      .toEqual(elements);
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

  it('rejects a seven-step sequence when neither straight arrangement fits the container', () => {
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
