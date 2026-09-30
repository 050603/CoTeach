import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '../src/scene-generator.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';

const outline: SceneOutline = {
  id: 'first-pass-slide', type: 'slide', title: '七步设计闭环', description: '七个步骤形成循环。',
  keyPoints: ['每步衔接下一步', '整体反馈用于调整'], order: 0,
  visualIntent: {
    representation: 'native-diagram', observationGoal: '七步如何组成闭环',
    diagram: {
      topology: 'cycle',
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, label: `设计步骤${index + 1}` })),
      annotation: '闭环用于反馈调整',
    },
  },
};

const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const lines = text.split(/\n/).filter(Boolean);
  return { naturalWidth: Math.max(...lines.map((line) => Array.from(line).length * fontSize)),
    height: padding * 2 + lines.length * fontSize * lineHeight, lines };
};

describe('first-draft component authoring in the production package', () => {
  it('compiles concise adopted presentation points from paragraphRefs in the first and only content call', async () => {
    const points = [
      { id: 'scope', text: '先明确概念边界。' },
      { id: 'condition', text: '满足适用条件后，再选择方法。' },
      { id: 'feedback', text: '根据课堂反馈调整设计。' },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'textBox', role: 'body', left: 60, top: 140, width: 880, fontSize: 23,
        paragraphRefs: points.map((point) => point.id) },
    ] }));
    const measured = vi.fn(measure);
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measured, authoringContent: points, onFailure: failure,
    });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('BEFORE measuring');
    expect(ai.mock.calls[0][1]).toContain(JSON.stringify(points));
    expect(failure).not.toHaveBeenCalled();
    const elements = slide && 'elements' in slide ? slide.elements : [];
    const content = elements.filter((element) => element.type === 'text').map((element) => element.content).join('\n');
    for (const point of points) expect(content).toContain(point.text);
    expect(content.indexOf(points[0].text)).toBeLessThan(content.indexOf(points[1].text));
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 23, text: expect.stringContaining(points[1].text) }));
    expect(elements).toHaveLength(1);
    expect(slide).not.toHaveProperty('continuationPages');
  });

  it.each(['native', 'flow'] as const)('makes the %s reference examples directly compilable in one content call', async (slideAuthoring) => {
    const points = [{ id: 'adopted-content-1', text: '在适用条件下选择方法。' },
      { id: 'adopted-content-2', text: '根据反馈调整设计。' }];
    const ai = vi.fn(async (system: string, user: string) => {
      expect(system).toContain('FINAL selected display content for THIS page');
      expect(system).toContain('take precedence over instructions to shorten or rewrite text');
      expect(system).toContain('OMIT header in EVERY row');
      expect(user).toContain(`Required display-reference ids (2): ${JSON.stringify(points.map((point) => point.id))}`);
      const examples = JSON.parse(user.match(/Accepted reference-slot JSON examples: ([^\n]+)/u)![1]);
      if (slideAuthoring === 'flow') {
        expect(examples).not.toHaveProperty('richText');
        expect(examples.labelGrid).not.toHaveProperty('left');
        return JSON.stringify({ layout: { groups: [examples.labelGrid] } });
      }
      expect(examples.richText).toMatchObject({ type: 'text', contentRef: points[0].id });
      expect(examples.tableCell).toHaveProperty('contentRef', points[0].id);
      return JSON.stringify({ components: [examples.labelGrid] });
    });
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, slideAuthoring, textMeasure: measure, authoringContent: points, onFailure: failure,
    });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    const text = slide && 'elements' in slide ? slide.elements.filter((element) => element.type === 'text')
      .map((element) => element.content).join('\n') : '';
    for (const point of points) expect(text).toContain(point.text);
  });

  it.each([
    { rows: [{ header: '维度', cells: [{ contentRef: 'a' }] }, { cells: [{ contentRef: 'b' }] }] },
    { rows: [{ cells: [{ contentRef: 'a' }] }, { cells: [{ contentRef: 'b' }, 'extra'] }] },
    { rows: [{ cells: [{ contentRef: 'a' }] }, { cells: [] }] },
  ])('keeps malformed referenced grids strict without inventing missing cells or headings', async ({ rows }) => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'labelGrid', left: 60, top: 140, width: 880, height: 220, rows },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measure, authoringContent: [{ id: 'a', text: '先明确条件。' }, { id: 'b', text: '再选择方法。' }],
      onFailure: failure,
    })).toBeNull();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('equal, nonempty cells and consistent headers') }));
  });

  it('rejects unknown model references before compiling returned content and omits no adopted points', async () => {
    const points = [{ id: 'condition', text: '满足适用条件后，再选择方法。' }, { id: 'feedback', text: '根据反馈调整设计。' }];
    const failure = vi.fn();
    const measured = vi.fn(measure);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'textBox', left: 60, top: 140, width: 880, contentRef: 'unknown' },
    ] }));
    const options = { componentAuthoring: true, textMeasure: measured, authoringContent: points, onFailure: failure };
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options)).toBeNull();
    // First-pass hints measure the trusted catalog before the model call.
    // The unknown returned reference never supplies text to the measurer.
    expect(measured.mock.calls.every(([input]) => points.some((point) => point.text === input.text))).toBe(true);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('unknown content reference') }));
    ai.mockResolvedValue(JSON.stringify({ components: [{ kind: 'textBox', left: 60, top: 140, width: 880, contentRef: 'condition' }] }));
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options)).toBeNull();
    expect(ai).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringContaining('feedback') }));
  });

  it('supplies real native-font allocations before the first call and compiles the chosen full point', async () => {
    const point = { id: 'adopted-content-1', text: '条件明确之后，再选择方法。' };
    const measured: TextMeasure = vi.fn((input: Parameters<TextMeasure>[0]) => ({
      naturalWidth: 320, height: input.fontSize === 22 ? 62.5 : 74.25,
      inkBottom: input.fontSize === 22 ? 65.2 : 78.1, inkRight: 340, lines: [input.text],
    }));
    const ai = vi.fn(async (_system: string, user: string) => {
      const candidates = JSON.parse(user.match(/Measured adopted-point native text-space candidates: ([^\n]+)/u)![1]);
      expect(candidates).toContainEqual({ contentRef: point.id, fontSize: 22, width: 440, height: 66 });
      expect(candidates).toContainEqual({ contentRef: point.id, fontSize: 24, width: 880, height: 79 });
      expect(user).toContain('original height lookup table is not authoritative');
      const chosen = candidates.find((candidate: { fontSize: number; width: number }) => candidate.fontSize === 22 && candidate.width === 440);
      return JSON.stringify({ elements: [{ type: 'text', id: 'rich-point', left: 60, top: 140,
        width: chosen.width, height: chosen.height, contentRef: point.id, content: '<p style="font-size:22px;color:#334155"></p>' }] });
    });
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measured, authoringContent: [point], onFailure: failure,
    });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    expect(slide && 'elements' in slide ? slide.elements[0] : null).toMatchObject({ width: 440, height: 66,
      content: `<p style="font-size:22px;color:#334155">${point.text}</p>` });
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 22, width: 440,
      padding: 10, fontFamily: 'Noto Sans SC', preserveRichText: true, text: point.text }));
  });

  it('omits zero, failed and unreadable measurements instead of presenting them as feasible native slots', async () => {
    const point = { id: 'adopted-content-1', text: '条件清楚以后，才能选择合适方法。' };
    const measured: TextMeasure = ({ text, fontSize, width }) => {
      if (fontSize === 22 && width === 440) return { naturalWidth: 300, height: 0, lines: [text] };
      if (fontSize === 24 && width === 440) throw new Error('measurement provider unavailable');
      if (fontSize === 22 && width === 880) return { naturalWidth: 500, height: 84, lines: [text.slice(0, -2), text.slice(-2)] };
      return { naturalWidth: 500, height: 60, lines: [text] };
    };
    const ai = vi.fn(async (_system: string, user: string) => {
      expect(JSON.parse(user.match(/Measured adopted-point native text-space candidates: ([^\n]+)/u)![1]))
        .toEqual([{ contentRef: point.id, fontSize: 24, width: 880, height: 60 }]);
      return JSON.stringify({ elements: [{ type: 'text', left: 60, top: 140, width: 880, height: 60,
        contentRef: point.id, content: '<p style="font-size:24px"></p>' }] });
    });
    const failure = vi.fn();
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measured, authoringContent: [point], onFailure: failure,
    })).not.toBeNull();
    expect(failure).not.toHaveBeenCalled();
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('binds native rich text, table cells and labelGrid cells before their first font measurement', async () => {
    const points = [{ id: 'definition', text: '先明确概念边界。' }, { id: 'condition', text: '在适用条件下选择方法。' },
      { id: 'feedback', text: '根据反馈调整设计。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'definition', type: 'text', left: 60, top: 140, width: 880, height: 70,
        contentRef: 'definition', content: '<p style="font-size:21px;color:#223344"><strong>待填入</strong></p>' },
      { id: 'conditions', type: 'table', left: 60, top: 240, width: 880, height: 70, colWidths: [1], cellMinHeight: 70,
        data: [[{ id: 'condition-cell', contentRef: 'condition', rowspan: 1, colspan: 1, style: { fontsize: 19 } }]] },
    ], components: [{ kind: 'labelGrid', left: 60, top: 340, width: 880, height: 100, fontSize: 20,
      rows: [{ cells: [{ contentRef: 'feedback' }] }] }] }));
    const measured = vi.fn(measure);
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measured, authoringContent: points, onFailure: failure,
    });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    expect(slide && 'elements' in slide ? slide.elements.find((element) => element.id === 'definition') : null)
      .toMatchObject({ content: `<p style="font-size:21px;color:#223344"><strong>${points[0].text}</strong></p>` });
    for (const [index, fontSize] of [21, 19, 20].entries()) expect(measured)
      .toHaveBeenCalledWith(expect.objectContaining({ fontSize, text: expect.stringContaining(points[index].text) }));
    expect(slide && 'elements' in slide ? slide.elements.some((element) => element.type === 'table') : false).toBe(true);
  });

  it('rejects an adopted point that cannot fit at its authored native font instead of shortening it', async () => {
    const point = { id: 'definition', text: '完整概念保留全部适用条件与结论。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { type: 'text', left: 60, top: 140, width: 120, height: 30, contentRef: point.id, content: '<p style="font-size:24px">原占位</p>' },
    ] }));
    const failure = vi.fn();
    const measured: TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({ naturalWidth: [...text].length * fontSize,
      height: padding * 2 + fontSize * lineHeight * 3, lines: ['完整概念保留', '全部适用条件', '与结论。'] });
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai, {
      componentAuthoring: true, textMeasure: measured, authoringContent: [point], onFailure: failure,
    })).toBeNull();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: 'layout-conflict', detail: expect.stringContaining('exceeds its authored') }));
  });

  it.each([{ type: 'diagram' }, { kind: 'diagram' }, { type: 'diagram', kind: 'diagram' }])(
    'compiles the authoritative branch with %j in one content call without adding transitions between alternatives', async (tags) => {
    const diagram: NonNullable<NonNullable<SceneOutline['visualIntent']>['diagram']> = {
      topology: 'branch',
      nodes: [{ id: 'core', label: '确定核心关系' }, { id: 'contrast', label: '正反例对比' },
        { id: 'animation', label: '演示动画' }, { id: 'experience', label: '具身体验' }],
      edges: [{ from: 'core', to: 'contrast' }, { from: 'core', to: 'animation' }, { from: 'core', to: 'experience' }],
      annotation: '根据内容和学段选择一种或多种呈现方式',
    };
    const branchOutline: SceneOutline = { ...outline, title: '人工智能原理的可视化转化',
      visualIntent: { representation: 'native-diagram', observationGoal: '核心关系如何决定呈现方式', diagram } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 84, text: branchOutline.title },
      { ...tags, id: 'fork', left: 50, top: 140, width: 900, height: 330,
        topology: 'sequence', nodes: [{ id: 'wrong', label: '不得采用的节点' }] },
    ] }));
    const failure = vi.fn();
    const slide = await generateSceneContent(branchOutline, ai, {
      componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure, onFailure: failure,
    });
    expect(failure).not.toHaveBeenCalled();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('sequence|cycle|branch');
    expect(ai.mock.calls[0][1]).toContain('"topology":"branch"');
    const elements = slide && 'elements' in slide ? slide.elements : [];
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(3);
    const nodes = elements.filter((element) => element.type === 'shape');
    expect(nodes.map((node) => node.id)).toEqual(diagram.nodes.map((node) => `${branchOutline.id}-component-1-node-${node.id}`));
    expect(nodes.map((node) => node.text?.content.replace(/<[^>]+>/gu, ''))).toEqual(diagram.nodes.map((node) => node.label));
    expect(elements.some((element) => element.type === 'text' && element.content.includes(diagram.annotation!))).toBe(true);
  });

  it('keeps flow behind an explicit authoring option', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ layout: { groups: [{ kind: 'textBox', text: 'native slide expected' }] } }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith({ code: 'invalid-model-output', detail: expect.stringContaining('flow layout is opt-in') });
  });

  it('authors a complete diagram whose measured annotation cannot fit its native region in flow on the first content call', async () => {
    const labels = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计',
      '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
    const diagram = {
      topology: 'cycle' as const,
      nodes: labels.map((label, index) => ({ id: `s${index + 1}`, label })),
      annotation: '七个步骤构成闭环：可正向开发课程，也可反向查漏补缺、用于教学反思与迭代。'.repeat(6),
    };
    const longOutline: SceneOutline = { ...outline, title: '建构主义教学设计的七个步骤',
      visualIntent: { representation: 'native-diagram', observationGoal: '七个步骤的顺序与闭环关系', diagram } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ layout: { groups: [
      { kind: 'diagram', ...diagram },
      { kind: 'textBox', text: '教学目标分析确定教学的核心主题，后面各步围绕它展开。', role: 'body' },
      { kind: 'textBox', text: '协作学习环境设计中，教师提出初始讨论问题并追问。', role: 'body' },
    ] } }));
    const failure = vi.fn();
    const wrappingMeasure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
      const count = Math.max(1, Math.floor((width - padding * 2) / fontSize));
      const lines = text.match(new RegExp(`.{1,${count}}`, 'gu')) ?? [];
      return { naturalWidth: [...text].length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
    };
    const slide = await generateSceneContent(longOutline, ai, { componentAuthoring: true, textMeasure: wrappingMeasure, onFailure: failure });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('First-draft component authoring');
    expect(ai.mock.calls[0][1]).toContain('Return the flow-layout JSON');
    expect(failure).not.toHaveBeenCalled();
    expect(slide && 'elements' in slide ? slide.elements.filter((element) => element.type === 'line') : []).toHaveLength(7);
    expect(slide && 'elements' in slide ? slide.continuationPages?.flatMap((page) => page.elements)
      .some((element) => element.type === 'text' && element.content.includes('协作学习环境设计')) : false).toBe(true);
  });

  it('authors both independent flows in one composite diagram without adding a cross-flow edge', async () => {
    const diagram = { topology: 'sequence' as const,
      nodes: [{ id: 'a1', label: '回顾旧知' }, { id: 'a2', label: '实践探究' }, { id: 'a3', label: '课堂小结' },
        { id: 'b1', label: '提出问题' }, { id: 'b2', label: '任务分析' }, { id: 'b3', label: '反思总结' }],
      edges: [{ from: 'a1', to: 'a2' }, { from: 'a2', to: 'a3' }, { from: 'b1', to: 'b2' }, { from: 'b2', to: 'b3' }],
      annotation: '第一类用于新概念学习；第二类用于综合项目实现。',
    };
    const parallelOutline: SceneOutline = { ...outline, title: '两类学习活动流程', visualIntent: {
      representation: 'native-diagram', observationGoal: '对比两类独立流程', diagram,
    } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, text: parallelOutline.title },
      { type: 'diagram', id: 'flows', left: 50, top: 140, width: 900, height: 360 },
    ] }));
    const failure = vi.fn();
    const slide = await generateSceneContent(parallelOutline, ai, { componentAuthoring: true, textMeasure: measure, onFailure: failure });
    expect(failure).not.toHaveBeenCalled();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][1]).toContain('"sequenceGroups":');
    expect(ai.mock.calls[0][1]).toContain('ONE components entry');
    const elements = slide && 'elements' in slide ? slide.elements : [];
    expect(elements.filter((element) => element.type === 'shape')).toHaveLength(6);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(4);
  });

  it.each([{ tags: [] }, { tags: ['type', 'type'] }, { tags: ['kind', 'kind'] }, { tags: ['type', 'kind'] }])(
    'rejects missing or duplicate planned diagrams across discriminator forms %j', async ({ tags }) => {
    const count = tags.length;
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: tags.map((tag) => ({
      [tag]: 'diagram', left: 50, top: 140, width: 900, height: 330,
    })) }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining(`received ${count}`) }));
    expect(failure.mock.calls[0]?.[0]?.detail).toContain('exactly one components entry');
  });

  it('rejects a conflicting native component discriminator before the planned diagram count gate', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { type: 'text', kind: 'diagram', left: 50, top: 140, width: 900, height: 330 },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('type and kind must not conflict') }));
    expect(failure.mock.calls[0]?.[0]?.detail).not.toContain('received 0');
  });

  it.each(['type', 'kind'])('reports complete measured choices for an undersized %s diagram without expanding it', async (tag) => {
    const diagram = { topology: 'sequence' as const,
      nodes: ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计']
        .map((label, index) => ({ id: String(index), label })),
      annotation: '全部七步与四要素之间的关系都需要保持完整。',
    };
    const measured: TextMeasure = (input) => input.text === diagram.annotation
      ? { naturalWidth: 800, height: 128, lines: [input.text] } : measure(input);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { [tag]: 'diagram', left: 50, top: 272, width: 900, height: 240 },
    ] }));
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: { ...outline.visualIntent!, diagram } }, ai,
      { componentAuthoring: true, textMeasure: measured, onFailure: failure });
    expect(slide).toBeNull();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: 'layout-conflict', detail: expect.stringContaining('900×240px at 50,272') }));
    expect(failure.mock.calls[0]?.[0]?.detail).toContain('900×360px');
    expect(failure.mock.calls[0]?.[0]?.detail).toContain('all nodes, edges and annotation');
  });

  it('preserves native surfaces, rich text and actual tables without forcing components', async () => {
    const rich = '<p style="font-size:16px;color:#334155"><strong>同化：</strong>使用已有结构理解信息</p>';
    const source = { elements: [
      { id: 'surface', type: 'shape', left: 60, top: 120, width: 880, height: 100, path: 'M0 0 L880 0 L880 100 L0 100 Z', viewBox: [880, 100], fill: '#F0F5FA' },
      { id: 'explanation', type: 'text', left: 80, top: 140, width: 840, height: 60, content: rich },
      { id: 'comparison', type: 'table', left: 60, top: 240, width: 880, height: 100, colWidths: [0.3, 0.7], cellMinHeight: 50,
        data: [[{ id: 'a', text: '同化', colspan: 1, rowspan: 1, style: { fontsize: 16, bold: true } }, { id: 'b', text: '认知结构保持不变', colspan: 1, rowspan: 1, style: { fontsize: 16 } }]], outline: { width: 1, color: '#D0D8E0' } },
    ] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(source));
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, { componentAuthoring: true, textMeasure: measure });
    expect(slide && 'elements' in slide ? slide.elements.map((element) => element.type) : []).toEqual(['shape', 'text', 'table']);
    expect(slide && 'elements' in slide ? slide.elements.find((element) => element.id === 'explanation') : null).toMatchObject({ content: rich, width: 840, height: 60 });
    expect(ai.mock.calls[0][0]).toContain('Slide Content Philosophy');
    expect(ai.mock.calls[0][0]).toContain('TableElement');
    expect(slide).not.toHaveProperty('continuationPages');
  });

  it('rejects the first draft when native peer panels and teaching text overlap', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'panel_b_bg', type: 'shape', left: 510, top: 178, width: 430, height: 118, fill: '#F1F5F9' },
      { id: 'sidebar_bg', type: 'shape', left: 668, top: 178, width: 272, height: 328, fill: '#F8FAFC' },
      { id: 'panel_b_text', type: 'text', left: 530, top: 190, width: 390, height: 94,
        content: '<p style="font-size:18px">AI课中的身体参与</p>' },
      { id: 'unit_c_text', type: 'text', left: 684, top: 190, width: 240, height: 142,
        content: '<p style="font-size:18px">环境的三类设计</p>' },
    ] }));
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measure, onFailure: failure });
    expect(slide).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output', category: 'layout-conflict',
      detail: expect.stringContaining('panel_b_text overlaps unit_c_text') }));
    expect(failure.mock.calls[0]?.[0]?.detail).toContain('panel_b_bg and sidebar_bg overlap');
  });

  it('accepts text inside separate content panels', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'left_bg', type: 'shape', left: 60, top: 178, width: 430, height: 118, fill: '#F1F5F9' },
      { id: 'right_bg', type: 'shape', left: 510, top: 178, width: 430, height: 118, fill: '#F8FAFC' },
      { id: 'left_text', type: 'text', left: 80, top: 190, width: 390, height: 94,
        content: '<p style="font-size:18px">身体参与</p>' },
      { id: 'right_text', type: 'text', left: 530, top: 190, width: 390, height: 94,
        content: '<p style="font-size:18px">环境反馈</p>' },
    ] }));
    const failure = vi.fn();
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measure, onFailure: failure });
    expect(slide && 'elements' in slide ? slide.elements : []).toHaveLength(4);
    expect(failure).not.toHaveBeenCalled();
  });

  it('deterministically disambiguates repeated model IDs without replacing valid IDs', async () => {
    const source = { elements: ['same-id', 'same-id', `${outline.id}-element-1`].map((id, index) => ({
      id, type: 'text', left: 60, top: 120 + index * 80, width: 800, height: 60,
      content: `<p style="font-size:16px">完整说明${index + 1}</p>`,
    })) };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(source));
    const options = { componentAuthoring: true, textMeasure: measure };
    const first = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options);
    const second = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options);
    const ids = (slide: typeof first) => slide && 'elements' in slide ? slide.elements.map((element) => element.id) : [];
    expect(ids(first)).toEqual(['same-id', `${outline.id}-element-1-2`, `${outline.id}-element-1`]);
    expect(ids(second)).toEqual(ids(first));
    expect(new Set(ids(first)).size).toBe(3);
  });

  it('compiles title and authoritative circular plan in the same content request', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ background: { type: 'solid', color: '#ffffff' }, elements: [], components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 84, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 160, width: 860, height: 330,
        topology: 'sequence', nodes: [{ id: 'wrong', label: 'wrong' }] },
    ] }));
    const slide = await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('Optional first-draft measured components');
    expect(ai.mock.calls[0][0]).toContain('Do not force introductory examples');
    expect(ai.mock.calls[0][1]).toContain('Measured feasible diagram rectangles');
    expect(ai.mock.calls[0][1]).toMatch(/\{\"width\":900,\"height\":\d+\}/);
    expect(ai.mock.calls[0][0]).toContain('Text Height Lookup Table');
    expect(ai.mock.calls[0][1]).toContain('All TextElement `height` values');
    expect(slide && 'elements' in slide ? slide.elements.filter((item) => item.type === 'line') : []).toHaveLength(7);
    expect(slide && 'elements' in slide ? slide.elements.some((item) => item.type === 'text' && item.content.includes('闭环用于反馈调整')) : false).toBe(true);
    expect(slide && 'elements' in slide ? slide.elements.some((item) => item.type === 'shape' && 'text' in item && String(item.text?.content).includes('wrong')) : false).toBe(false);
  });

  it('rejects a missing planned relationship even when native text is valid', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { type: 'text', left: 60, top: 50, width: 880, height: 70, content: '<p>标题</p>' },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output', detail: expect.any(String) }));
  });

  it('accepts a component-only response that omits an unused native elements array', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 84, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 160, width: 860, height: 330,
        topology: 'cycle', nodes: outline.visualIntent?.diagram?.nodes },
    ] }));
    const slide = await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure });
    expect(slide && 'elements' in slide ? slide.elements.filter((item) => item.type === 'line') : []).toHaveLength(7);
  });

  it('uses measured component height when a model guesses an undersized maximum', async () => {
    const body = '任务要承载完整的教学解释';
    const measureOverflow: TextMeasure = (input) => input.text.includes(body)
      ? { naturalWidth: 400, height: 128, lines: [body] }
      : measure(input);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', left: 60, top: 140, width: 500, maxHeight: 120, text: body, fontSize: 18 },
      { kind: 'textBox', left: 60, top: 300, width: 500, text: '下一项', fontSize: 18 },
    ] }));
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measureOverflow });
    const text = slide && 'elements' in slide ? slide.elements.find((item) => item.type === 'text' && item.content.includes(body)) : undefined;
    expect(text).toMatchObject({ top: 140, height: 128 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('still rejects measured growth that collides with another foreground component', async () => {
    const body = '任务要承载完整的教学解释';
    const measureOverflow: TextMeasure = (input) => input.text.includes(body)
      ? { naturalWidth: 400, height: 128, lines: [body] }
      : measure(input);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', left: 60, top: 140, width: 500, maxHeight: 120, text: body, fontSize: 18 },
      { kind: 'textBox', left: 60, top: 260, width: 500, text: '下一项', fontSize: 18 },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measureOverflow, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'invalid-model-output', detail: expect.stringContaining('overlap'),
    }));
  });

  it('rejects overlapping allocations using measured text height, not the model hint', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 20, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 110, width: 860, height: 330,
        topology: 'cycle', nodes: outline.visualIntent?.diagram?.nodes },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output', detail: expect.any(String) }));
  });
});
