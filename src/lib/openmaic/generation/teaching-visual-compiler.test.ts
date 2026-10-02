import { afterAll, describe, expect, it } from 'vitest';
import type { TeachingVisualComponent, TeachingVisualScene } from '@openmaic/dsl';
import type { DiagramPlan } from '@openmaic/generation';
import type { SceneOutline } from '../types/generation';
import { compileTeachingVisualScene, scoreTeachingVisualCandidate } from './teaching-visual-compiler';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from './slide-spatial-measurement';
import { auditSlideDensity, slideRequiredVisibleStatements } from './slide-layout-audit';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { slideVisualSourceContent } from './slide-visual-projection';

afterAll(closeSpatialMeasurementBrowser);
function outline(points: string[]): SceneOutline {
  return { id: 'teaching-page', type: 'slide', title: '观察对象与变化', description: '依据采用的原始资料解释关系',
    keyPoints: points, order: 0, targetDurationSec: 97, audience: 'student', generationPurpose: 'knowledge-teaching',
    teachingBrief: { schemaVersion: 1, explanation: points.join('。'), evidence: [], examples: [], conditions: [], assessmentFocus: '',
      teachingPlan: { purpose: '解释关系', priorKnowledge: '', newContent: points.join('。'), learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: points, presentationContent: points,
        presentationItems: points.map((text, i) => ({ role: 'key-point', text, nodeIds: [`knowledge-${i + 1}`] })),
        introduces: points.map((_, i) => `knowledge-${i + 1}`), narrationFocus: points } } };
}
function scene(components: TeachingVisualComponent[]): TeachingVisualScene {
  return { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: 'visual-page', title: '观察对象与变化', focus: '观察真实教学关系', components }] };
}
async function compile(page: SceneOutline, visual: TeachingVisualScene, extra: Partial<Parameters<typeof compileTeachingVisualScene>[2]> = {}) {
  return compileTeachingVisualScene(page, visual, { measure: measureAuthoredSlideText, sourceCatalog: slideVisualSourceContent(page), ...extra });
}
const node = (id: string, label: string, text: string, source: number) => ({ id, label, text, sourceContentIds: [`adopted-content-${source}`] });
const graphCases: Array<{ name: string; graph: DiagramPlan }> = [
  { name: 'branch', graph: { topology: 'branch', nodes: [{ id: 'a', label: '共同起点' }, { id: 'b', label: '路径甲' }, { id: 'c', label: '路径乙' }],
    edges: [{ from: 'a', to: 'b', label: '条件甲' }, { from: 'a', to: 'c', label: '条件乙' }] } },
  { name: 'cycle', graph: { topology: 'cycle', nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '行动' }, { id: 'c', label: '反思' }] } },
  { name: 'parallel sequences', graph: { topology: 'sequence', nodes: [{ id: 'a', label: '甲组观察' }, { id: 'b', label: '甲组验证' }, { id: 'c', label: '乙组观察' }, { id: 'd', label: '乙组验证' }],
    sequenceGroups: [{ id: 'left', label: '甲组', nodeIds: ['a', 'b'] }, { id: 'right', label: '乙组', nodeIds: ['c', 'd'] }] } },
];

describe('measured teaching visual components and source responsibility', () => {
  it('makes qualitative states visible and editable without inventing chart quantities', async () => {
    const page = outline(['支架具有暂时性', '随着能力提升逐个撤除支架', '能独立解决问题时撤离']);
    const visual = scene([{ id: 'withdrawal', kind: 'state-change', nodes: [
      { ...node('initial', '需要支持', '暂时性', 1), supportLevel: 'present' },
      { ...node('developing', '能力提升', '逐个撤除支架', 2), supportLevel: 'fading' },
      { ...node('independent', '独立解决问题', '支架撤离', 3), supportLevel: 'withdrawn' },
    ], edges: [{ from: 'initial', to: 'developing' }, { from: 'developing', to: 'independent' }] }]);
    const result = await compile(page, visual);
    expect(result).not.toBeNull();
    expect(result?.elements.some((element) => element.type === 'chart')).toBe(false);
    expect(result?.elements.filter((element) => element.type === 'text').map((element) => element.content).join(' ')).toContain('状态示意');
    expect(result?.teachingVisual?.components[0]?.sourceContentIds).toEqual(['adopted-content-1', 'adopted-content-2', 'adopted-content-3']);
    expect(auditSlideDensity(page, result!).underrepresentedKeyPoints).toEqual([]);
  });

  it('preserves adopted five-step order and maps notes to the actual visible process objects', async () => {
    const page = outline(['根据最近发展区设计层次支架', '先启发引导，再给予自主空间', '自评、互评和教师评价']);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察五个环节', diagram: {
      topology: 'sequence', nodes: ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'].map((label, i) => ({ id: `c${i + 1}`, label })),
      edges: [1, 2, 3, 4].map((i) => ({ from: `c${i}`, to: `c${i + 1}` })) } };
    const result = await compile(page, scene([{ id: 'process', kind: 'process', useAdoptedDiagram: true, nodes: [
      { ...node('design', '搭脚手架', '按最近发展区设计层次支架', 1), anchorId: 'c1' },
      { ...node('explore', '独立探索', '启发引导后给予自主空间', 2), anchorId: 'c3' },
      { ...node('evaluate', '效果评价', '自评／互评／教师评价', 3), anchorId: 'c5' },
    ] }]));
    expect(result).not.toBeNull();
    for (const original of page.visualIntent.diagram!.nodes) {
      const id = result!.presentationProjection!.elementIdsBySource[`diagram-node:${original.id}`]![0];
      const element = result!.elements.find((element) => element.id === id);
      expect(element?.type).toBe('shape');
    }
    expect(result!.elements.filter((element) => element.type === 'line' && /-edge-/.test(element.id))).toHaveLength(4);
    expect(auditSlideDensity(page, result!).underrepresentedKeyPoints).toEqual([]);
  });

  it('does not earn coverage from hidden labels or a changed native chart', async () => {
    const page = outline(['示例数据：周一12 kWh，周二10 kWh，周三14 kWh']);
    const result = await compile(page, scene([{ id: 'observations', kind: 'data', data: {
      chartType: 'bar', labels: ['周一', '周二', '周三'], series: [{ name: '用电量', values: [12, 10, 14] }], unit: 'kWh',
    }, nodes: [node('finding', '示例用电量', '周一12 kWh／周二10 kWh／周三14 kWh', 1)] }]));
    expect(result).not.toBeNull();
    expect(auditSlideDensity(page, result!).underrepresentedKeyPoints).toEqual([]);
    const wrong = structuredClone(result!);
    const chart = wrong.elements.find((element) => element.type === 'chart');
    if (chart?.type !== 'chart') throw new Error('Missing native chart');
    const unit = wrong.elements.find((element) => element.id === 'observations:unit');
    expect(unit?.type).toBe('text');
    if (unit?.type === 'text') expect(unit.top + unit.height).toBeLessThanOrEqual(chart.top);
    chart.data.series[0]![1] = 100;
    expect(auditSlideDensity(page, wrong).underrepresentedKeyPoints).toHaveLength(1);
    const hidden = structuredClone(result!);
    hidden.elements = hidden.elements.filter((element) => element.id !== 'finding');
    expect(auditSlideDensity(page, hidden).underrepresentedKeyPoints).toHaveLength(1);
  });

  it('keeps the adopted graph on its split host and audits real nodes, annotation and directed connections', async () => {
    const page = outline(['根据最近发展区设计层次支架', '学习者能独立解决问题时撤除支持']);
    const graph = { topology: 'sequence' as const,
      nodes: ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'].map((label, i) => ({ id: `c${i + 1}`, label })),
      annotation: '顺序表示完整教学环节',
    };
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察五个环节', diagram: graph };
    page.teachingBrief!.teachingPlan!.visualRelationship = { kind: 'sequence', description: '完整五环节',
      readingOrder: graph.nodes.map((node) => node.label), preferredForm: 'diagram', diagram: graph };
    const visual = scene([{ id: 'process', kind: 'process', useAdoptedDiagram: true, nodes: [
      { ...node('design', '支架设计', page.keyPoints[0]!, 1), anchorId: 'c1' },
      { id: 'annotation', text: graph.annotation, sourceContentIds: ['diagram-annotation'], anchorId: 'c1' },
    ] }]);
    visual.pages.push({ id: 'withdrawal', title: '支持何时撤除', focus: '撤除依据',
      components: [{ id: 'condition', kind: 'text', nodes: [node('independence', '撤除依据', page.keyPoints[1]!, 2)] }] });
    const compiled = await compile(page, visual);
    expect(compiled?.continuationPages).toHaveLength(1);
    const [owner, sibling] = expandCompiledSlidePages(page, compiled!);
    expect(owner!.outline.visualIntent?.diagram).toEqual(graph);
    expect(sibling!.outline.visualIntent?.diagram).toBeUndefined();
    expect(sibling!.outline.visualIntent?.representation).toBe('text');
    expect(sibling!.outline.teachingBrief?.teachingPlan?.visualRelationship).toBeUndefined();
    expect(slideRequiredVisibleStatements(owner!.outline)).toEqual(expect.arrayContaining(graph.nodes.map((node) => node.label)));
    expect(slideRequiredVisibleStatements(sibling!.outline)).toEqual([page.keyPoints[1]]);
    expect(auditSlideDensity(owner!.outline, owner!.content).underrepresentedKeyPoints).toEqual([]);
    expect(auditSlideDensity(owner!.outline, owner!.content).semanticStructureSatisfied).toBe(true);
    expect(auditSlideDensity(sibling!.outline, sibling!.content).underrepresentedKeyPoints).toEqual([]);
    expect(auditSlideDensity(sibling!.outline, sibling!.content).semanticStructureSatisfied).toBe(true);
    const regenerated = await compile(owner!.outline, { ...visual, pages: [visual.pages[0]!] }, { allowSplit: false });
    expect(regenerated).not.toBeNull();
    expect(auditSlideDensity(owner!.outline, regenerated!).underrepresentedKeyPoints).toEqual([]);

    const missingNode = structuredClone(owner!.content);
    const original = missingNode.elements.find((element) => element.id === 'process-node-c4')!;
    missingNode.elements = missingNode.elements.filter((element) => element.id !== original.id);
    // Repeating a missing label elsewhere cannot replace the adopted graph object.
    missingNode.elements.push({ ...original, id: 'unrelated-label' });
    expect(auditSlideDensity(owner!.outline, missingNode).underrepresentedKeyPoints)
      .toContainEqual({ keyPoint: '协作学习', coverage: 0 });
    const missingAnnotation = structuredClone(owner!.content);
    missingAnnotation.elements = missingAnnotation.elements.filter((element) => element.id !== 'annotation');
    expect(auditSlideDensity(owner!.outline, missingAnnotation).underrepresentedKeyPoints)
      .toContainEqual({ keyPoint: graph.annotation, coverage: 0 });
    const missingEdge = structuredClone(owner!.content);
    missingEdge.elements = missingEdge.elements.filter((element) => element.id !== 'process-edge-2');
    expect(auditSlideDensity(owner!.outline, missingEdge).issues).toContain('已采纳原图关系未完整可见：独立探索 → 协作学习');
    const reversedEdge = structuredClone(owner!.content);
    const connector = reversedEdge.elements.find((element) => element.id === 'process-edge-2');
    if (connector?.type !== 'line') throw new Error('Expected graph connector');
    [connector.start, connector.end] = [connector.end, connector.start];
    expect(auditSlideDensity(owner!.outline, reversedEdge).semanticStructureSatisfied).toBe(false);
  });

  it.each(graphCases)('audits $name against actual adopted endpoints and relationship labels', async ({ graph }) => {
    const page = outline(graph.nodes.map((node) => node.label));
    page.visualIntent = { representation: 'native-diagram', observationGoal: '观察实际关系', diagram: graph };
    const result = await compile(page, scene([{ id: 'original', kind: 'process', useAdoptedDiagram: true, nodes: [] }]));
    expect(result).not.toBeNull();
    const audit = auditSlideDensity(page, result!);
    expect(audit.underrepresentedKeyPoints).toEqual([]);
    expect(audit.semanticStructureSatisfied).toBe(true);
    expect(audit.issues.filter((issue) => issue.includes('原图'))).toEqual([]);
    if (graph.edges?.some((edge) => edge.label)) {
      const changed = structuredClone(result!);
      const labels = changed.elements.filter((element) => element.type === 'text' && element.id.startsWith('original-edge-label-'));
      expect(labels).toHaveLength(2);
      [labels[0]!.id, labels[1]!.id] = [labels[1]!.id, labels[0]!.id];
      expect(auditSlideDensity(page, changed).issues.some((issue) => issue.includes('原图关系标签未完整可见'))).toBe(true);
    }
  });

  it('fits five complete source-grounded explanations around the original graph without narrowing them into five columns', async () => {
    const notes = [
      '结合学情、目标和主题，按最近发展区建立概念框架、分层支架',
      '引入贴近生活的问题；范例与问题分解',
      '启发式引导后自主探索；按学习水平给予时间、空间和个性化支架，随能力提升渐退',
      '讨论交流、共享观点、相互启发，调整并完善概念理解',
      '主体：自评／小组互评／教师评价；内容：自主学习能力／协作贡献／意义建构',
    ];
    const page = outline(['支架具有暂时性和渐消性，能独立解决问题时撤离；支架随学生发展逐个撤销，不在最后一次性撤销', ...notes]);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '五个真实教学环节', diagram: {
      topology: 'sequence', nodes: ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'].map((label, i) => ({ id: `c${i + 1}`, label })) } };
    const visual: TeachingVisualScene = { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [
      { id: 'withdrawal', title: '支架如何撤除', focus: '撤除条件与逐个渐退', components: [{ id: 'withdrawal-note', kind: 'text',
        nodes: [node('withdrawal-facts', '支架的撤除', page.keyPoints[0]!, 1)] }] },
      { id: 'process', title: '支架式教学的五个环节', focus: '五个完整环节与对应解释', components: [{ id: 'full-process', kind: 'process', useAdoptedDiagram: true,
        nodes: notes.map((text, index) => ({ id: `note-${index}`, text, anchorId: `c${index + 1}`, sourceContentIds: [`adopted-content-${index + 2}`] })) }] },
    ] };
    const result = await compile(page, visual);
    expect(result?.continuationPages).toHaveLength(1);
    const parts = expandCompiledSlidePages(page, result!);
    expect(parts.reduce((sum, part) => sum + part.outline.targetDurationSec!, 0)).toBe(97);
    const graphPage = parts[1]!;
    expect(graphPage.content.elements.filter((element) => element.type === 'shape' && element.id.startsWith('full-process-node-'))).toHaveLength(5);
    expect(graphPage.content.elements.filter((element) => element.type === 'line' && element.id.startsWith('full-process-edge-'))).toHaveLength(4);
    expect(graphPage.content.elements.filter((element) => element.type === 'line' && element.id.startsWith('full-process:annotation-'))).toHaveLength(0);
    for (const [index, text] of notes.entries()) {
      const element = graphPage.content.elements.find((element) => element.id === `note-${index}`);
      expect(element?.type === 'text' && element.content.includes(text)).toBe(true);
    }
    expect(auditSlideDensity(graphPage.outline, graphPage.content).underrepresentedKeyPoints).toEqual([]);
  });

  it('keeps a figure-only continuation and its adopted observation duty without inventing display prose', async () => {
    const page = outline(['叶片是观察对象']);
    page.visualIntent = { representation: 'source-image', observationGoal: '观察叶片形态', resourceRefs: [
      { resourceId: 'leaf-figure', kind: 'source-image', required: true, reason: '教材原图', observationGoal: '观察叶片形态' },
    ] };
    const visual = scene([{ id: 'explanation', kind: 'text', nodes: [node('leaf-note', '观察对象', page.keyPoints[0]!, 1)] }]);
    visual.pages.push({ id: 'figure-page', title: '观察叶片', focus: '观察形态', components: [
      { id: 'original-leaf', kind: 'annotated-image', resourceId: 'leaf-figure', nodes: [] },
    ] });
    const result = await compile(page, visual, { images: [{ id: 'leaf-figure', src: '/leaf.png', width: 900, height: 384 }] });
    expect(result?.continuationPages).toHaveLength(1);
    const parts = expandCompiledSlidePages(page, result!);
    expect(parts[1]!.outline.visualSourceCatalog).toEqual([]);
    expect(parts[1]!.outline.keyPoints).toEqual(['观察叶片形态']);
    expect(parts[1]!.outline.teachingBrief?.teachingPlan?.introduces).toEqual([]);
    expect(parts.reduce((sum, part) => sum + part.outline.targetDurationSec!, 0)).toBe(97);
    const image = parts[1]!.content.elements.find((element) => element.type === 'image');
    expect(image?.width).toBeGreaterThan(700);
    expect(parts[1]!.content.elements.filter((element) => element.type === 'text')).toHaveLength(1);
    expect(auditSlideDensity(parts[1]!.outline, parts[1]!.content).underrepresentedKeyPoints).toEqual([]);
    expect(parts[0]!.outline.visualIntent?.resourceRefs).toEqual([]);
    expect(parts[1]!.outline.visualIntent?.resourceRefs?.map((ref) => ref.resourceId)).toEqual(['leaf-figure']);
  });

  it('scores native visual size, nearby explanations, reading direction and recent repetition independently', () => {
    const visual = scene([{ id: 'graph', kind: 'process', nodes: [node('from', '先观察', '', 1), node('to', '再解释', '', 2)],
      edges: [{ from: 'from', to: 'to', kind: 'sequence' }] }, { id: 'note', kind: 'text', nodes: [node('note-text', '观察依据', '原始证据', 1)] }]);
    const body = { left: 50, top: 128, width: 900, height: 384 };
    const elements = [
      { id: 'from:label', type: 'text' as const, left: 60, top: 180, width: 220, height: 100, rotate: 0, content: '先观察', groupId: 'graph', defaultFontName: 'Noto Sans SC', defaultColor: '#253448' },
      { id: 'to:label', type: 'text' as const, left: 320, top: 180, width: 220, height: 100, rotate: 0, content: '再解释', groupId: 'graph', defaultFontName: 'Noto Sans SC', defaultColor: '#253448' },
      { id: 'note-text', type: 'text' as const, left: 570, top: 180, width: 250, height: 100, rotate: 0, content: '原始证据', groupId: 'note', defaultFontName: 'Noto Sans SC', defaultColor: '#253448' },
    ];
    const rects = [{ ...body, width: 540 }, { ...body, left: 610, width: 340 }];
    const score = scoreTeachingVisualCandidate(visual.pages[0]!, elements, rects, body, 'visual-1');
    const distant = scoreTeachingVisualCandidate(visual.pages[0]!, elements.map((element) => element.id === 'note-text' ? { ...element, top: 440 } : element), rects, body, 'visual-1');
    const backward = scoreTeachingVisualCandidate(visual.pages[0]!, elements.map((element) => element.id === 'to:label' ? { ...element, left: 50, top: 140 } : element), rects, body, 'visual-1');
    const repeated = scoreTeachingVisualCandidate(visual.pages[0]!, elements, rects, body, 'visual-1', ['visual-1', 'visual-1']);
    expect(score.mainVisualArea).toBeGreaterThan(0);
    expect(score.proximity).toBeGreaterThan(distant.proximity);
    expect(score.readingDirection).toBeGreaterThan(backward.readingDirection);
    expect(score.total).toBeGreaterThan(repeated.total);
  });

  it('keeps comparison conditions outside the matrix visible on the same editable canvas', async () => {
    const page = outline(['甲侧重示例', '乙侧重反馈', '两种方法均需适合学习者当前能力']);
    const result = await compile(page, scene([{ id: 'methods', kind: 'comparison', nodes: [
      { ...node('method-a', '示例', '甲侧重示例', 1), row: '主要方式', column: '甲方法' },
      { ...node('method-b', '反馈', '乙侧重反馈', 2), row: '主要方式', column: '乙方法' },
      node('scope', '适用条件', '两种方法均需适合学习者当前能力', 3),
    ] }]));
    expect(result).not.toBeNull();
    expect(result!.elements.some((element) => element.type === 'text' && element.content.includes(page.keyPoints[2]!))).toBe(true);
    expect(auditSlideDensity(page, result!).underrepresentedKeyPoints).toEqual([]);
  });

  it('keeps original evidence and narrative text when it splits visual responsibilities', async () => {
    const page = outline(['学生能独立解决问题时，支架完成作用并撤离', '效果评价包含自评、互评和教师评价']);
    const visual: TeachingVisualScene = { ...scene([]), pages: [
      { id: 'withdrawal', title: '支架的撤除', focus: '撤除条件', components: [{ id: 'condition', kind: 'text', nodes: [node('first', '撤离条件', '能独立解决问题 → 撤离支架', 1)] }] },
      { id: 'evaluation', title: '学习效果评价', focus: '评价主体', components: [{ id: 'people', kind: 'text', nodes: [node('second', '评价主体', '自评／互评／教师评价', 2)] }] },
    ] };
    const result = await compile(page, visual);
    expect(result?.continuationPages).toHaveLength(1);
    const parts = expandCompiledSlidePages(page, result!);
    expect(parts.map((part) => part.outline.keyPoints)).toEqual([[page.keyPoints[0]], [page.keyPoints[1]]]);
    expect(parts.every((part) => part.outline.teachingBrief!.teachingPlan!.newContent === page.teachingBrief!.teachingPlan!.newContent)).toBe(true);
    expect(parts.map((part) => part.outline.teachingBrief!.teachingPlan!.presentationItems![0]!.nodeIds)).toEqual([['knowledge-1'], ['knowledge-2']]);
    expect(parts.reduce((sum, part) => sum + part.outline.targetDurationSec!, 0)).toBe(97);
    for (const part of parts) expect(auditSlideDensity(part.outline, part.content).underrepresentedKeyPoints).toEqual([]);
  });

  it('compiles only the requested candidate and keeps protected deletions without resurrecting an image', async () => {
    const page = outline(['原图观察', '独立解释']);
    const visual = scene([{ id: 'observation', kind: 'annotated-image', resourceId: 'original-image', nodes: [node('caption', '观察对象', '原图观察', 1)] },
      { id: 'notes', kind: 'text', nodes: [node('explain', '必要解释', '独立解释', 2)] }]);
    const previous = await compile(page, visual, { images: [{ id: 'original-image', src: '/figure.png', width: 400, height: 300 }],
      allowedCandidateIds: ['visual-1'] });
    expect(previous).not.toBeNull();
    const edited = structuredClone(previous!);
    edited.elements = edited.elements.filter((element) => element.id !== 'original-image');
    edited.teachingVisual!.components[0]!.modified = true;
    const result = await compile(page, visual, { previous: edited, allowedCandidateIds: ['visual-1'], allowSplit: false });
    expect(result).not.toBeNull();
    expect(result!.teachingVisual!.candidateId).toBe('visual-1');
    expect(result!.elements.some((element) => element.id === 'original-image')).toBe(false);
    expect(result!.teachingVisual!.components[0]!.modified).toBe(true);
  });

  it('retains all-or-nothing capacity results and rejects invalid font measurements', async () => {
    const page = outline(['必要事实'.repeat(600)]);
    const visual = scene([{ id: 'complete', kind: 'text', nodes: [node('too-long', '必要事实', page.keyPoints[0]!, 1)] }]);
    expect(await compile(page, visual, { allowSplit: false })).toBeNull();
    await expect(compile(page, visual, { measure: async () => ({ height: NaN, naturalWidth: 10, lines: [] }) })).rejects.toThrow('measurement');
  });
});
