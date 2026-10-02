import { describe, expect, it, vi } from 'vitest';
import type { TeachingVisualComponent, TeachingVisualScene, VisualNode } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { generateTeachingVisualScene, parseTeachingVisualScene, teachingVisualComponentProjection,
  teachingVisualSceneProjection, teachingVisualSceneIssues, normalizeTeachingVisualPageOrder,
  TEACHING_VISUAL_ICONS, TEACHING_VISUAL_OPERATION, TEACHING_VISUAL_PLANNING_VERSION, usesTeachingVisualScene,
  type TeachingVisualSceneOptions } from './teaching-visual-scene';
import { slideVisualSourceContent } from './slide-visual-projection';
import { pageOriginalTeachingSources } from './source-grounding';
import savedCourse16 from './__fixtures__/teaching-visual-course-16-adopted-case.json';

function outline(points: string[]): SceneOutline {
  return { id: 'page-19', type: 'slide', title: '支架逐步撤除', order: 18, description: '能力与支持的变化', keyPoints: points,
    audience: 'student', generationPurpose: 'knowledge-teaching', teachingBrief: {
      schemaVersion: 1, explanation: points.join('。'), examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: points.join('。'), learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: points, presentationContent: points, narrationFocus: [] },
    } };
}
function node(id: string, text: string, source = 'adopted-content-1', extra: Partial<VisualNode> = {}): VisualNode {
  return { id, text, sourceContentIds: [source], ...extra };
}
function scene(components: TeachingVisualComponent[]): TeachingVisualScene {
  return { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: 'model-page', title: '能力与支持', focus: '观察渐变', components }] };
}
function textScene(text: string): TeachingVisualScene {
  return scene([{ id: 'main', kind: 'text', nodes: [node('fact', text)] }]);
}

describe('adopted constructed cases keep their own provenance', () => {
  const fixture = savedCourse16 as unknown as { outline: SceneOutline; sourceOptions: TeachingVisualSceneOptions;
    rawResponse: string; originalTeachingSources: ReturnType<typeof pageOriginalTeachingSources> };
  const caseId = 'adopted-case:teaching-section-5-unit-2-review-1';
  const actual = () => ({ page: structuredClone(fixture.outline), design: parseTeachingVisualScene(fixture.rawResponse),
    options: structuredClone(fixture.sourceOptions) });

  it('recovers the untouched real page 16 response from its canonical case while keeping the complete textbook catalog unchanged', async () => {
    const { page, design, options } = actual(), before = structuredClone({ page, design, options });
    const sources = slideVisualSourceContent(page);
    expect(teachingVisualSceneIssues(design, page, sources, options)).toEqual([
      'Missing adopted evidence for formal-operation', 'Missing adopted evidence for formal-knowledge',
    ]);
    const ai = vi.fn().mockResolvedValue(fixture.rawResponse);
    const result = await generateTeachingVisualScene(page, ai, options);
    expect(result?.diagnostics).toEqual([]);
    expect(TEACHING_VISUAL_PLANNING_VERSION).toBe('teaching-visual-planning-v4');
    expect(result?.normalizationDiagnostics).toHaveLength(2);
    expect(result?.normalizationDiagnostics?.every((message) => message.includes(caseId) && message.includes('textbook sources were unchanged'))).toBe(true);
    const expected = structuredClone(design);
    expected.pages[0]!.components[0]!.nodes.slice(0, 2).forEach((item) => { item.sourceEvidenceIds = [caseId]; });
    expect(result?.scene).toEqual(expected);
    expect(teachingVisualSceneIssues(result!.scene, page, sources, options)).toEqual([]);
    const prompt = JSON.parse(ai.mock.calls[0]![1]);
    expect(prompt.originalTeachingSources).toEqual(fixture.originalTeachingSources);
    expect(prompt.adoptedTeachingMaterials).toEqual([{
      id: caseId, reviewItemId: 'teaching-section-5-unit-2-review-1', outlineId: page.id,
      kind: 'constructed-example', provenance: 'constructed', content: page.teachingBrief!.reviewItems![0]!.content,
      observations: [{ sourceContentId: 'adopted-content-4', text: page.keyPoints[3] }],
    }]);
    expect(prompt.originalTeachingSources.originalQuotes.some((quote: string) => quote.includes('观看演示'))).toBe(false);
    expect(ai.mock.calls[0]![0]).toContain('绝不是教材quote');
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]).toHaveLength(2);
    expect({ page, design, options }).toEqual(before);
    expect(parseTeachingVisualScene(fixture.rawResponse).pages[0]!.components[0]!.nodes[0]!.sourceEvidenceIds).toBeUndefined();
  });

  it('accepts an explicit verified case reference without normalization but does not use it for a principle', async () => {
    const { page, design, options } = actual();
    design.pages[0]!.components[0]!.nodes.slice(0, 2).forEach((item) => { item.sourceEvidenceIds = [caseId]; });
    const valid = await generate(page, design, options);
    expect(valid.result?.diagnostics).toEqual([]);
    expect(valid.result?.normalizationDiagnostics).toBeUndefined();
    design.pages[0]!.components[1]!.nodes[0]!.sourceEvidenceIds = [caseId];
    const invalid = await generate(page, design, options);
    expect(invalid.result?.diagnostics).toContain('Invalid adopted case evidence for task-carrier');
    expect(invalid.result?.normalizationDiagnostics).toBeUndefined();
  });

  it.each(['unverified', 'foreign-outline', 'foreign-section', 'unresolved-scene', 'unknown-case', 'ambiguous-case', 'wrong-role',
    'foreign-explanation-node', 'unknown-source', 'mixed-source', 'missing-outcome', 'positive-substring',
    'cross-page', 'cross-component', 'wrong-column', 'claim-as-row', 'unrelated-row', 'explicit-unknown-id', 'uncited-principle'] as const)
    ('keeps the real source failure for %s instead of attaching a convenient textbook or case ID', async (failure) => {
      const { page, design, options } = actual(), formal = design.pages[0]!.components[0]!.nodes;
      const review = page.teachingBrief!.reviewItems![0]!;
      if (failure === 'unverified') review.provenance = 'unverified';
      if (failure === 'foreign-outline') review.outlineId = 'another-page';
      if (failure === 'foreign-section') review.sectionId = 'another-section';
      if (failure === 'unresolved-scene') review.sceneId = 'another-scene';
      if (failure === 'unknown-case') review.content = '另一个没有被采用的课堂场景。';
      if (failure === 'ambiguous-case') page.teachingBrief!.reviewItems!.push({ ...review, id: 'different-case-with-same-words' });
      if (failure === 'wrong-role') page.teachingBrief!.teachingPlan!.presentationItems![3]!.role = 'key-point';
      if (failure === 'foreign-explanation-node') page.teachingBrief!.teachingPlan!.presentationItems![3]!.nodeIds = ['prior-page-case'];
      if (failure === 'unknown-source') formal[0]!.sourceContentIds = ['not-the-adopted-case'];
      if (failure === 'mixed-source') formal[0]!.sourceContentIds.push('adopted-content-3');
      if (failure === 'missing-outcome') formal[0]!.text = '观看演示后填写定义';
      if (failure === 'positive-substring') formal[1]!.text = '需要调用目标知识';
      if (failure === 'wrong-column') formal[1]!.column = '其他设计';
      if (failure === 'claim-as-row') formal[1]!.row = '必须调用目标知识';
      if (failure === 'unrelated-row') formal[1]!.row = '教师表现';
      if (failure === 'explicit-unknown-id') formal[0]!.sourceEvidenceIds = ['adopted-case:unadopted'];
      if (failure === 'uncited-principle') delete design.pages[0]!.components[1]!.nodes[0]!.sourceEvidenceIds;
      if (failure === 'cross-page' || failure === 'cross-component') {
        const other = { id: 'separate-case', kind: 'text' as const, nodes: [formal.splice(1, 1)[0]!] };
        if (failure === 'cross-page') design.pages.push({ id: 'later-case', title: '后续', focus: '后续', components: [other] });
        else design.pages[0]!.components.push(other);
      }
      const { result, ai } = await generate(page, design, options);
      expect(result?.diagnostics.some((message) => /(?:Missing adopted evidence|Unadopted evidence|Invalid adopted case evidence)/u.test(message))).toBe(true);
      expect(result?.normalizationDiagnostics).toBeUndefined();
      expect(result?.projection.items.map((item) => item.text)).toEqual(slideVisualSourceContent(page).map((source) => source.text));
      expect(ai).toHaveBeenCalledOnce();
    });

  const conditionalCase = () => {
    const observation = '测量低温环境中的冰水样本：仅当温度≤−3.5°C时，记录2次结果，不能改成估计值';
    const principle = '测量需要统一记录单位。';
    const page = outline([observation, principle]);
    page.activityId = 'section-1';
    page.teachingBrief!.evidence = [{ sourceId: 'measurement-book', quote: principle }];
    page.teachingBrief!.reviewItems = [{ id: 'ice-sample', kind: 'constructed-example', provenance: 'constructed',
      content: '用“测量低温环境中的冰水样本”案例说明如何按给定条件记录。', teachingPurpose: '应用记录条件', sectionId: 'section-1', outlineId: page.id }];
    page.teachingBrief!.teachingPlan!.introduces = ['case-node', 'principle-node'];
    page.teachingBrief!.teachingPlan!.presentationItems = [
      { role: 'case-observation', text: observation, nodeIds: ['case-node'] },
      { role: 'key-point', text: principle, nodeIds: ['principle-node'] },
    ];
    const design = scene([
      { id: 'case', kind: 'text', nodes: [node('case-observation', observation)] },
      { id: 'principle', kind: 'text', nodes: [node('principle', principle, 'adopted-content-2', { sourceEvidenceIds: ['source-quote-1'] })] },
    ]);
    return { page, design };
  };

  it('preserves literal signed quantities, inequalities and conditions in a verified adopted case', async () => {
    const { page, design } = conditionalCase();
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages[0]!.components[0]!.nodes[0]).toEqual({ ...design.pages[0]!.components[0]!.nodes[0], sourceEvidenceIds: ['adopted-case:ice-sample'] });
  });

  it.each([
    ['negative sign', '−3.5', '3.5'], ['negative ASCII sign', '−3.5', '-3.5'], ['inequality', '≤', '<'],
    ['numeric quantity', '记录2次', '记录3次'], ['decimal value', '3.5', '35'],
    ['negation', '不能改成', '能改成'], ['necessary condition', '仅当温度≤−3.5°C时，', ''],
    ['complete action', '记录2次结果', '记录2次'], ['new case condition', '记录2次结果', '记录2次结果，并保证无误'],
  ])('never normalizes away a changed %s', async (_name, before, after) => {
    const { page, design } = conditionalCase();
    design.pages[0]!.components[0]!.nodes[0]!.text = page.keyPoints[0]!.replace(before, after);
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toContain('Missing adopted evidence for case-observation');
    expect(result?.projection.items[0]!.text).toBe(page.keyPoints[0]);
    expect(result?.normalizationDiagnostics).toBeUndefined();
    // Supplying the right ID cannot circumvent the same statement guard.
    design.pages[0]!.components[0]!.nodes[0]!.sourceEvidenceIds = ['adopted-case:ice-sample'];
    expect(teachingVisualSceneIssues(design, page, slideVisualSourceContent(page))).toContain('Invalid adopted case evidence for case-observation');
  });
});
async function generate(page: SceneOutline, design: TeachingVisualScene,
  options: Parameters<typeof generateTeachingVisualScene>[2] = {}) {
  const ai = vi.fn().mockResolvedValue(JSON.stringify(design));
  return { result: await generateTeachingVisualScene(page, ai, options), ai };
}

describe('editable teaching visual scene authoring', () => {
  it('round-trips semantic icons and a same-page support role without creating a teaching edge or source credit', async () => {
    const facts = ['先观察实验现象', '记录温度与颜色，不能用猜测代替观察'];
    const design = scene([
      { id: 'main', kind: 'process', role: 'primary', nodes: [node('observe', facts[0]!, undefined, { icon: 'search' })] },
      { id: 'note', kind: 'text', role: 'support', anchorNodeId: 'observe', nodes: [
        node('record', facts[1]!, 'adopted-content-2', { icon: 'document' }),
      ] },
    ]);
    const parsed = parseTeachingVisualScene(JSON.stringify(design));
    expect(parsed).toEqual(design);
    const plain = structuredClone(design);
    for (const component of plain.pages[0]!.components) {
      delete component.role; delete component.anchorNodeId;
      component.nodes.forEach((item) => { delete item.icon; });
    }
    expect(teachingVisualSceneProjection(parsed)).toEqual(teachingVisualSceneProjection(plain));
    expect(teachingVisualSceneProjection(parsed).links).toBeUndefined();
    expect(teachingVisualSceneProjection(parsed).elementIdsBySource).toEqual({});
    const { result, ai } = await generate(outline(facts), design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages[0]?.components).toEqual(design.pages[0]!.components);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('accepts every finite icon and keeps fields optional for old scenes', () => {
    for (const icon of TEACHING_VISUAL_ICONS) {
      const design = scene([{ id: 'main', kind: 'text', nodes: [node('object', '观察对象', undefined, { icon })] }]);
      expect(parseTeachingVisualScene(JSON.stringify(design)).pages[0]!.components[0]!.nodes[0]!.icon).toBe(icon);
    }
    const legacy = textScene('旧稿保持原样');
    expect(parseTeachingVisualScene(JSON.stringify(legacy))).toEqual(legacy);
  });

  it.each([
    ['icon', 'custom-symbol'], ['icon', 'https://example.test/icon.svg'], ['icon', '📖'], ['icon', null],
    ['role', 'decoration'], ['role', false], ['anchorNodeId', 3], ['anchorNodeId', ''],
  ])('rejects invalid optional %s syntax rather than silently dropping it: %s', (key, value) => {
    const design = textScene('完整事实');
    const component = design.pages[0]!.components[0]!;
    Object.assign(key === 'icon' ? component.nodes[0]! : component, { [key]: value });
    expect(() => parseTeachingVisualScene(JSON.stringify(design))).toThrow(expect.objectContaining({ code: 'INVALID_GENERATED_OUTPUT' }));
  });

  it('requires visible wording for an icon-only node', () => {
    const design = scene([{ id: 'main', kind: 'text', role: 'primary', nodes: [{ id: 'object', icon: 'book', sourceContentIds: ['adopted-content-1'] }] }]);
    expect(() => parseTeachingVisualScene(JSON.stringify(design))).toThrow('nodes need display text');
  });

  it.each(['missing', 'other-page', 'support', 'self', 'multiple-primary'] as const)
    ('diagnoses %s layout ownership and retains the complete original without another model request', async (failure) => {
      const facts = ['观察变化', '按条件记录', '分析原因'];
      const design = scene([
        { id: 'main', kind: 'process', role: 'primary', nodes: [node('observe', facts[0]!)] },
        { id: 'support', kind: 'text', role: 'support', anchorNodeId: 'observe', nodes: [node('record', facts[1]!, 'adopted-content-2')] },
      ]);
      design.pages.push({ id: 'later', title: '原因', focus: '分析', components: [
        { id: 'analysis', kind: 'text', role: 'primary', nodes: [node('reason', facts[2]!, 'adopted-content-3')] },
      ] });
      const [main, support] = design.pages[0]!.components;
      if (failure === 'missing') support!.anchorNodeId = 'unknown';
      if (failure === 'other-page') support!.anchorNodeId = 'reason';
      if (failure === 'support') support!.anchorNodeId = 'record';
      if (failure === 'self') main!.anchorNodeId = 'observe';
      if (failure === 'multiple-primary') support!.role = 'primary';
      const { result, ai } = await generate(outline(facts), design);
      expect(result?.diagnostics.join(' ')).toContain(failure === 'multiple-primary' ? 'Multiple primary visual tasks' : 'Invalid same-page primary anchor');
      expect(result?.projection.items.map((item) => item.text)).toEqual(facts);
      expect(ai).toHaveBeenCalledOnce();
    });

  it('anchors support to a preserved original graph only on the page which actually owns that graph', async () => {
    const page = outline(['先观察再记录，不能猜测']);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察到记录', diagram: {
      topology: 'sequence', nodes: [{ id: 'observe', label: '观察' }, { id: 'record', label: '记录' }],
      edges: [{ from: 'observe', to: 'record' }],
    } };
    const design = scene([
      { id: 'adopted', kind: 'process', role: 'primary', useAdoptedDiagram: true, nodes: [] },
      { id: 'boundary', kind: 'text', role: 'takeaway', anchorNodeId: 'record', nodes: [node('condition', page.keyPoints[0]!)] },
    ]);
    const valid = await generate(page, design);
    expect(valid.result?.diagnostics).toEqual([]);
    expect(valid.result?.projection.links).toBeUndefined();
    const moved = design.pages[0]!.components.pop()!;
    design.pages.push({ id: 'other', title: '边界', focus: '条件', components: [moved] });
    const invalid = await generate(page, design);
    expect(invalid.result?.diagnostics).toContain('Invalid same-page primary anchor in boundary');
  });

  it('never counts icons, roles, anchor IDs or component titles as visible quantities, negative conditions or missing facts', async () => {
    const facts = ['至少观察3次，不能猜测', '记录温度与颜色'];
    const design = scene([
      { id: 'main', title: facts[0], kind: 'process', role: 'primary', nodes: [node(facts[0]!, '观察', undefined, { icon: 'checklist' })] },
      { id: 'note', title: facts[1], kind: 'text', role: 'takeaway', anchorNodeId: facts[0], nodes: [node('note-text', '继续观察', undefined, { icon: 'chart' })] },
    ]);
    const projection = teachingVisualSceneProjection(design);
    expect(projection.items.map((item) => item.text)).toEqual(['观察', '继续观察']);
    const { result } = await generate(outline(facts), design);
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      'Changed or omitted quantity in adopted-content-1', 'Omitted negative boundary in adopted-content-1', 'Missing adopted point adopted-content-2',
    ]));
    expect(result?.projection.items.map((item) => item.text)).toEqual(facts);
  });

  it('prompts for a general primary task, grouped support and visible boundaries while keeping one request and original materials', async () => {
    const page = outline(['实验记录必须完整，不能用猜测代替观察']);
    page.title = '实验观察与记录';
    const before = structuredClone(page);
    const { ai } = await generate(page, textScene(page.keyPoints[0]!));
    const [system, raw] = ai.mock.calls[0]!;
    expect(system).toContain('一个主要理解任务');
    expect(system).toContain('同轴的语义图标');
    expect(system).toContain('评价主体与评价内容');
    expect(system).toContain('不能因此添加任何连接线或箭头');
    expect(system).toContain('原文中的重复定义、详细推理和案例讲解仍由依据原文的讲稿承担');
    expect(system).toContain('最多3页');
    expect(system).not.toContain('支架撤除机制先于五环节');
    for (const icon of TEACHING_VISUAL_ICONS) expect(system).toContain(icon);
    expect(JSON.parse(raw).adoptedDisplayContent).toEqual([{ id: 'adopted-content-1', text: page.keyPoints[0], required: true }]);
    expect(page).toEqual(before);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]).toHaveLength(2);
  });

  it('supplies a valid generic short-phrase recipe with actual font widths and no duplicate evaluation tree', async () => {
    const page = outline(['应保留原始观察，不可编造数据']);
    const { ai, result } = await generate(page, textScene(page.keyPoints[0]!));
    const [system, raw] = ai.mock.calls[0]!;
    const prompt = JSON.parse(raw);
    expect(system).toContain('每个事实只完整显示一次');
    expect(system).toContain('中文释义每行约8至9字');
    expect(system).toContain('不是截字配额');
    expect(system).toContain('两组并列信息');
    expect(system).toContain('不要为了这个ID再复制一遍长图注');
    expect(system).toContain('包括label-only子节点、support/takeaway和diagram-annotation');
    const example = parseTeachingVisualScene(JSON.stringify(prompt.visualStyleExample.scene));
    const components = example.pages[0]!.components;
    expect(components.map((component) => [component.kind, component.role])).toEqual([
      ['process', 'primary'], ['text', 'support'], ['text', 'takeaway'],
    ]);
    expect(components[1]!.nodes.map((node) => node.label)).toEqual(['谁检查', '查什么']);
    expect(components[1]!.edges).toBeUndefined();
    expect(components[1]!.nodes.every((node) => !node.parentId)).toBe(true);
    expect(example.pages.flatMap((page) => page.components.flatMap((component) => component.nodes))
      .every((node) => node.sourceEvidenceIds?.length && node.sourceContentIds.length)).toBe(true);
    expect(prompt.adoptedDisplayContent).toEqual([{ id: 'adopted-content-1', text: page.keyPoints[0], required: true }]);
    expect(result?.scene.pages[0]!.components[0]!.nodes[0]!.text).toBe(page.keyPoints[0]);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('shares one actual visible claim across overlapping catalog IDs without repeating the text', async () => {
    const original = '检查完整性，不能只看记录数量';
    const page = outline([original, '不能只看记录数量']);
    page.visualSourceCatalog = page.keyPoints.map((text, index) => ({ id: `adopted-content-${index + 1}`, text }));
    const design = textScene(original);
    design.pages[0]!.components[0]!.nodes[0]!.sourceContentIds.push('adopted-content-2');
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.projection.items).toHaveLength(1);
    expect(result?.projection.items[0]).toMatchObject({ text: original, sourceContentIds: ['adopted-content-1', 'adopted-content-2'] });
    expect(result?.projection.elementIdsBySource).toEqual({});
  });

  it('inherits only an omitted same-source child reference verified against its parents adopted original text', async () => {
    const fact = '细胞包含细胞膜和细胞核，细胞膜调控物质交换。';
    const page = outline([fact]);
    page.teachingBrief!.evidence = [{ sourceId: 'cell-book', quote: fact }];
    const design = scene([{ id: 'cell', kind: 'structure', nodes: [
      node('root', fact, undefined, { sourceEvidenceIds: ['source-quote-1'] }),
      { id: 'membrane', label: '细胞膜', parentId: 'root', sourceContentIds: ['adopted-content-1'] },
    ] }]);
    const before = structuredClone(design);
    const { result, ai } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages[0]!.components[0]!.nodes[1]).toEqual({ ...before.pages[0]!.components[0]!.nodes[1], sourceEvidenceIds: ['source-quote-1'] });
    expect(design).toEqual(before);
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each(['different-source', 'paraphrase', 'new-condition', 'explicit-foreign-reference', 'missing-parent', 'other-component', 'numeric-prefix', 'body-text', 'dropped-qualifier'] as const)
    ('keeps %s child evidence failures diagnostic instead of indiscriminately copying the parent citation', async (failure) => {
      const fact = '细胞包含细胞膜和细胞核，细胞膜调控物质交换，样本有120个细胞。';
      const page = outline([fact, '细胞核调控生命活动']);
      page.teachingBrief!.evidence = [{ sourceId: 'cell-book', quote: fact + '细胞核调控生命活动。不能控制意识。' }];
      const child: VisualNode = { id: 'membrane', label: '细胞膜', sourceContentIds: ['adopted-content-1'], parentId: 'root' };
      const design = scene([{ id: 'cell', kind: 'structure', nodes: [
        node('root', fact, undefined, { sourceEvidenceIds: ['source-quote-1'] }), child,
        node('nucleus', page.keyPoints[1]!, 'adopted-content-2', { sourceEvidenceIds: ['source-quote-1'] }),
      ] }]);
      if (failure === 'different-source') child.sourceContentIds = ['adopted-content-2'];
      if (failure === 'paraphrase') child.label = '控制物质进出';
      if (failure === 'new-condition') child.label = '不能调控物质交换';
      if (failure === 'numeric-prefix') child.label = '12';
      if (failure === 'body-text') child.text = '调控物质交换';
      if (failure === 'dropped-qualifier') child.label = '控制意识';
      if (failure === 'explicit-foreign-reference') child.sourceEvidenceIds = ['invented-book'];
      if (failure === 'missing-parent') delete child.parentId;
      if (failure === 'other-component') {
        design.pages[0]!.components[0]!.nodes.splice(1, 1);
        design.pages[0]!.components.push({ id: 'other', kind: 'text', nodes: [child] });
      }
      const { result, ai } = await generate(page, design);
      expect(result?.diagnostics).toContain(failure === 'explicit-foreign-reference'
        ? 'Unadopted evidence for membrane' : 'Missing adopted evidence for membrane');
      expect(result?.projection.items.map((item) => item.text)).toEqual(page.keyPoints);
      expect(ai).toHaveBeenCalledOnce();
    });

  it('does not infer an uncited graph annotation from unrelated same-page citations', async () => {
    const fact = '观察后才能记录，不能猜测';
    const page = outline([fact]);
    page.visualSourceCatalog = [{ id: 'adopted-content-1', text: fact }];
    page.teachingBrief!.evidence = [{ sourceId: 'observation-book', quote: fact }];
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察到记录', diagram: {
      topology: 'sequence', nodes: [{ id: 'observe', label: '观察' }, { id: 'record', label: '记录' }], annotation: fact,
    } };
    const design = scene([
      { id: 'main', kind: 'process', useAdoptedDiagram: true, role: 'primary', nodes: [
        node('fact', fact, undefined, { sourceEvidenceIds: ['source-quote-1'], anchorId: 'observe' }),
      ] },
      { id: 'caption', kind: 'text', role: 'takeaway', anchorNodeId: 'record', nodes: [node('caption-fact', fact, 'diagram-annotation')] },
    ]);
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toContain('Missing adopted evidence for caption-fact');
    expect(result?.projection.items.map((item) => item.text)).toEqual([fact, fact]);
  });

  it('accepts an image landmark name beside its normalized location without treating it as a graph node', async () => {
    const page = outline(['叶脉用于支撑和运输。']);
    const design = scene([{ id: 'leaf', kind: 'annotated-image', resourceId: 'leaf-image', nodes: [
      node('vein', '叶脉用于支撑和运输。', undefined, { anchor: { x: 0.5, y: 0.6 }, anchorId: 'vein-landmark' }),
    ] }]);
    const { result } = await generate(page, design, { availableResources: [{ id: 'leaf-image' }] });
    expect(result?.diagnostics).toEqual([]);
    delete design.pages[0]!.components[0]!.nodes[0]!.anchor;
    const invalid = await generate(page, design, { availableResources: [{ id: 'leaf-image' }] });
    expect(invalid.result?.diagnostics).toContain('Unknown adopted diagram anchor in vein');
  });

  it('binds case-insensitive multi-series categories and values in the same original clauses', async () => {
    const original = 'A, observation 1: 12 ms; A, observation 2: 11 ms; B, observation 1: 8 ms; B, observation 2: 9 ms.';
    const design = scene([{ id: 'chart', kind: 'data', nodes: [node('values', original)], data: {
      chartType: 'bar', labels: ['Observation 1', 'Observation 2'], unit: 'ms',
      series: [{ name: 'A', values: [12, 11] }, { name: 'B', values: [8, 9] }],
    } }]);
    const { result } = await generate(outline([original]), design);
    expect(result?.diagnostics).toEqual([]);
    design.pages[0]!.components[0]!.data!.series[0]!.values = [8, 9];
    const swapped = await generate(outline([original]), design);
    expect(swapped.result?.diagnostics.join(' ')).toContain('Unsupported chart value');
  });

  it('binds explicit reverse value ownership and rejects swapped or signed values', async () => {
    const original = 'The mean times are 12 ms for A and 8 ms for B under the measured conditions.';
    const design = scene([{ id: 'chart', kind: 'data', nodes: [node('values', original)], data: {
      chartType: 'bar', labels: ['A', 'B'], unit: 'ms', series: [{ name: 'Mean', values: [12, 8] }],
    } }]);
    expect((await generate(outline([original]), design)).result?.diagnostics).toEqual([]);
    design.pages[0]!.components[0]!.data!.series[0]!.values = [8, 12];
    expect((await generate(outline([original]), design)).result?.diagnostics.join(' ')).toContain('Unsupported chart value');
    const signed = 'A: −12 ms; B: 8 ms.';
    design.pages[0]!.components[0]!.nodes[0]!.text = signed;
    design.pages[0]!.components[0]!.data!.series[0]!.values = [12, 8];
    expect((await generate(outline([signed]), design)).result?.diagnostics.join(' ')).toContain('Unsupported chart value A');
  });

  it('authors a qualitative state change once from adopted evidence without rewriting narration or outline', async () => {
    const page = outline(['提供学习支架，随能力提升逐渐撤除，不能在最后一次性撤销。']);
    const saved = structuredClone(page);
    const { result, ai } = await generate(page, scene([{ id: 'support', kind: 'state-change', nodes: [
      node('supported', '提供学习支架', undefined, { label: '开始探索', supportLevel: 'present' }),
      node('fading', '随能力提升逐渐撤除；不能最后一次性撤销', undefined, { label: '逐步独立', supportLevel: 'fading' }),
    ], edges: [{ from: 'supported', to: 'fading', kind: 'sequence' }] }]));
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages[0]?.components[0]?.kind).toBe('state-change');
    expect(result?.scene.pages[0]?.id).toBe(page.id);
    expect(page).toEqual(saved);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]?.[0]).toContain(TEACHING_VISUAL_OPERATION);
    expect(ai.mock.calls[0]?.[0]).not.toContain('PPT_VISUAL_REVIEW');
    expect(result?.projection.elementIdsBySource).toEqual({});
  });

  it('supports three coherent pages and keeps page-local projection identities', async () => {
    const page = outline(['事实甲', '事实乙', '事实丙']);
    const design = scene([{ id: 'a', kind: 'text', nodes: [node('a-fact', '事实甲')] }]);
    design.pages.push({ id: 'second', title: '乙', focus: '乙', components: [{ id: 'b', kind: 'text', nodes: [node('b-fact', '事实乙', 'adopted-content-2')] }] },
      { id: 'third', title: '丙', focus: '丙', components: [{ id: 'c', kind: 'text', nodes: [node('c-fact', '事实丙', 'adopted-content-3')] }] });
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages.map((item) => item.id)).toEqual(['page-19', 'page-19:visual-2', 'page-19:visual-3']);
    expect(teachingVisualSceneProjection(result!.scene, 'page-19:visual-2').items.map((item) => item.id)).toEqual(['b-fact']);
    expect(teachingVisualSceneProjection(result!.scene).verified).toBe(false);
  });

  it('retains complete original content for excessive pagination without another model call', async () => {
    const design = textScene('事实甲');
    for (let index = 1; index < 4; index += 1) design.pages.push({ id: `page-${index}`, title: '甲', focus: '甲',
      components: [{ id: `component-${index}`, kind: 'text', nodes: [node(`node-${index}`, '事实甲')] }] });
    const { result, ai } = await generate(outline(['事实甲']), design);
    expect(result?.diagnostics).toContain('Visual scene exceeds three pages');
    expect(result?.scene.pages).toHaveLength(1);
    expect(result?.scene.pages[0]?.components[0]?.kind).toBe('text');
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each([
    ['完成3次实验，误差5%', 'Changed or omitted quantity boundary'],
    ['实验≥3次', 'Changed or omitted quantity'],
    ['实验≥3次；误差≤5%；样本100个', 'Unsupported quantity'],
  ])('preserves numeric duties when projection says %s', async (display, diagnostic) => {
    const original = '至少完成3次实验，误差不超过5%';
    const { result, ai } = await generate(outline([original]), textScene(display));
    expect(result?.diagnostics.join(' ')).toContain(diagnostic);
    expect(result?.scene.pages[0]?.components[0]?.nodes[0]?.text).toBe(original);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('accepts equivalent inclusive bounds without turning them into strict bounds', async () => {
    const { result } = await generate(outline(['至少完成3次实验，误差不超过5%']), textScene('实验≥3次；误差≤5%'));
    expect(result?.diagnostics).toEqual([]);
  });

  it('diagnoses a dropped negative boundary and retains the complete original', async () => {
    const original = '支架逐步撤除，不能在最后一次性撤销。';
    const { result } = await generate(outline([original]), textScene('支架逐步撤除'));
    expect(result?.diagnostics.join(' ')).toContain('Omitted negative boundary');
    expect(result?.projection.items[0]?.text).toBe(original);
  });

  it('checks source ownership, adopted evidence and missing points', async () => {
    const { result } = await generate(outline(['事实甲', '事实乙']), scene([{ id: 'main', kind: 'text',
      nodes: [node('wrong', '事实甲', 'another-page', { sourceEvidenceIds: ['unadopted-book'] })] }]));
    expect(result?.diagnostics).toEqual(expect.arrayContaining(['Unknown source for wrong', 'Unadopted evidence for wrong', 'Missing adopted point adopted-content-2']));
    expect(result?.projection.items.map((item) => item.text)).toEqual(['事实甲', '事实乙']);
  });

  it('reads the adopted original passage and requires its actual evidence ID', async () => {
    const original = '甲组10人，乙组20人。';
    const page = { ...outline([original]), knowledgePointIds: ['numbers'] };
    const sourceEvidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'evidence', createdAt: '2026-10-02',
      retrievalMode: 'hybrid', mappings: [], warnings: [], selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }],
      items: [{ id: 'original', kind: 'source-block', title: '人数', content: original,
        source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'book-v1', revisionVersion: 1, sectionPath: ['人数'], quote: original } }] };
    const options = { sourceEvidence, sourceKnowledgePoints: [{ id: 'numbers', evidenceItemIds: ['original'] }] };
    const design = textScene(original);
    const missing = await generate(page, design, options);
    expect(missing.result?.diagnostics).toContain('Missing adopted evidence for fact');
    design.pages[0]!.components[0]!.nodes[0]!.sourceEvidenceIds = ['original'];
    const valid = await generate(page, design, options);
    expect(valid.result?.diagnostics).toEqual([]);
    expect(valid.ai.mock.calls[0]?.[1]).toContain('甲组10人，乙组20人');
  });

  it('accepts the authoritative quote IDs actually supplied in the model prompt, while rejecting invented evidence', async () => {
    const page = outline(['其他条件相近时，温室气体增加会影响散热并促使地表变暖']);
    page.teachingBrief!.evidence = [{ sourceId: 'adopted-textbook', quote: page.keyPoints[0]! }];
    const design = scene([{ id: 'cause', kind: 'causal', nodes: [
      node('mechanism', page.keyPoints[0]!, undefined, { sourceEvidenceIds: ['source-quote-1'] }),
    ] }]);
    const valid = await generate(page, design);
    expect(valid.ai.mock.calls[0]?.[1]).toContain('source-quote-1');
    expect(valid.result?.diagnostics).toEqual([]);
    expect(valid.result?.scene.pages[0]?.components[0]?.kind).toBe('causal');
    design.pages[0]!.components[0]!.nodes[0]!.sourceEvidenceIds = ['source-quote-2'];
    expect((await generate(page, design)).result?.diagnostics).toContain('Unadopted evidence for mechanism');
  });

  it('preserves the first introduction order across pages instead of accepting ID coverage alone', async () => {
    const page = outline(['先解释支架撤除条件', '再展开五环节过程']);
    const design = scene([{ id: 'process-first', kind: 'text', nodes: [node('process-fact', page.keyPoints[1]!, 'adopted-content-2')] }]);
    design.pages.push({ id: 'reversed', title: '撤除条件', focus: '撤除时机', components: [
      { id: 'condition-later', kind: 'text', nodes: [node('condition-fact', page.keyPoints[0]!)] },
    ] });
    // Validation itself stays strict even though a fresh generation can restore
    // two intact, non-overlapping source blocks before this gate runs.
    expect(teachingVisualSceneIssues(design, page, slideVisualSourceContent(page)))
      .toContain('Changed adopted teaching order on reversed');
    const before = structuredClone(design);
    const restored = await generate(page, design);
    expect(restored.result?.diagnostics).toEqual([]);
    expect(restored.result?.scene.pages).toHaveLength(2);
    expect(restored.result?.scene.pages.map((part) => part.components)).toEqual([design.pages[1]!.components, design.pages[0]!.components]);
    expect(restored.result?.scene.pages.map((part) => part.id)).toEqual([page.id, `${page.id}:visual-2`]);
    expect(restored.result?.normalizationDiagnostics?.join(' ')).toContain('disjoint adopted source intervals');
    expect(restored.result?.projection.items.map((item) => item.text)).toEqual(page.keyPoints);
    expect(restored.ai).toHaveBeenCalledOnce();
    expect(design).toEqual(before);
    design.pages.reverse();
    expect((await generate(page, design)).result?.diagnostics).toEqual([]);
  });

  it('moves only complete source blocks and retains the original graph, same-page anchors, text and edges', async () => {
    const facts = ['需要帮助时提供支持', '能够独立完成后撤除', '先观察再记录', '记录后核查'];
    const page = outline(facts);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '完整观察与记录流程', diagram: {
      topology: 'sequence', nodes: [{ id: 'observe', label: '观察' }, { id: 'record', label: '记录' }],
      edges: [{ from: 'observe', to: 'record' }], annotation: '不能猜测',
    } };
    const design = scene([
      { id: 'original-graph', kind: 'process', role: 'primary', useAdoptedDiagram: true, nodes: [
        node('observe-note', facts[2]!, 'adopted-content-3', { anchorId: 'observe' }),
      ] },
      { id: 'record-support', kind: 'text', role: 'support', anchorNodeId: 'record', nodes: [
        node('record-note', facts[3]!, 'adopted-content-4'), node('no-guess', '不能猜测', 'diagram-annotation'),
      ] },
    ]);
    design.pages.push({ id: 'support-first', title: '支持与撤除', focus: '条件', components: [
      { id: 'support-change', kind: 'state-change', role: 'primary', nodes: [node('need', facts[0]!), node('withdraw', facts[1]!, 'adopted-content-2')],
        edges: [{ from: 'need', to: 'withdraw', kind: 'sequence' }] },
      { id: 'boundary', kind: 'text', role: 'takeaway', nodes: [node('no-guess-again', '不能猜测', 'diagram-annotation')] },
    ] });
    const before = structuredClone({ page, design });
    const normalized = normalizeTeachingVisualPageOrder(design, slideVisualSourceContent(page));
    expect(normalized.pages[0]).toBe(design.pages[1]);
    expect(normalized.pages[1]).toBe(design.pages[0]);
    expect(teachingVisualSceneIssues(normalized, page, slideVisualSourceContent(page))).toEqual([]);
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages.map((part) => part.components)).toEqual(normalized.pages.map((part) => part.components));
    expect({ page, design }).toEqual(before);
  });

  it('uses the adopted catalog position for three intact pages and leaves an already ordered scene untouched', () => {
    const sources = [{ id: 'z', text: '先观察' }, { id: 'm', text: '再记录' }, { id: 'a', text: '最后核查' }];
    const design: TeachingVisualScene = { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [2, 0, 1].map((index) => ({
      id: `page-${index}`, title: sources[index]!.text, focus: sources[index]!.text,
      components: [{ id: `part-${index}`, kind: 'text', nodes: [node(`fact-${index}`, sources[index]!.text, sources[index]!.id)] }],
    })) };
    const normalized = normalizeTeachingVisualPageOrder(design, sources);
    expect(normalized.pages).toEqual([design.pages[1], design.pages[2], design.pages[0]]);
    expect(normalizeTeachingVisualPageOrder(normalized, sources)).toBe(normalized);
  });

  it.each(['interleaved', 'shared', 'unpositioned', 'unknown', 'missing', 'relative-page-prose'] as const)
    ('keeps %s page responsibility in the original order for the strict source gate', async (variant) => {
      const page = outline(['事实甲', '事实乙', '事实丙', '事实丁']);
      const design: TeachingVisualScene = { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [
        { id: 'later', title: '后续责任', focus: '后续责任', components: [{ id: 'later-facts', kind: 'text', nodes: [
          node('c', '事实丙', 'adopted-content-3'), node('d', '事实丁', 'adopted-content-4'),
        ] }] },
        { id: 'earlier', title: '先前责任', focus: '先前责任', components: [{ id: 'earlier-facts', kind: 'text', nodes: [
          node('a', '事实甲'), node('b', '事实乙', 'adopted-content-2'),
        ] }] },
      ] };
      const later = design.pages[0]!.components[0]!.nodes, earlier = design.pages[1]!.components[0]!.nodes;
      if (variant === 'interleaved') [later[0], earlier[1]] = [earlier[1]!, later[0]!];
      if (variant === 'shared') later.push(node('shared-a', '事实甲'));
      if (variant === 'unpositioned') design.pages.push({ id: 'figure-only', title: '图示', focus: '观察', components: [
        { id: 'unpositioned-block', kind: 'annotated-image', resourceId: 'adopted-figure', nodes: [] },
      ] });
      if (variant === 'unknown') later[0]!.sourceContentIds.push('unadopted-source');
      if (variant === 'missing') earlier.pop();
      if (variant === 'relative-page-prose') design.pages[0]!.focus = '下一页再解释原因';
      const before = structuredClone(design), sources = slideVisualSourceContent(page);
      expect(normalizeTeachingVisualPageOrder(design, sources)).toBe(design);
      expect(teachingVisualSceneIssues(design, page, sources).join(' ')).toContain('Changed adopted teaching order');
      const { result } = await generate(page, design, variant === 'unpositioned'
        ? { availableResources: [{ id: 'adopted-figure', type: 'image' }] } : {});
      expect(result?.diagnostics.join(' ')).toContain('Changed adopted teaching order');
      expect(result?.normalizationDiagnostics).toBeUndefined();
      expect(result?.projection.items.map((item) => item.text)).toEqual(page.keyPoints);
      expect(design).toEqual(before);
    });

  it('continues rejecting altered facts after a provable whole-page reordering', async () => {
    const page = outline(['至少观察3次，不能猜测', '记录原始现象']);
    const design = scene([{ id: 'record', kind: 'text', nodes: [node('record-fact', page.keyPoints[1]!, 'adopted-content-2')] }]);
    design.pages.push({ id: 'earlier', title: '观察', focus: '观察', components: [
      { id: 'observe', kind: 'text', nodes: [node('observe-fact', '观察2次')] },
    ] });
    const { result, ai } = await generate(page, design);
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      'Changed or omitted quantity in adopted-content-1', 'Omitted negative boundary in adopted-content-1',
    ]));
    expect(result?.normalizationDiagnostics).toBeUndefined();
    expect(result?.projection.items.map((item) => item.text)).toEqual(page.keyPoints);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('requires semantic comparison groups and tells the model to let the compiler create headers', async () => {
    const design = scene([{ id: 'comparison', kind: 'comparison', nodes: [
      node('a', '甲适用独立任务', undefined, { row: '适用条件', column: '甲方法' }),
      node('b', '乙适用协作任务', undefined, { row: '适用条件', column: '乙方法' }),
    ] }]);
    const valid = await generate(outline(['两种方法的适用条件']), design);
    expect(valid.ai.mock.calls[0]?.[0]).toContain('禁止0、1、2等数字值');
    expect(valid.ai.mock.calls[0]?.[0]).toContain('不要另建表头节点');
    const invalid = structuredClone(design) as unknown as { pages: Array<{ components: Array<{ nodes: Array<{ row: unknown }> }> }> };
    invalid.pages[0]!.components[0]!.nodes[0]!.row = 1;
    expect(() => parseTeachingVisualScene(JSON.stringify(invalid))).toThrow('never a numeric coordinate');
  });

  it('keeps English quantity and negative boundaries with multilingual equivalent signs', async () => {
    expect((await generate(outline(['At least 3 tests; at most 5% error']), textScene('Tests ≥3; error ≤5%'))).result?.diagnostics).toEqual([]);
    expect((await generate(outline(['No more than 5% error']), textScene('Error ≤5%'))).result?.diagnostics).toEqual([]);
    expect((await generate(outline(['This data cannot establish causality']), textScene('This data establishes causality'))).result?.diagnostics)
      .toContain('Omitted negative boundary in adopted-content-1');
    expect((await generate(outline(['At least 3 tests']), textScene('3 tests'))).result?.diagnostics.join(' ')).toContain('quantity boundary');
  });

  it('keeps an adopted branching graph as one host-owned component with anchored explanations', async () => {
    const page = outline(['按条件选择路径']);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '分支不是先后', diagram: {
      topology: 'branch', nodes: [{ id: 'root', label: '条件' }, { id: 'yes', label: '成立' }, { id: 'no', label: '不成立' }],
      edges: [{ from: 'root', to: 'yes' }, { from: 'root', to: 'no' }], annotation: '先判断条件，再选择对应路径',
    } };
    const design = scene([{ id: 'decision', kind: 'process', useAdoptedDiagram: true, nodes: [
      node('condition', '按条件选择路径', undefined, { anchorId: 'root' }),
      node('annotation', '先判断条件，再选择对应路径', 'diagram-annotation'),
    ] }]);
    const saved = structuredClone(page.visualIntent);
    const { result } = await generate(page, design);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.scene.pages[0]?.components[0]?.useAdoptedDiagram).toBe(true);
    expect(page.visualIntent).toEqual(saved);
    design.pages[0]!.components.push({ id: 'duplicate', kind: 'process', nodes: [], useAdoptedDiagram: true });
    const invalid = await generate(page, design);
    expect(invalid.result?.diagnostics.join(' ')).toContain('single component');
    expect(invalid.result?.scene.pages.flatMap((item) => item.components).filter((item) => item.useAdoptedDiagram)).toHaveLength(1);
  });

  it('keeps independent complete comparison matrices separate while rejecting a missing cell', async () => {
    const component = (id: string): TeachingVisualComponent => ({ id, kind: 'comparison', nodes: [
      node(`${id}-a`, '甲', undefined, { row: '方法', column: '对象甲' }),
      node(`${id}-b`, '乙', undefined, { row: '方法', column: '对象乙' }),
    ] });
    const design = scene([component('first'), component('second')]);
    const valid = await generate(outline(['甲与乙']), design);
    expect(valid.result?.diagnostics).toEqual([]);
    design.pages[0]!.components[1]!.nodes.pop();
    const invalid = await generate(outline(['甲与乙']), design);
    expect(invalid.result?.diagnostics).toContain('Incomplete comparison matrix in second');
  });

  it('binds image annotations to available resources and retains a missing required resource in fallback', async () => {
    const resources = [{ id: 'textbook-figure', required: true }];
    const design = scene([{ id: 'observation', kind: 'annotated-image', resourceId: 'textbook-figure',
      nodes: [node('detail', '观察图中连接处', undefined, { anchor: { x: 0.4, y: 0.6 } })] }]);
    const valid = await generate(outline(['观察图中连接处']), design, { availableResources: resources });
    expect(valid.result?.diagnostics).toEqual([]);
    design.pages[0]!.components[0]!.resourceId = 'invented-image';
    const invalid = await generate(outline(['观察图中连接处']), design, { availableResources: resources });
    expect(invalid.result?.diagnostics).toEqual(expect.arrayContaining(['Unknown resource invented-image', 'Missing adopted resource textbook-figure']));
    expect(invalid.result?.scene.pages[0]?.components.find((item) => item.resourceId)?.resourceId).toBe('textbook-figure');
  });

  it('projects actual chart labels and values while rejecting swapped category values', async () => {
    const page = outline(['甲组10人，乙组20人']);
    const component: TeachingVisualComponent = { id: 'counts', kind: 'data', nodes: [node('explanation', '甲组与乙组人数')],
      data: { chartType: 'bar', labels: ['甲组', '乙组'], series: [{ name: '人数', values: [10, 20] }], unit: '人' } };
    const { result } = await generate(page, scene([component]));
    expect(result?.diagnostics).toEqual([]);
    const projected = teachingVisualComponentProjection(component);
    expect(projected.items.find((item) => item.id === 'counts:data')).toMatchObject({ sourceContentIds: ['adopted-content-1'], text: expect.stringContaining('甲组 10人；乙组 20人') });
    expect(projected.elementIdsBySource).toEqual({});
    component.data!.series[0]!.values = [20, 10];
    const invalid = await generate(page, scene([component]));
    expect(invalid.result?.diagnostics.join(' ')).toContain('Unsupported chart value');
    expect(invalid.result?.scene.pages[0]?.components[0]?.kind).toBe('text');
  });

  it('keeps chart percentage units visible and rejects a changed sign', async () => {
    const percent: TeachingVisualComponent = { id: 'percent', kind: 'data', nodes: [node('explanation', '甲组占比')],
      data: { chartType: 'bar', labels: ['甲组'], series: [{ name: '占比', values: [10] }], unit: '%' } };
    const valid = await generate(outline(['甲组10%']), scene([percent]));
    expect(valid.result?.diagnostics).toEqual([]);
    expect(valid.result?.projection.items.at(-1)?.text).toContain('甲组 10%');
    percent.data!.unit = undefined;
    const wrong = await generate(outline(['甲组-10']), scene([percent]));
    expect(wrong.result?.diagnostics.join(' ')).toContain('Unsupported chart value');
  });

  it('diagnoses invalid diagram/image anchors, cyclic containment and dangling edges', async () => {
    const design = scene([{ id: 'structure', kind: 'structure', nodes: [
      node('a', '甲', undefined, { parentId: 'b', anchorId: 'foreign', anchor: { x: 2, y: 0 } }),
      node('b', '乙', undefined, { parentId: 'a' }),
    ], edges: [{ from: 'a', to: 'missing' }] }]);
    const { result } = await generate(outline(['甲与乙']), design);
    expect(result?.diagnostics).toEqual(expect.arrayContaining(['Invalid local relationship in structure', 'Invalid image anchor in a',
      'Unknown adopted diagram anchor in a', 'Cyclic containment in structure']));
  });

  it.each(['', 'nonsense', '{"schemaVersion":1,"designVersion":"teaching-visual-v2","pages":[]}'])('keeps empty or unparseable output a technical error: %s', (raw) => {
    expect(() => parseTeachingVisualScene(raw)).toThrow(expect.objectContaining({ code: 'INVALID_GENERATED_OUTPUT' }));
  });

  it('accepts a short label as visible content but rejects duplicate node IDs', () => {
    const design = scene([{ id: 'one', kind: 'text', nodes: [{ id: 'label', label: '必要条件', sourceContentIds: ['adopted-content-1'] }] }]);
    expect(teachingVisualSceneProjection(parseTeachingVisualScene(JSON.stringify(design))).items[0]?.text).toBe('必要条件');
    design.pages[0]!.components[0]!.nodes.push(node('label', '重复ID'));
    expect(() => parseTeachingVisualScene(JSON.stringify(design))).toThrow(expect.objectContaining({ code: 'INVALID_GENERATED_OUTPUT' }));
  });

  it('includes native charts but keeps videos and teacher pages on their existing authoring path', () => {
    const page = outline(['数据']);
    page.visualIntent = { representation: 'native-chart', observationGoal: '比较数据' };
    expect(usesTeachingVisualScene(page)).toBe(true);
    expect(usesTeachingVisualScene({ ...page, audience: 'teacher' })).toBe(false);
    expect(usesTeachingVisualScene({ ...page, visualIntent: { representation: 'video', observationGoal: '观看运动' } })).toBe(false);
    expect(usesTeachingVisualScene({ ...page, mediaGenerations: [{ type: 'video', elementId: 'movie', prompt: '运动变化' }] })).toBe(false);
  });
});
