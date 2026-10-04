import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
import { generateSlideVisualProjection, slideVisualSourceContent, unchangedSlideProjection,
  SLIDE_VISUAL_PROJECTION_OPERATION } from './slide-visual-projection';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from './slide-spatial-measurement';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import sharp from 'sharp';

function page(points: string[]): SceneOutline {
  return { id: 'page', type: 'slide', title: '支架撤除', order: 0, description: '知识讲授', keyPoints: points,
    audience: 'student', generationPurpose: 'knowledge-teaching', teachingBrief: {
      schemaVersion: 1, explanation: points.join('。'), examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: points.join('。'), learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: points, presentationContent: points, narrationFocus: [] },
    } };
}

/** Native authoring owns these boxes; media identity and real dimensions are
 * supplied by the host rather than inferred from the author's estimated ratio. */
function nativeMediaResponse(text: string, resourceIds: string[]): string {
  return JSON.stringify({
    elements: [
      { id: 'observation-text', type: 'text', left: 60, top: 130, width: 880, height: 60,
        sourceContentIds: ['adopted-content-1'], content: `<p style="font-size:18px">${text}</p>` },
      ...resourceIds.map((id, index) => ({ id, type: 'image', src: id,
        left: 60 + index * 400, top: 220, width: 240, height: 180, rotate: 0, fixedRatio: true })),
    ],
    components: [],
  });
}
describe('single-pass source-mapped PPT visual projection', () => {
  it.each(['page', 'directory'] as const)('binds the display draft to its owned body and %s case premises in one catalog', async (mode) => {
    const body = '在约定的比较任务中，策略甲更合适；这不排除策略乙还可承担其他辅助作用。';
    const outline = page(['策略甲更适合该任务']);
    outline.teachingBrief!.explanation = '旧的正文副本';
    const plan = outline.teachingBrief!.teachingPlan!;
    plan.presentationItems = [{ text: '策略甲更适合该任务', role: 'key-point',
      nodeIds: ['comparison'] }];
    plan.introduces = ['comparison'];
    plan.newContent = body;
    plan.reasoningSteps = [body];
    outline.teachingBrief!.authoring = { nodes: [{ id: 'comparison', content: body,
      kind: 'relation', prerequisiteNodeIds: [], knowledgePointIds: ['choice'], provenance: 'derived',
      claimRefs: [{ knowledgePointId: 'choice', claimId: 'fit' }], exampleIds: ['task'], quoteDuties: [] }],
      examplePlans: [{ knowledgePointId: 'choice', mode: 'constructed', selectedExampleIds: ['task'], rationale: '对照任务侧重' }],
      knowledge: [{ knowledgePointId: 'choice', authoring: { claims: [{ id: 'fit', kind: 'derived',
        text: '在给定任务中策略甲更合适。', logicalConditions: ['任务侧重范围查找'], sources: [] }],
        examples: [{ id: 'task', kind: 'constructed', title: '记录查找', purpose: '比较方法的适用侧重',
          facts: ['旧的无限定断言'], explanation: '旧案例结论', objectAndTask: '查找一段范围内的记录',
          assumptions: ['任务侧重范围查找'], actions: ['按所需范围检索'], outcome: '获得目标记录',
          correspondences: [{ claimId: 'fit', claimPhrase: '策略甲更合适',
            caseElement: { field: 'actions', index: 0 } }], sources: [] }], exampleCoverage: [] } }] };
    const teachingAuthoringKnowledge = outline.teachingBrief!.authoring.knowledge.map((point) => ({
      id: point.knowledgePointId, authoring: point.authoring,
    }));
    if (mode === 'directory') outline.teachingBrief!.authoring.knowledge = [];
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'fit', sourceContentIds: ['adopted-content-1'],
      text: '在该任务中，策略甲更合适' }] }));
    await generateSlideVisualProjection(outline, ai, mode === 'directory' ? {
      sourceKnowledgePoints: [{ id: 'choice', evidenceItemIds: [] }], teachingAuthoringKnowledge,
    } : {});
    const context = JSON.parse(ai.mock.calls[0][1]);
    expect(context.adoptedSourceBindings).toEqual([{ sourceContentId: 'adopted-content-1',
      presentationItemIndexes: [0], nodeRefs: ['node-1'] }]);
    const node = context.teachingAuthoring.explanationNodes[0];
    expect(context.teachingAuthoring.texts[node.bodyRef]).toBe(body);
    expect(ai.mock.calls[0][1].split(body)).toHaveLength(2);
    const example = context.teachingAuthoring.cases[0];
    expect(context.teachingAuthoring.texts[example.assumptionsRefs[0]]).toBe('任务侧重范围查找');
    expect(example.correspondences[0].caseElement).toEqual({ field: 'actions', index: 0 });
    expect(context).not.toHaveProperty('statementBindings');
    expect(context).not.toHaveProperty('casePremises');
    expect(ai.mock.calls[0][1]).not.toContain('旧的正文副本');
    expect(ai.mock.calls[0][1]).not.toContain('旧案例结论');
    expect(outline).toEqual(saved);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('uses only display and source inputs for a spoken page without rebuilding an authoring graph', async () => {
    const outline = page(['按学生独立能力逐步撤除支架']);
    const stale = '不能再次创作的兼容正文';
    outline.teachingBrief!.manuscript = { sectionId: 'section', segmentIds: ['node'] };
    outline.teachingBrief!.explanation = stale;
    outline.teachingBrief!.teachingPlan!.newContent = stale;
    outline.teachingBrief!.authoring = { nodes: [{ id: 'node', content: stale, kind: 'concept', prerequisiteNodeIds: [], provenance: 'derived' }], knowledge: [], examplePlans: [] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'point', sourceContentIds: ['adopted-content-1'], text: '按学生独立能力逐步撤除支架' }] }));
    await generateSlideVisualProjection(outline, ai);
    const [system, prompt] = ai.mock.calls[0]!;
    const context = JSON.parse(prompt);
    expect(context.adoptedDisplayContent[0].text).toBe('按学生独立能力逐步撤除支架');
    expect(context).not.toHaveProperty('teachingAuthoring');
    expect(context).not.toHaveProperty('pageAuthoring');
    expect(context).not.toHaveProperty('adoptedSourceBindings');
    expect(prompt).not.toContain(stale);
    expect(system).not.toContain('bodyRef');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('omits invalid optional styling while preserving the authored display wording and mapped source', async () => {
    const outline = page(['含义明确']);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'meaning', sourceContentIds: ['adopted-content-1'],
      text: '表示的含义明确', emphasis: ['明确含义', '含义明确'] }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection.items).toEqual([{ id: 'meaning', sourceContentIds: ['adopted-content-1'],
      text: '表示的含义明确', emphasis: ['含义明确'] }]);
    expect(result?.diagnostics).toEqual(['Omitted nonliteral optional emphasis in meaning']);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('records missing mappings and compiles all adopted display points without another model call', async () => {
    const outline = page(['按学生独立能力逐步撤除支架', '保留必要的问题情境']);
    const original = structuredClone(outline);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'unmapped', sourceContentIds: [], text: '逐步撤除支架' }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.diagnostics).toContain('Missing adopted source mapping for unmapped');
    expect(result?.projection.items.map((item) => item.text)).toEqual(outline.keyPoints);
    expect(result?.projection.items.map((item) => item.sourceContentIds)).toEqual([['adopted-content-1'], ['adopted-content-2']]);
    expect(outline).toEqual(original);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('condenses display prose while keeping the original teaching contract and one production request', async () => {
    const original = '支架不是最后阶段一次性撤销，而是一个一个地随着学生的发展而撤销';
    const outline = page([original]);
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify({ items: [{ id: 'withdrawal',
      sourceContentIds: ['adopted-content-1'], label: '逐步撤除', text: '随学生发展逐个撤除，非最后一次性撤销', emphasis: ['逐个撤除'] }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection.verified).toBe(true);
    expect(result?.projection.items[0]?.text).toBe('随学生发展逐个撤除，非最后一次性撤销');
    expect(outline).toEqual(saved);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![0]).toContain(SLIDE_VISUAL_PROJECTION_OPERATION);
    expect(ai.mock.calls[0]![1]).toContain(original);
    expect(ai.mock.calls[0]![0]).not.toContain('PPT_VISUAL_REVIEW');
  });

  it('retains the complete original point when a numeric condition is lost without requesting a judge or repair', async () => {
    const original = '至少完成3次实验，误差不超过5%';
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['adopted-content-1'], text: '完成3次实验，误差5%' }] }));
    const result = await generateSlideVisualProjection(page([original]), ai);
    expect(result?.projection.items[0]?.text).toBe(original);
    expect(result?.diagnostics.join(' ')).toContain('quantity boundary');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('accepts equivalent numeric bounds as single-call display content', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bounds', sourceContentIds: ['adopted-content-1'], text: '实验≥3次；误差≤5%' }] }));
    const result = await generateSlideVisualProjection(page(['至少完成3次实验，误差不超过5%']), ai);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.projection.items[0]?.text).toBe('实验≥3次；误差≤5%');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('rejects an omitted quantity even if a model could have claimed success', async () => {
    const original = '至少完成3次实验，误差不超过5%';
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['adopted-content-1'], text: '完成实验并检查误差' }] }));
    const result = await generateSlideVisualProjection(page([original]), ai);
    expect(result?.projection.items[0]?.text).toBe(original);
    expect(result?.diagnostics).toContain('Changed or omitted quantity in adopted-content-1');
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each([
    { text: '实验≥3次；误差≤5%', accepted: true },
    { text: '完成实验；误差≤5%', accepted: false },
  ])('uses the bound step number without overlooking quantities in the explanation: $text', async ({ text, accepted }) => {
    const original = '1 测量：至少完成3次实验，误差不超过5%';
    const outline = page([original]);
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '观察测量和计算的顺序', diagram: {
      topology: 'sequence', nodes: [{ id: 'measure', label: '1 测量' }, { id: 'calculate', label: '2 计算' }],
    } };
    const before = structuredClone(outline);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'measurement-details',
      diagramNodeId: 'measure', sourceContentIds: ['adopted-content-1'], text }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    if (accepted) {
      expect(result?.diagnostics).toEqual([]);
      expect(result?.projection.items[0]).toMatchObject({ id: 'measurement-details', diagramNodeId: 'measure', text });
      expect(result?.projection.items[0]?.text).not.toContain('1');
    } else {
      expect(result?.diagnostics).toContain('Changed or omitted quantity in adopted-content-1');
      expect(result?.projection.items[0]).toMatchObject({ id: 'adopted-content-1', label: '1 测量', text: '至少完成3次实验，误差不超过5%' });
      expect(result?.projection.items[0]).not.toHaveProperty('diagramNodeId');
    }
    expect(result?.projection.verified).toBe(true);
    expect(outline).toEqual(before);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('diagnoses an unknown diagram node and keeps the original display point without a repair call', async () => {
    const outline = page(['测量：先检查实验条件再收集数据']);
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '观察实验顺序', diagram: {
      topology: 'sequence', nodes: [{ id: 'measure', label: '测量' }, { id: 'calculate', label: '计算' }],
    } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'measurement-details',
      diagramNodeId: 'invented-step', sourceContentIds: ['adopted-content-1'], text: '检查条件后收集数据' }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.diagnostics).toContain('Unknown diagram node for measurement-details');
    expect(result?.projection.items[0]).toMatchObject({ id: 'adopted-content-1', label: '测量', text: '先检查实验条件再收集数据' });
    expect(result?.projection.items[0]).not.toHaveProperty('diagramNodeId');
    expect(result?.projection.verified).toBe(true);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('does not accept source ids or evidence invented by the layout model', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['another-page'],
      sourceEvidenceIds: ['unadopted-book'], text: '独立解决问题后撤除支架' }] }));
    const result = await generateSlideVisualProjection(page(['独立解决问题后撤除支架']), ai);
    expect(result?.projection.verified).toBe(true);
    expect(result?.diagnostics).toEqual(expect.arrayContaining(['Unknown source for bad', 'Unadopted evidence for bad',
      'Missing adopted point adopted-content-1']));
  });

  it.each([
    { ids: ['paragraph-a', 'evidence-a'], adopted: ['evidence-a'], accepted: true },
    { ids: ['shared-paragraph'], adopted: ['evidence-a', 'evidence-b'], accepted: false },
    { ids: ['paragraph-b'], adopted: ['evidence-a'], accepted: false },
    { ids: ['evidence-b'], adopted: ['evidence-a'], accepted: false },
    { ids: ['paragraph-a-unknown'], adopted: ['evidence-a'], accepted: false },
  ])('resolves only uniquely adopted passage identities: $ids', async ({ ids, adopted, accepted }) => {
    const original = '按学生独立能力逐步撤除支架';
    const outline = { ...page([original]), knowledgePointIds: ['scaffolding'] };
    const sourceEvidence: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 1, fingerprint: 'originals', createdAt: '2026-10-03',
      retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [],
      items: ['a', 'b'].map((suffix) => ({
        id: `evidence-${suffix}`, kind: 'concept', title: '支架撤除', content: original,
        source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'revision', revisionVersion: 1,
          sectionPath: ['支架撤除'], sourceBlockId: `paragraph-${suffix}`, quote: original },
        completeSourceBlocks: [{ sourceBlockId: `paragraph-${suffix}`, content: original },
          { sourceBlockId: 'shared-paragraph', content: '随着能力提升逐步减少支持。' }],
      })),
    };
    const authored = { id: 'withdrawal', sourceContentIds: ['adopted-content-1'],
      sourceEvidenceIds: ids, text: '随独立能力提升，逐步撤除支架', label: '撤除依据' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [authored] }));
    const result = await generateSlideVisualProjection(outline, ai, { sourceEvidence,
      sourceKnowledgePoints: [{ id: 'scaffolding', evidenceItemIds: adopted }] });
    if (accepted) {
      expect(result?.diagnostics).toEqual([]);
      expect(result?.projection.items).toEqual([{ ...authored, sourceEvidenceIds: ['evidence-a'] }]);
    } else {
      expect(result?.diagnostics).toContain('Unadopted evidence for withdrawal');
      expect(result?.projection.items[0]?.text).toBe(original);
    }
    expect(ai).toHaveBeenCalledOnce();
  });

  it('checks the complete annotation while preserving every original process node and edge', async () => {
    const outline = page(['提供分层支架']);
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '观察逐步撤除', diagram: {
      topology: 'sequence', nodes: [{ id: 'a', label: '搭脚手架' }, { id: 'b', label: '独立探索' }],
      edges: [{ from: 'a', to: 'b' }], annotation: '随着学生能力提升，逐步减少和撤出支架' } };
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify({ items: [
      { id: 'support', sourceContentIds: ['adopted-content-1'], text: '提供分层支架' },
      { id: 'annotation', sourceContentIds: ['diagram-annotation'], text: '能力提升 → 逐步撤除支架' },
    ] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection.verified).toBe(true);
    expect(slideVisualSourceContent(outline).at(-1)?.id).toBe('diagram-annotation');
    expect(outline).toEqual(saved);
  });

  it('splits page 13 comparison structure into dimensions, objects and real cell explanations', () => {
    const projection = unchangedSlideProjection([
      { id: 'inquiry', text: '问题类型｜探究式：通过实验、自主探索和讨论交流给出答案' },
      { id: 'problem', text: '问题类型｜问题式：不存在唯一正确答案和单一解决方法的劣构问题' },
    ]);
    expect(projection.items).toEqual([
      { id: 'inquiry', sourceContentIds: ['inquiry'], row: '问题类型', column: '探究式', text: '通过实验、自主探索和讨论交流给出答案' },
      { id: 'problem', sourceContentIds: ['problem'], row: '问题类型', column: '问题式', text: '不存在唯一正确答案和单一解决方法的劣构问题' },
    ]);
  });

  it('separates page 21 characteristic headings without removing qualifiers or parsing mathematical bars', () => {
    const projection = unchangedSlideProjection([
      { id: 'context', text: '特征｜教学情境的真实性：在真实或接近真实的情境中学习' },
      { id: 'formula', text: '条件概率 P(A|B) = P(A∩B)/P(B)' },
    ]);
    expect(projection.items[0]).toMatchObject({ label: '教学情境的真实性', text: '在真实或接近真实的情境中学习' });
    expect(projection.items[1]?.text).toBe('条件概率 P(A|B) = P(A∩B)/P(B)');
  });

  it.each(['', '{"items":[]}', '{"items":[{"id":"x","text":"标题"}]}'])('keeps empty or non-executable output a technical error', async (response) => {
    const ai = vi.fn().mockResolvedValue(response);
    await expect(generateSlideVisualProjection(page(['事实']), ai)).rejects.toMatchObject({ code: 'INVALID_GENERATED_OUTPUT' });
  });

  it('does not treat missing source mapping as a complete display contract', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'one', sourceContentIds: ['adopted-content-1'], text: '必要条件' }] }));
    const result = await generateSlideVisualProjection(page(['必要条件', '完整并列项目']), ai);
    expect(result?.projection.items).toHaveLength(2);
    expect(result?.projection.items[1]?.text).toBe('完整并列项目');
    expect(result?.diagnostics).toContain('Missing adopted point adopted-content-2');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('reads missing legacy image dimensions from real bytes and retains source and generated image bindings in one call', async () => {
    const original = '完整观察案例图中的事物关系';
    const outline: SceneOutline = { ...page([original]), mediaGenerations: [{ type: 'image',
      elementId: 'case-image', prompt: '既有案例插图', aspectRatio: '4:3' }] };
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD/wAAAAASUVORK5CYII=';
    const ai = vi.fn().mockResolvedValue(nativeMediaResponse('观察图中事物关系', ['textbook-figure', 'case-image']));
    try {
      const result = await generateOpenMaicBaselineContent(outline, ai, {
        componentAuthoring: true, textMeasure: measureAuthoredSlideText,
        assignedImages: [{ id: 'textbook-figure', src, pageNumber: 7, sourceTitle: '原教材' }],
        imageMapping: { 'textbook-figure': '/original-figure.png' },
        generatedMediaMapping: { 'gen_img_case-image': '/existing-case.png' },
      });
      expect(result).not.toBeNull();
      if (!result || !('elements' in result)) throw new Error('Expected a native slide');
      const images = result.elements.filter((element) => element.type === 'image');
      expect(images.map((image) => image.src)).toEqual(['/original-figure.png', '/existing-case.png']);
      expect(images[0]!.width / images[0]!.height).toBeCloseTo(1);
      expect(images[1]!.width / images[1]!.height).toBeCloseTo(4 / 3);
      expect(result.elements.find((element) => element.id === 'textbook-figure-caption')).toBeUndefined();
      expect(result.contentBindings).toContainEqual({ sourceContentId: 'image:textbook-figure', elementId: 'textbook-figure' });
      expect(result.displayItems).toBeUndefined();
      expect(result.elements.find((element) => element.id === 'observation-text')).toMatchObject({ content: '<p style="font-size:18px">观察图中事物关系</p>' });
      expect(result.contentBindings).toEqual(expect.arrayContaining([
        { sourceContentId: 'adopted-content-1', elementId: 'observation-text' },
      ]));
      expect(result.qualityDiagnostics).toEqual([]);
      expect(ai).toHaveBeenCalledOnce();
    } finally { await closeSpatialMeasurementBrowser(); }
  });

  it('retains a shared generated image without requesting generation and uses its actual dimensions', async () => {
    const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#fff' } }).png().toBuffer();
    const src = `data:image/png;base64,${bytes.toString('base64')}`;
    const outline = page(['观察同一案例图中的关系']);
    outline.visualIntent = { representation: 'generated-image', observationGoal: '观察案例关系', resourceRefs: [
      { resourceId: 'shared-case', kind: 'generated-image', required: true, reason: '复用案例观察材料' },
    ] };
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValue(nativeMediaResponse('观察案例图中的关系', ['shared-case']));
    try {
      const result = await generateOpenMaicBaselineContent(outline, ai, {
        componentAuthoring: true, textMeasure: measureAuthoredSlideText,
        generatedMediaMapping: { 'shared-case': src },
      });
      if (!result || !('elements' in result)) throw new Error('Expected a native slide');
      const image = result.elements.find((element) => element.type === 'image');
      expect(image).toMatchObject({ id: 'shared-case', src });
      expect(image!.width / image!.height).toBeCloseTo(1.6);
      expect(image).not.toHaveProperty('clip');
      expect(outline).toEqual(saved);
      expect(outline.mediaGenerations).toBeUndefined();
      expect(ai).toHaveBeenCalledOnce();
    } finally { await closeSpatialMeasurementBrowser(); }
  });

  it('keeps saved shared image URLs and dimensions alongside textbook images without duplicating resources', async () => {
    const outline = page(['对照案例与教材图']);
    outline.teachingBrief!.teachingPlan!.presentationTypography = { profile: 'reference-lecture-v1', bodyFontSize: 18,
      minimumBodyFontSize: 16 };
    outline.visualIntent = { representation: 'mixed', observationGoal: '对照两图', resourceRefs: [
      { resourceId: 'shared-case', kind: 'generated-image', required: true, reason: '复用案例' },
      { resourceId: 'shared-case', kind: 'generated-image', required: true, reason: '同一观察材料' },
    ] };
    const ai = vi.fn().mockResolvedValue(nativeMediaResponse('对照案例与教材图', ['textbook', 'shared-case']));
    try {
      const result = await generateOpenMaicBaselineContent(outline, ai, {
        componentAuthoring: true, textMeasure: measureAuthoredSlideText,
        assignedImages: [{ id: 'textbook', src: '/textbook.png', width: 640, height: 480, pageNumber: 3, sourceTitle: '教材' }],
        visualBaseline: { elements: [], continuationPages: [{ elements: [{ id: 'shared-case', type: 'image', src: '/saved-case.png',
          left: 50, top: 120, width: 500, height: 250, rotate: 0, fixedRatio: true }] }] },
      });
      if (!result || !('elements' in result)) throw new Error('Expected a native slide');
      const images = [result, ...(result.continuationPages ?? [])].flatMap((page) => page.elements.filter((element) => element.type === 'image'));
      expect(images.map((image) => [image.id, image.src])).toEqual([
        ['textbook', '/textbook.png'], ['shared-case', '/saved-case.png'],
      ]);
      expect(images[0]!.width / images[0]!.height).toBeCloseTo(4 / 3);
      expect(images[1]!.width / images[1]!.height).toBeCloseTo(2);
      expect(result.elements.find((element) => element.id === 'textbook-caption')).toBeUndefined();
      expect(result.contentBindings).toContainEqual({ sourceContentId: 'image:textbook', elementId: 'textbook' });
      expect(ai).toHaveBeenCalledOnce();
    } finally { await closeSpatialMeasurementBrowser(); }
  });

  it('preserves exact request keys for two asynchronously generated images', async () => {
    const outline = page(['比较两幅图']);
    outline.mediaGenerations = [
      { type: 'image', elementId: 'page:media-1', prompt: '第一幅图', aspectRatio: '4:3' },
      { type: 'image', elementId: 'page:media-2', prompt: '第二幅图', aspectRatio: '16:9' },
    ];
    const ai = vi.fn().mockResolvedValue(nativeMediaResponse('比较两幅图', ['page:media-1', 'page:media-2']));
    try {
      const result = await generateOpenMaicBaselineContent(outline, ai, {
        componentAuthoring: true, textMeasure: measureAuthoredSlideText,
      });
      if (!result || !('elements' in result)) throw new Error('Expected a native slide');
      const images = [result, ...(result.continuationPages ?? [])].flatMap((page) => page.elements.filter((element) => element.type === 'image'));
      expect(images.map((image) => image.src)).toEqual(['page:media-1', 'page:media-2']);
      expect(images[0]!.width / images[0]!.height).toBeCloseTo(4 / 3);
      expect(images[1]!.width / images[1]!.height).toBeCloseTo(16 / 9);
      const { replaceMediaPlaceholders } = await import('../server/classroom-media-generation');
      const scenes = [{ type: 'slide', outlineId: outline.id, content: { canvas: { elements: images } } }] as Parameters<typeof replaceMediaPlaceholders>[0];
      replaceMediaPlaceholders(scenes, { 'page:media-1': '/first.png', 'page:media-2': '/second.png' }, [outline]);
      expect(images.map((image) => image.src)).toEqual(['/first.png', '/second.png']);
      expect(ai).toHaveBeenCalledOnce();
    } finally { await closeSpatialMeasurementBrowser(); }
  });
});
