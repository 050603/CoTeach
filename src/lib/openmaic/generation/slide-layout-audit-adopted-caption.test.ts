import { describe, expect, it } from 'vitest';
import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import type { DiagramPlan } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { auditSlideDensity } from './slide-layout-audit';
import { TEACHING_VISUAL_THEME as T } from './teaching-visual-theme';

function fixture(topology: DiagramPlan['topology'] = 'sequence', embedded = false) {
  const graph: DiagramPlan = { topology, nodes: [
    { id: 'a', label: '搭脚手架' }, { id: 'b', label: '独立探索' }, { id: 'c', label: '效果评价' },
  ], ...(topology === 'branch' ? { edges: [
    { from: 'a', to: 'b', label: '先启发引导' }, { from: 'a', to: 'c', label: '学习完成后' },
  ] } : {}) };
  const points = graph.nodes.map((node) => node.label);
  const outline: SceneOutline = { id: 'page', type: 'slide', title: '教学环节', order: 0,
    generationPurpose: 'knowledge-teaching', description: '观察完整教学关系', keyPoints: points,
    visualSourceCatalog: [], visualIntent: { representation: 'native-diagram', observationGoal: '观察完整教学关系', diagram: graph },
    teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
        takeaway: '', visibleContent: points, presentationContent: points, narrationFocus: [] } },
  };
  const nodes: PPTShapeElement[] = graph.nodes.map((node, index) => ({
    id: `process-node-${node.id}`, type: 'shape', groupId: 'process', left: 100 + 280 * index, top: 180,
    width: 80, height: 70, rotate: 0, path: 'M0 0H80V70H0Z', viewBox: [80, 70], fill: T.pale, fixedRatio: false,
    ...(embedded ? { text: { content: `<p style="font-size:20px">${node.label}</p>`, align: 'middle' as const,
      defaultFontName: T.font, defaultColor: T.text } } : {}),
  }));
  const captions: PPTTextElement[] = embedded ? [] : graph.nodes.map((node, index) => ({
    id: `${nodes[index]!.id}:label`, type: 'text', groupId: 'process', left: nodes[index]!.left - 25,
    top: 262, width: 130, height: 34, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: T.text,
    content: `<p style="font-size:20px;text-align:center">${node.label}</p>`,
  }));
  const expected = topology === 'branch' ? graph.edges! : [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, ...(topology === 'cycle' ? [{ from: 'c', to: 'a' }] : []),
  ];
  const edges: PPTLineElement[] = expected.map((edge, index) => {
    const from = nodes.find((node) => node.id === `process-node-${edge.from}`)!;
    const to = nodes.find((node) => node.id === `process-node-${edge.to}`)!;
    return { id: `process-edge-${index}`, type: 'line', left: from.left + from.width, top: from.top + from.height / 2,
      width: 2, start: [0, 0], end: [to.left - from.left - from.width, to.top - from.top],
      color: T.blue, style: 'solid', points: ['', 'arrow'] };
  });
  const edgeLabels: PPTTextElement[] = (graph.edges ?? []).flatMap((edge, index) => edge.label ? [{
    id: `process-edge-label-${index}`, type: 'text', left: 190, top: 100 + 40 * index, width: 220, height: 30,
    rotate: 0, content: `<p style="font-size:20px">${edge.label}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: T.text,
  }] : []);
  const elements: PPTElement[] = [
    { id: 'title', type: 'text', left: 48, top: 28, width: 700, height: 50, rotate: 0,
      content: '<p style="font-size:32px">教学环节</p>', defaultFontName: 'Noto Sans SC', defaultColor: T.text },
    ...nodes, ...captions, ...edges, ...edgeLabels,
  ];
  const content: GeneratedSlideContent = { elements, background: { type: 'solid', color: T.background },
    teachingVisual: { scene: { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: 'page',
      title: '教学环节', focus: '观察完整关系', components: [{ id: 'process', kind: 'process', role: 'primary', useAdoptedDiagram: true, nodes: [] }] }] },
      pageId: 'page', candidateId: 'visual-1', compilerVersion: 'fixture', themeVersion: 'fixture',
      components: [{ id: 'process', kind: 'process', elementIds: [...nodes, ...captions, ...edges, ...edgeLabels].map((element) => element.id), sourceContentIds: [] }] },
    presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true, items: [], links: [],
      elementIdsBySource: Object.fromEntries(nodes.map((node) => [`diagram-node:${node.id.slice('process-node-'.length)}`,
        [node.id, ...(embedded ? [] : [`${node.id}:label`])]])) },
  };
  return { outline, content };
}

function mutate(content: GeneratedSlideContent, id: string, patch: Record<string, unknown>) {
  Object.assign(content.elements.find((element) => element.id === id)!, patch);
}

describe('adopted native graph captions', () => {
  it.each(['sequence', 'branch', 'cycle'] as const)('accepts canonical external captions on %s without weakening its directed graph', (topology) => {
    const { outline, content } = fixture(topology);
    const audit = auditSlideDensity(outline, content);
    expect(audit.underrepresentedKeyPoints).toEqual([]);
    expect(audit.semanticStructureSatisfied).toBe(true);
    expect(audit.issues.filter((issue) => issue.includes('原图'))).toEqual([]);
  });

  it.each(['branch', 'cycle'] as const)('retains legacy embedded-label %s coverage', (topology) => {
    const { outline, content } = fixture(topology, true);
    expect(auditSlideDensity(outline, content).underrepresentedKeyPoints).toEqual([]);
    expect(auditSlideDensity(outline, content).semanticStructureSatisfied).toBe(true);
  });

  const invalid: Array<[string, (content: GeneratedSlideContent) => void]> = [
    ['deleted shape', (content) => { content.elements = content.elements.filter((element) => element.id !== 'process-node-b'); }],
    ['deleted caption', (content) => { content.elements = content.elements.filter((element) => element.id !== 'process-node-b:label'); }],
    ['hidden shape', (content) => mutate(content, 'process-node-b', { opacity: 0 })],
    ['unpainted shape', (content) => mutate(content, 'process-node-b', { fill: 'transparent' })],
    ['empty shape path', (content) => mutate(content, 'process-node-b', { path: '' })],
    ['hidden caption', (content) => mutate(content, 'process-node-b:label', { opacity: 0 })],
    ['transparent caption text', (content) => mutate(content, 'process-node-b:label', { defaultColor: '#25344800' })],
    ['CSS hidden caption', (content) => mutate(content, 'process-node-b:label', { content: '<p style="font-size:20px;visibility:hidden">独立探索</p>' })],
    ['changed caption', (content) => mutate(content, 'process-node-b:label', { content: '<p style="font-size:20px">探索</p>' })],
    ['unreadable caption', (content) => mutate(content, 'process-node-b:label', { content: '<p style="font-size:17.99px">独立探索</p>' })],
    ['missing explicit font', (content) => mutate(content, 'process-node-b:label', { content: '<p>独立探索</p>' })],
    ['off-center caption', (content) => mutate(content, 'process-node-b:label', { left: 358.1 })],
    ['caption above shape', (content) => mutate(content, 'process-node-b:label', { top: 249 })],
    ['distant caption', (content) => mutate(content, 'process-node-b:label', { top: 275 })],
    ['unmapped shape', (content) => { content.presentationProjection!.elementIdsBySource['diagram-node:b'] = ['process-node-b:label']; }],
    ['unmapped caption', (content) => { content.presentationProjection!.elementIdsBySource['diagram-node:b'] = ['process-node-b']; }],
    ['wrong shape group', (content) => mutate(content, 'process-node-b', { groupId: 'other-component' })],
    ['wrong caption group', (content) => mutate(content, 'process-node-b:label', { groupId: 'other-component' })],
    ['noncanonical repeated label', (content) => mutate(content, 'process-node-b:label', { id: 'some-other-label' })],
  ];
  it.each(invalid)('does not earn node or relationship coverage from a %s', (_name, change) => {
    const { outline, content } = fixture();
    change(content);
    const audit = auditSlideDensity(outline, content);
    expect(audit.underrepresentedKeyPoints).toContainEqual({ keyPoint: '独立探索', coverage: 0 });
    expect(audit.semanticStructureSatisfied).toBe(false);
  });

  it('accepts the exact minimum font and proximity tolerance', () => {
    const { outline, content } = fixture();
    mutate(content, 'process-node-b:label', { left: 358, top: 274, content: '<p style="font-size:18px">独立探索</p>' });
    expect(auditSlideDensity(outline, content).underrepresentedKeyPoints).toEqual([]);
  });

  it('recognizes the current takeaway fill while retaining the rejection of unrelated colors', () => {
    const { outline, content } = fixture();
    const fill: PPTShapeElement = { id: 'takeaway-background', type: 'shape', left: 100, top: 440, width: 600, height: 50,
      rotate: 0, path: 'M0 0H600V50H0Z', viewBox: [600, 50], fixedRatio: false, fill: T.warmPale };
    content.elements.push(fill);
    expect(auditSlideDensity(outline, content).paletteDeviationCount).toBe(0);
    fill.fill = '#FF00FF';
    expect(auditSlideDensity(outline, content).paletteDeviationCount).toBe(1);
  });

  it.each(['missing', 'reversed', 'undirected', 'wrong endpoint', 'hidden'] as const)('keeps %s arrow relations invalid even when all external labels are present', (change) => {
    const { outline, content } = fixture();
    const edge = content.elements.find((element) => element.id === 'process-edge-0')! as PPTLineElement;
    if (change === 'missing') content.elements = content.elements.filter((element) => element !== edge);
    else if (change === 'reversed') [edge.start, edge.end] = [edge.end, edge.start];
    else if (change === 'undirected') edge.points = ['', ''];
    else if (change === 'wrong endpoint') edge.end = [edge.end[0] - 10, edge.end[1]];
    else mutate(content, edge.id, { opacity: 0 });
    const audit = auditSlideDensity(outline, content);
    expect(audit.underrepresentedKeyPoints).toEqual([]);
    expect(audit.issues).toContain('已采纳原图关系未完整可见：搭脚手架 → 独立探索');
    expect(audit.semanticStructureSatisfied).toBe(false);
  });
});
