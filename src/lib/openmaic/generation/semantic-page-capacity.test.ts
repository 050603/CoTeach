import { afterAll, describe, expect, it, vi } from 'vitest';
import { compileTextComponents } from '@openmaic/generation';
import type { TextMeasure } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { canonicalVisibleContent, evaluateSemanticPageCapacity } from './semantic-page-capacity';
import { REFERENCE_LECTURE_TYPOGRAPHY } from './slide-presentation-typography';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(closeSpatialMeasurementBrowser);

const measure: TextMeasure = async ({ text, width, fontSize, padding }) => {
  const charactersPerLine = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const lines = Math.max(1, Math.ceil([...text].length / charactersPerLine));
  return { naturalWidth: [...text].length * fontSize, height: padding * 2 + lines * fontSize * 1.5,
    lines: Array.from({ length: lines }, () => text) };
};

function outline(keyPoints: string[], patch: Partial<SceneOutline> = {}): SceneOutline {
  return { id: 'p1', type: 'slide', title: '随机抽样', description: '理解样本和总体的关系',
    keyPoints, order: 0, ...patch };
}

describe('semantic page capacity', () => {
  it('measures restored native diagrams without promoting an unselected source explanation into a mandatory caption', async () => {
    const annotation = '这些完整条件仍必须在讲授与来源中保留，不能因为分页删掉。'.repeat(25);
    const diagram = { topology: 'branch' as const, annotation,
      nodes: [{ id: 'check', label: '判断条件' }, { id: 'yes', label: '条件成立' }, { id: 'no', label: '条件不成立' }],
      edges: [{ from: 'check', to: 'yes' }, { from: 'check', to: 'no' }] };
    const page = outline(['观察条件成立与不成立的两条真实路径。'], {
      visualIntent: { representation: 'native-diagram', observationGoal: '观察条件成立与不成立的两条真实路径。', diagram },
    });
    const saved = structuredClone(page), measured = vi.fn(measure);
    const result = await evaluateSemanticPageCapacity(page, { measure: measured,
      useReferenceLectureTypography: () => true, useRestoredNativeDisplay: () => true });
    expect(result.groups.find((group) => group.kind === 'diagram')?.visibleText).toBe('');
    expect(result.measurementNotes).toContainEqual(expect.stringContaining('保留为来源解释'));
    expect(measured.mock.calls.some(([input]) => input.text === annotation)).toBe(false);
    expect(measured.mock.calls.some(([input]) => input.text.includes('条件不成立'))).toBe(true);
    expect(page).toEqual(saved);
    expect(page.visualIntent!.diagram!.edges).toEqual(diagram.edges);
  });

  it('still measures an explicitly selected caption in restored native mode', async () => {
    const annotation = '只有条件成立时执行该分支，否则执行另一条路径。';
    const page = outline([annotation], { visualIntent: { representation: 'native-diagram', observationGoal: annotation,
      diagram: { topology: 'branch', annotation,
        nodes: [{ id: 'check', label: '判断条件' }, { id: 'yes', label: '成立' }, { id: 'no', label: '不成立' }],
        edges: [{ from: 'check', to: 'yes' }, { from: 'check', to: 'no' }] } } });
    const measured = vi.fn(measure);
    const result = await evaluateSemanticPageCapacity(page, { measure: measured,
      useReferenceLectureTypography: () => true, useRestoredNativeDisplay: () => true });
    expect(result.groups.find((group) => group.kind === 'diagram')?.visibleText).toBe(annotation);
    expect(result.measurementNotes).toBeUndefined();
    expect(measured.mock.calls.some(([input]) => input.text === annotation)).toBe(true);
  });

  it('retains the historical annotation contract when restored display selection is disabled', async () => {
    const annotation = '这段历史图示注释按原合同仍然需要计量。';
    const page = outline(['按顺序观察两步'], { visualIntent: { representation: 'native-diagram', observationGoal: '按顺序观察两步',
      diagram: { topology: 'sequence', annotation, nodes: [{ id: 'a', label: '第一步' }, { id: 'b', label: '第二步' }] } } });
    const measured = vi.fn(measure);
    const result = await evaluateSemanticPageCapacity(page, { measure: measured, useRestoredNativeDisplay: () => false });
    expect(result.groups.find((group) => group.kind === 'diagram')?.visibleText).toBe(annotation);
    expect(result.measurementNotes).toBeUndefined();
    expect(measured.mock.calls.some(([input]) => input.text === annotation)).toBe(true);
  });

  it('measures spoken pages from display only and distributes IDs without copying or comparing speech', async () => {
    const display = ['首先观察记录', '随后比较结果'];
    const page = outline(display, { teachingBrief: { schemaVersion: 1, explanation: '不能读入的旧正文',
      manuscript: { sectionId: 'section', segmentIds: ['a', 'oral', 'b'] },
      examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
        takeaway: '', visibleContent: ['隐藏长正文不能当屏显'], narrationFocus: ['不能补写的讲解提示'],
        introduces: ['a', 'oral', 'b'], deepens: [], references: [],
        presentationItems: display.map((text, index) => ({ text, role: 'key-point', nodeIds: [index ? 'b' : 'a'] })),
        presentationContent: display },
    } });
    const nodes = ['a', 'oral', 'b'].map((id) => ({ id, kind: 'concept' as const,
      // Deliberately matches the wrong display: references, not resemblance, determine ownership.
      content: display[1]!.repeat(50), prerequisiteNodeIds: [], knowledgePointIds: ['kp'], provenance: 'derived' as const }));
    const measured = await evaluateSemanticPageCapacity(page, { measure, explanationNodes: nodes });
    expect(measured.groups.map((group) => group.visibleText)).toEqual(display);
    expect(measured.groups.map((group) => group.sourceNodeIds)).toEqual([['a', 'oral'], ['b']]);
    expect(measured.groups.flatMap((group) => group.narrationExpansion)).toEqual([]);
    const silent = await evaluateSemanticPageCapacity({ ...page, teachingBrief: { ...page.teachingBrief!,
      manuscript: { sectionId: 'section', segmentIds: [] } } }, { measure, explanationNodes: nodes });
    expect(silent.groups.flatMap((group) => group.sourceNodeIds)).toEqual([]);
    expect(silent.groups.flatMap((group) => group.narrationExpansion)).toEqual([]);
  });

  it('measures grouped display paragraphs exactly as the native renderer, without a padded box per claim', async () => {
    const points = Array.from({ length: 10 }, (_, index) => `试验${index + 1}：只有温度与培养时间相同，甲组与乙组的颜色才可比较。`);
    const page = outline(points, { teachingBrief: {
      schemaVersion: 1, explanation: '逐项解释实验的控制条件。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
        visibleContent: [], narrationFocus: [], introduces: [], deepens: [], references: ['experiment'],
        presentationItems: points.map((text) => ({ text, nodeIds: ['experiment'], role: 'key-point' as const })),
        presentationContent: points, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY },
    } });
    const capacity = await evaluateSemanticPageCapacity(page);
    const [compiled] = await compileTextComponents([{ kind: 'textBox', left: 50, top: 130, width: 900,
      paragraphs: points, role: 'body', fontSize: 18 }], measureAuthoredSlideText);
    if (!compiled || compiled.type !== 'text') throw new Error('Expected editable grouped lecture text');
    const fullWidth = capacity.layouts.find((layout) => layout.kind === 'full-width' && layout.bodyFontSize === 18)!;
    expect(fullWidth).toMatchObject({ fits: true, usedHeight: compiled.height });
    expect(capacity.groups.reduce((sum, group) => sum + group.measuredHeight!, 0) + 12 * 9).toBeGreaterThan(fullWidth.availableHeight);
    expect(capacity.groups.map((group) => group.visibleText)).toEqual(points);
    expect(capacity.groups.every((group) => group.sourceNodeIds.length === 0 && group.referencedNodeIds?.[0] === 'experiment')).toBe(true);
  });

  it('keeps actual prior display sources distinct from new teaching ownership', async () => {
    const items = [
      { text: '承接已讲概念：根据相同维度比较', nodeIds: ['prior'], role: 'heading' as const },
      { text: '只有条件相同，才能判断本次变化', nodeIds: ['new', 'prior'], role: 'key-point' as const },
    ];
    const page = outline(items.map((item) => item.text), { teachingBrief: {
      schemaVersion: 1, explanation: '展开当前条件及其边界。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
        visibleContent: [], narrationFocus: [], introduces: ['new'], deepens: [], references: ['prior'],
        presentationItems: items, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY },
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.groups.map((group) => group.sourceNodeIds)).toEqual([[], ['new']]);
    expect(capacity.groups.map((group) => group.referencedNodeIds)).toEqual([['prior'], ['prior']]);
    expect(capacity.groups.map((group) => group.presentationItems)).toEqual(items.map((item) => [item]));
  });

  it('keeps a complete annotated diagram beside an existing display with its real established source', async () => {
    const items = [
      { text: '用流程检查活动是否完整', nodeIds: ['flow'], role: 'heading' as const },
      { text: '三步有真实先后关系；遗漏任何一步，活动都不完整', nodeIds: ['flow'], role: 'key-point' as const },
      { text: '检查任务：只有结果，没有采样，缺少哪一步？', nodeIds: ['flow'], role: 'case-observation' as const },
    ];
    const diagram = { topology: 'sequence' as const, nodes: [{ id: 'a', label: '提出问题' }, { id: 'b', label: '采样核对' }, { id: 'c', label: '分析结果' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], annotation: '这三步按真实顺序组成完整活动。' };
    const page = outline(items.map((item) => item.text), { visualIntent: { representation: 'native-diagram', observationGoal: '检查流程完整性', diagram },
      teachingBrief: { schemaVersion: 1, explanation: '观察此前已讲流程。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
          visibleContent: [], narrationFocus: [], introduces: [], deepens: [], references: [],
          presentationItems: items, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY } },
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure, explanationNodes: [{
      id: 'flow', kind: 'relation', content: '流程依次为提出问题、采样核对、分析结果。', knowledgePointIds: [], prerequisiteNodeIds: [], provenance: 'course-source',
    }] });
    const visual = capacity.groups.find((group) => group.kind === 'diagram')!;
    const observation = capacity.groups.find((group) => visual.indivisibleWith.includes(group.id))!;
    expect(visual.visibleText).toBe(diagram.annotation);
    expect(observation.presentationItems?.[0]?.nodeIds).toEqual(['flow']);
    expect(observation.referencedNodeIds).toEqual(['flow']);
    expect(capacity.groups.every((group) => group.sourceNodeIds.length === 0)).toBe(true);
    expect(capacity.units?.find((unit) => unit.groupIds.includes(visual.id))?.groupIds).toContain(observation.id);
    expect(page.visualIntent?.diagram).toBe(diagram);
  });

  it('binds authored case observations to their picture without duplicating the old long source cue', async () => {
    const items = [
      { text: '甲图保留了鱼身，但增添了牛角', nodeIds: ['case'], role: 'case-observation' as const },
      { text: '乙图出现牛角、四条腿和斑纹', nodeIds: ['case'], role: 'case-observation' as const },
    ];
    const oldCue = '原案例的完整故事与原因。'.repeat(20);
    const page = outline(items.map((item) => item.text), { visualIntent: { representation: 'generated-image', observationGoal: oldCue,
      resourceRefs: [{ resourceId: 'picture', kind: 'generated-image', required: true, reason: '对照已有案例', observationGoal: oldCue }] },
      mediaGenerations: [{ type: 'image', elementId: 'picture', prompt: '两个形象的对照', aspectRatio: '16:9' }],
      teachingBrief: { schemaVersion: 1, explanation: oldCue, examples: [], conditions: [], evidence: [], assessmentFocus: '',
        teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
          visibleContent: [], narrationFocus: [oldCue], introduces: [], deepens: [], references: ['case'],
          presentationItems: items, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY } },
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    const visual = capacity.groups.find((group) => group.kind === 'media')!;
    expect(capacity.groups.filter((group) => group.visibleText).map((group) => group.visibleText)).toEqual(items.map((item) => item.text));
    expect(visual.indivisibleWith).toEqual(capacity.groups.filter((group) => group.visibleText).map((group) => group.id));
    expect(capacity.groups.flatMap((group) => group.narrationExpansion)).toContain(oldCue);
    expect(page.visualIntent?.resourceRefs?.[0]?.observationGoal).toBe(oldCue);
  });

  it('measures concise authored comparisons at 18/16 and keeps explicit explanation ownership', async () => {
    const presentationItems = [
      { text: '随机抽样：明确每个对象的抽取机会', nodeIds: ['random'], role: 'comparison' as const },
      { text: '便利抽样：直接选取身边对象', nodeIds: ['convenience'], role: 'comparison' as const },
    ];
    const random = '随机抽样必须使目标总体中的对象具有明确的被抽取机会。';
    const convenience = '便利抽样是根据对象的可接近性选取样本的方法，不能据此保证每个对象有相同机会。';
    const page = outline(presentationItems.map((item) => item.text), { teachingBrief: {
      schemaVersion: 1, explanation: `${random}\n${convenience}`, examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: `${random}\n${convenience}`, learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: [random, convenience], narrationFocus: [random, convenience],
        introduces: ['random', 'convenience'], deepens: [], references: [], presentationItems,
        presentationContent: presentationItems.map((item) => item.text), presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY,
        visualRelationship: { kind: 'comparison', preferredForm: 'text', description: '比较两种取样方式',
          rationale: '对齐两种方式的取样依据', readingOrder: presentationItems.map((item) => item.text) },
      },
    } });
    const measured = vi.fn(measure);
    const capacity = await evaluateSemanticPageCapacity(page, { measure: measured, explanationNodes: [
      { id: 'random', kind: 'concept', content: random, knowledgePointIds: ['sampling'], prerequisiteNodeIds: [], provenance: 'course-source' },
      { id: 'convenience', kind: 'concept', content: convenience, knowledgePointIds: ['sampling'], prerequisiteNodeIds: [], provenance: 'course-source' },
    ] });
    expect(capacity.planningVersion).toBe('semantic-page-capacity-v3');
    expect(capacity.decision).toBe('fits');
    expect(capacity.layouts.find((layout) => layout.kind === 'full-width' && layout.bodyFontSize === 18)?.fits).toBe(true);
    expect(capacity.selectedLayout).toMatchObject({ kind: 'two-column', bodyFontSize: 18, fits: true });
    expect(capacity.groups.map((group) => group.sourceNodeIds)).toEqual([['random'], ['convenience']]);
    expect(capacity.groups.map((group) => group.presentationItems)).toEqual(presentationItems.map((item) => [item]));
    expect(capacity.groups.map((group) => group.narrationExpansion)).toEqual([[random], [convenience]]);
    expect(new Set(measured.mock.calls.map(([input]) => input.fontSize))).toEqual(new Set([32, 18, 16]));
  });

  it('retains separately authored headings instead of merging them into a longer display point', async () => {
    const presentationItems = [
      { text: '条件与边界', nodeIds: ['condition'], role: 'heading' as const },
      { text: '条件与边界：只有来自目标总体\n结论才适用于该总体', nodeIds: ['condition'], role: 'key-point' as const },
    ];
    const page = outline(presentationItems.map((item) => item.text), { teachingBrief: {
      schemaVersion: 1, explanation: '完整的口头解释。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '',
        visibleContent: [], narrationFocus: [], introduces: ['condition'], deepens: [], references: [], presentationItems,
        presentationContent: presentationItems.map((item) => item.text), presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY },
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.groups.map((group) => group.visibleText)).toEqual(presentationItems.map((item) => item.text));
    expect(capacity.groups.map((group) => group.sourceNodeIds)).toEqual([['condition'], ['condition']]);
  });

  it('measures adopted display points while retaining the full source definition for narration', async () => {
    const definition = '随机抽样是指从目标总体中按随机规则选取样本的方法。';
    const sourceExplanation = `${definition}${'只有个体具有明确的被抽取机会，才能减少人为选择产生的偏差。'.repeat(18)}`;
    const presentationContent = ['从目标总体按随机规则抽取样本', '个体须有明确的被抽取机会'];
    const page = outline([sourceExplanation], { teachingBrief: {
      schemaVersion: 1, explanation: sourceExplanation, examples: [], conditions: [],
      evidence: [{ sourceId: 'book', quote: definition }], assessmentFocus: '判断抽样机会',
      teachingPlan: { purpose: '建立抽样含义', priorKnowledge: '', newContent: sourceExplanation,
        learnerQuestion: '', reasoningSteps: [], takeaway: presentationContent.join('；'),
        visibleContent: [sourceExplanation], presentationContent, narrationFocus: [],
        introduces: ['sampling-definition'], deepens: [], references: [] },
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure, explanationNodes: [{
      id: 'sampling-definition', kind: 'concept', content: sourceExplanation, knowledgePointIds: ['sampling'],
      prerequisiteNodeIds: [], provenance: 'course-source',
    }] });
    expect(capacity.decision).toBe('fits');
    expect(capacity.groups.map((group) => group.visibleText)).toEqual(presentationContent);
    expect(capacity.groups.flatMap((group) => group.narrationExpansion)).toContain(sourceExplanation);
    expect(capacity.groups.flatMap((group) => group.sourceNodeIds)).toContain('sampling-definition');
    expect(page.teachingBrief?.teachingPlan?.visibleContent).toEqual([sourceExplanation]);
    expect(page.teachingBrief?.evidence[0]?.quote).toBe(definition);
  });

  it('keeps a complete definition and distinct qualification while collapsing restatements', () => {
    const definition = '随机抽样是指从目标总体中按随机规则选取样本的方法。';
    expect(canonicalVisibleContent({ required: [definition], proposed: [
      '随机抽样是从目标总体中按随机规则选取样本的方法',
      '随机抽样必须让目标总体中的对象都有被选中的机会。',
    ] })).toEqual([
      definition,
      '随机抽样必须让目标总体中的对象都有被选中的机会。',
    ]);
    expect(canonicalVisibleContent({ inherited: ['实验在 20℃ 下进行'],
      proposed: ['实验在 30℃ 下进行'] })).toHaveLength(2);
    expect(canonicalVisibleContent({ required: ['样本来自目标总体'],
      proposed: ['样本来自目标总体，并且每个对象都有被抽中的机会'] })).toHaveLength(2);
  });

  it('finds a one-page two-column arrangement after full-width stacking overflows', async () => {
    const page = outline(Array.from({ length: 4 }, (_, index) => `第${index + 1}项：${'教学内容'.repeat(12)}`));
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('optimize-layout');
    expect(capacity.layouts.find((layout) => layout.kind === 'full-width' && layout.bodyFontSize === 24)?.fits).toBe(false);
    expect(capacity.selectedLayout?.kind).toBe('two-column');
    expect(capacity.groups).toHaveLength(4);
    expect(capacity.groups.every((group) => group.measuredHeight && group.measuredHeight > 0)).toBe(true);
  });

  it('measures required media and chooses a side-by-side native layout', async () => {
    const page = outline(['随机抽样从目标总体取得样本。'], {
      visualIntent: { observationGoal: '观察抽取对象', representation: 'generated-image',
        resourceRefs: [{ resourceId: 'img-1', kind: 'generated-image', required: true,
          reason: '帮助理解抽样', observationGoal: '显示抽取对象' }] },
      mediaGenerations: [{ type: 'image', elementId: 'img-1', prompt: '抽取样本', aspectRatio: '16:9' }],
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('fits');
    expect(capacity.selectedLayout?.kind).toBe('media-side');
    expect(capacity.groups.find((group) => group.kind === 'media')).toMatchObject({
      resourceIds: ['img-1'], measuredHeight: expect.any(Number), sourcePageId: 'p1',
    });
    const picture = capacity.groups.find((group) => group.resourceIds.includes('img-1'))!;
    const observation = capacity.groups.find((group) => group.visibleText === '显示抽取对象')!;
    expect(picture.indivisibleWith).toContain(observation.id);
    expect(observation.indivisibleWith).toContain(picture.id);
    expect(capacity.groups.some((group) => group.visibleText === '随机抽样从目标总体取得样本。')).toBe(true);
  });

  it.each([false, true])('never promotes an internal media rationale to teaching content (explicit observation: %s)', async (explicitObservation) => {
    const reason = '只有看到这张图片，学生才能理解对象之间的差别。';
    const observation = '两组培养物在相同条件下呈现不同的边缘与颜色。';
    const point = '只有比较相同培养条件，颜色差异才可作为分类依据。';
    const page = outline([point], {
      visualIntent: { observationGoal: observation, representation: 'generated-image',
        resourceRefs: [{ resourceId: 'culture', kind: 'generated-image', required: true,
          reason, ...(explicitObservation ? { observationGoal: observation } : {}) }] },
      mediaGenerations: [{ type: 'image', elementId: 'culture', prompt: '两组培养物对照', aspectRatio: '4:3' }],
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    const observed = capacity.groups.find((group) => group.visibleText === observation)!;
    const picture = capacity.groups.find((group) => group.resourceIds.includes('culture'))!;
    expect(picture.indivisibleWith).toContain(observed.id);
    expect(observed.indivisibleWith).toContain(picture.id);
    expect(capacity.groups.filter((group) => group.kind === 'text').map((group) => group.visibleText))
      .toEqual([point, observation]);
    expect(capacity.groups.flatMap((group) => [group.visibleText, ...group.narrationExpansion])).not.toContain(reason);
    expect(page.visualIntent?.resourceRefs?.[0]?.reason).toBe(reason);
  });

  it('tries a narrower media column before declaring a portrait image excessive', async () => {
    const page = outline(['观察根、茎与叶的位置。'], {
      visualIntent: { observationGoal: '观察完整植株', representation: 'generated-image',
        resourceRefs: [{ resourceId: 'portrait', kind: 'generated-image', required: true,
          reason: '显示完整植株' }] },
      mediaGenerations: [{ type: 'image', elementId: 'portrait', prompt: '完整植株', aspectRatio: '9:16' }],
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('optimize-layout');
    expect(capacity.selectedLayout?.kind).toBe('media-side');
    expect(capacity.selectedLayout?.mediaWidth).toBe(180);
  });

  it('keeps source ownership and relation-linked authored regions together', async () => {
    const page = outline(['条件甲决定结果乙', '条件乙决定结果丙'], {
      visualPlan: { schemaVersion: 2, composition: 'relationship', density: 'regular',
        coreMessage: '两项条件对应两个结果', visualEvidence: [], readingPath: '从左到右',
        regions: [
          { id: 'a', kind: 'text', content: '条件甲决定结果乙', unitId: 'pair', keyPointIndexes: [0],
            knowledgePointIds: ['k1'], readingOrder: 0, x: 60, y: 145, width: 400, height: 100 },
          { id: 'b', kind: 'text', content: '条件乙决定结果丙', unitId: 'pair', keyPointIndexes: [1],
            knowledgePointIds: ['k2'], readingOrder: 1, x: 500, y: 145, width: 400, height: 100 },
        ] },
    });
    const capacity = await evaluateSemanticPageCapacity(page, {
      measure, sourcePageId: 'original', explanationNodes: [{ id: 'node-a', kind: 'relation',
        content: '条件甲决定结果乙', knowledgePointIds: ['k1'], prerequisiteNodeIds: [], provenance: 'course-source' }],
    });
    expect(capacity.groups[0]).toMatchObject({ sourcePageId: 'original', sourceNodeIds: ['node-a'],
      knowledgePointIds: ['k1', 'k2'] });
    expect(capacity.groups).toHaveLength(1);
  });

  it('retains a condition and its directed prerequisite without forcing both onto one page', async () => {
    const statements = ['变量表示可变化的数量', '只有同一条件下的数值才可直接比较'];
    const page = outline(statements, { teachingBrief: {
      schemaVersion: 1, explanation: '解释变量与比较条件', examples: [], conditions: [], evidence: [],
      assessmentFocus: '说明比较条件', teachingPlan: {
        purpose: '理解变量', priorKnowledge: '', newContent: '变量表示可变化的数量', learnerQuestion: '',
        reasoningSteps: [], takeaway: statements.join('；'), visibleContent: statements,
        narrationFocus: ['比较时需要控制其他条件'], introduces: ['n1', 'n2'], deepens: [], references: [],
      },
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure, explanationNodes: [
      { id: 'n1', kind: 'concept', content: statements[0], knowledgePointIds: ['k1'],
        prerequisiteNodeIds: [], provenance: 'course-source' },
      { id: 'n2', kind: 'condition', content: statements[1], knowledgePointIds: ['k1'],
        prerequisiteNodeIds: ['n1'], provenance: 'course-source' },
    ] });
    expect(capacity.groups[0]?.indivisibleWith).toEqual([]);
    expect(capacity.groups[1]?.indivisibleWith).toEqual([]);
    expect(capacity.groups[1]?.prerequisiteNodeIds).toEqual(['n1']);
    expect(capacity.groups.flatMap((group) => group.narrationExpansion)).toContain('比较时需要控制其他条件');
  });

  it('treats a local collision as a single-page layout problem', async () => {
    const page = outline(['样本来自目标总体'], { spatialBudget: {
      schemaVersion: 1, canvas: { width: 1000, height: 562.5 }, safeBody: { x: 60, y: 145, width: 880, height: 335 },
      title: { text: '随机抽样', bounds: { x: 60, y: 8, width: 880, height: 128 }, fontSize: 32,
        lineHeight: 1.5, measuredHeight: 60, maxLines: 2 }, reserveRatio: 0.1, regions: [], occupied: [], remaining: [],
      conflicts: [{ first: 'a', second: 'b', intersection: { x: 100, y: 200, width: 20, height: 20 } }],
      connectors: [], measurement: 'browser-renderer-fonts-v1',
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('optimize-layout');
  });

  it('treats an oversized title allocation as a title layout problem', async () => {
    const page = outline(['必要的教学结论'], { title: '很长的规范标题'.repeat(30) });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.titleHeight).toBeGreaterThan(128);
    expect(capacity.decision).toBe('optimize-layout');
  });

  it('reports real overflow even when a diagram form or local collision remains unresolved', async () => {
    const point = '必须完整保留每项教材事实与适用条件'.repeat(30);
    const page = outline([point], {
      teachingBrief: { schemaVersion: 1, explanation: point, examples: [], conditions: [], evidence: [],
        assessmentFocus: '', teachingPlan: { purpose: '解释完整条件', priorKnowledge: '', newContent: point,
          learnerQuestion: '', reasoningSteps: [], takeaway: point, visibleContent: [point],
          narrationFocus: [], introduces: [], deepens: [], references: [],
          visualRelationship: { kind: 'sequence', description: '理解顺序', preferredForm: 'diagram', readingOrder: [] } } },
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('page-overflow');
    expect(capacity.selectedLayout).toBeUndefined();
    expect(capacity.groups[0]?.visibleText).toBe(point);
  });

  it('does not hide complete body overload behind a long title', async () => {
    const page = outline(['完整保留每个条目中的条件与结论。'.repeat(80)], {
      title: '很长的规范标题'.repeat(30),
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.titleHeight).toBeGreaterThan(128);
    expect(capacity.layouts.every((layout) => !layout.fits)).toBe(true);
    expect(capacity.selectedLayout).toBeUndefined();
    expect(capacity.decision).toBe('page-overflow');
  });

  it('retains a full-width diagram allocation and measures its annotation exactly once', async () => {
    const annotation = '箭头表示流程依次推进，最后回到起点重新检查。';
    const page = outline([annotation], { visualIntent: {
      representation: 'native-diagram', observationGoal: '观察完整步骤和反馈关系',
      diagram: { topology: 'sequence', annotation,
        nodes: [
          { id: 'one', label: '确定教学的核心主题' },
          { id: 'two', label: '设计接近生活的情境' },
          { id: 'three', label: '确定获取资源的方法' },
          { id: 'four', label: '自主探索并评价反馈' },
        ], edges: [{ from: 'one', to: 'two' }, { from: 'two', to: 'three' }, { from: 'three', to: 'four' }] },
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    const diagram = capacity.groups.find((group) => group.kind === 'diagram')!;
    expect(Number.isFinite(diagram.measuredHeight)).toBe(true);
    expect(diagram.measuredHeight).toBeLessThan(512.5);
    expect(diagram.visibleText).toBe(annotation);
    expect(capacity.groups).toHaveLength(1);
    expect(capacity.selectedLayout?.fits).toBe(true);
    expect(capacity.units?.[0]?.selectedLayout?.mediaWidth).toBeGreaterThan(328);
  });

  it('reports capacity overload for an odd ring instead of accepting uneven rectangular rows', async () => {
    const labels = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计',
      '协作学习环境设计', '学习效果评价设计', '强化练习设计', '迁移应用设计', '新一轮设计'];
    const diagram = { topology: 'cycle' as const, nodes: labels.map((label, index) => ({ id: `s${index}`, label })),
      annotation: '每个步骤有独立的设计责任，最后一步反馈到第一步，重新依据学生的学习表现检查教学目标并调整下一轮设计。' };
    const page = outline([diagram.annotation], { visualIntent: {
      representation: 'native-diagram', observationGoal: '观察完整九步闭环', diagram,
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    expect(capacity.decision).toBe('page-overflow');
    expect(capacity.selectedLayout).toBeUndefined();
    expect(capacity.groups.find((group) => group.kind === 'diagram')?.measuredHeight).toBeUndefined();
    expect(page.visualIntent!.diagram!.nodes.map((node) => node.label)).toEqual(labels);
  });

  it('measures related picture and observation layouts without adding their full-width heights', async () => {
    const observation = '观察根茎与叶的位置，比较植株不同部位的功能。';
    const page = outline([observation, '叶片通过光合作用合成有机物。'], {
      visualIntent: { representation: 'generated-image', observationGoal: observation,
        resourceRefs: [{ resourceId: 'plant', kind: 'generated-image', required: true, reason: observation }] },
      mediaGenerations: [{ type: 'image', elementId: 'plant', prompt: '植株观察图', aspectRatio: '4:3' }],
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    const unit = capacity.units!.find((item) => item.groupIds.some((id) => id === 'resource-plant'))!;
    expect(unit.groupIds).toHaveLength(2);
    expect(unit.selectedLayout?.kind).toBe('media-side');
    expect(unit.selectedLayout?.fits).toBe(true);
    expect(unit.measuredHeight).toBeLessThan(capacity.groups.find((item) => item.id === 'resource-plant')!.measuredHeight!);
    expect(capacity.groups.slice(0, 2).map((group) => group.kind)).toEqual(['text', 'media']);
    expect(capacity.groups.filter((group) => group.kind === 'text').map((group) => group.visibleText)).toEqual(page.keyPoints);
  });

  it('uses immutable source-image dimensions rather than guessing a generated-image ratio', async () => {
    const page = outline(['比较原图中的全部四阶段关系。'], { visualIntent: {
      representation: 'source-image', observationGoal: '比较原图中的全部四阶段关系',
      resourceRefs: [{ resourceId: 'source', kind: 'source-image', required: true, reason: '观察原图' }],
    } });
    const capacity = await evaluateSemanticPageCapacity(page, { measure, resourceDimensions: { source: { width: 500, height: 500 } } });
    expect(capacity.groups.find((group) => group.id === 'resource-source')?.measuredHeight).toBe(900);
    expect(capacity.selectedLayout?.fits).toBe(true);
    expect(capacity.units?.find((unit) => unit.groupIds.includes('resource-source'))?.selectedLayout?.mediaWidth).toBeLessThanOrEqual(328);
  });

  it('anchors a mixed source-image page to its complete source flow without adding a duplicate page-wide caption', async () => {
    const concept = '问题式教学以真实且开放的问题组织学习，问题没有唯一的正确答案。';
    const flow = '项目教学依次经历选择项目、制定计划、活动探究、制作作品、成果交流、活动评价六个环节。';
    const points = [concept, flow];
    const page = outline(points, { visualIntent: {
      representation: 'mixed', observationGoal: points.join('；'),
      resourceRefs: [{ resourceId: 'source-flow', kind: 'source-image', required: true,
        reason: '知识点首次完整讲解必须使用的教材原图；来源信息',
        observationGoal: '知识点首次完整讲解必须使用的教材原图；来源信息' }],
    } });
    const original = structuredClone(page);
    const capacity = await evaluateSemanticPageCapacity(page, { measure,
      resourceDimensions: { 'source-flow': { width: 501, height: 291 } },
      resourceSequences: { 'source-flow': ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价']
        .map((label) => ({ label })) },
    });
    expect(capacity.selectedLayout?.fits).toBe(true);
    expect(capacity.groups.filter((group) => group.visibleText).map((group) => group.visibleText)).toEqual(points);
    const image = capacity.groups.find((group) => group.resourceIds.includes('source-flow'))!;
    const anchor = capacity.groups.find((group) => group.visibleText === flow)!;
    expect(image.indivisibleWith).toEqual([anchor.id]);
    expect(anchor.indivisibleWith).toContain(image.id);
    expect(page).toEqual(original);
  });

  it.each([false, true])('keeps the source image with its own canonical flow when a native diagram is present (same source: %s)', async (sameSource) => {
    const sourceLabels = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'];
    const otherLabels = ['创设情境', '自主探究', '解释点拨', '拓展延伸', '评价反思'];
    const flow = `项目教学依次经历${sourceLabels.join('、')}六个环节。`;
    const other = `探究教学依次经历${otherLabels.join('、')}五个环节。`;
    const diagramLabels = sameSource ? sourceLabels : otherLabels;
    const nodes = diagramLabels.map((label, index) => ({ id: `d${index}`, label }));
    const diagram = { topology: 'sequence' as const, nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })),
      annotation: sameSource ? flow : other };
    const page = outline(sameSource ? [flow] : [flow, other], { visualIntent: {
      representation: 'mixed', observationGoal: '分别观察两种教学流程，不能把它们连接为同一条顺序。', diagram,
      resourceRefs: [{ resourceId: 'source-flow', kind: 'source-image', required: true,
        reason: '观察选用教材中的项目教学流程', observationGoal: '项目教学的六个环节及其顺序' }],
    } });
    const before = structuredClone(page);
    const capacity = await evaluateSemanticPageCapacity(page, { measure,
      resourceDimensions: { 'source-flow': { width: 501, height: 291 } },
      resourceSequences: { 'source-flow': sourceLabels.map((label) => ({ label })) },
    });
    const image = capacity.groups.find((group) => group.resourceIds.includes('source-flow'))!;
    const anchor = capacity.groups.find((group) => group.visibleText === flow)!;
    const native = capacity.groups.find((group) => group.kind === 'diagram')!;
    expect(image.indivisibleWith).toEqual([anchor.id]);
    expect(anchor.indivisibleWith).toContain(image.id);
    if (sameSource) expect(anchor).toBe(native);
    else {
      expect(anchor).not.toBe(native);
      expect(native.indivisibleWith).not.toContain(image.id);
      expect(capacity.units?.find((unit) => unit.groupIds.includes(image.id))?.groupIds).not.toContain(native.id);
      expect(native.visibleText).toBe(other);
    }
    expect(capacity.groups.map((group) => group.visibleText).join('\n')).toContain(flow);
    expect(page).toEqual(before);
  });

  it.each([false, true])('measures a combined observation once and preserves additional conditions (extra condition: %s)', async (extraCondition) => {
    const points = ['甲组培养物的边缘呈圆形。', '乙组培养物的边缘不规则。'];
    const observation = `${points.join('；')}${extraCondition ? '只有培养条件相同才可比较。' : ''}`;
    const page = outline(points, { visualIntent: { representation: 'mixed', observationGoal: observation,
      resourceRefs: [{ resourceId: 'culture', kind: 'generated-image', required: true,
        reason: '帮助比较培养物', observationGoal: observation }] },
      mediaGenerations: [{ type: 'image', elementId: 'culture', prompt: '培养物对照', aspectRatio: '16:9' }],
    });
    const capacity = await evaluateSemanticPageCapacity(page, { measure });
    const text = capacity.groups.filter((group) => group.visibleText).map((group) => group.visibleText);
    expect(text).toEqual(extraCondition ? [...points, observation] : points);
    const media = capacity.groups.find((group) => group.resourceIds.includes('culture'))!;
    expect(media.indivisibleWith).toEqual(capacity.groups.filter((group) =>
      extraCondition ? group.visibleText === observation : points.includes(group.visibleText)).map((group) => group.id));
  });

  it('keeps a complete source fact when a similar annotation omits its qualification', async () => {
    const fact = '项目流程按选择项目、制定计划、活动探究、制作作品、成果交流、活动评价六个环节推进，其中活动探究是核心环节，作品制作常与它紧密结合。';
    const annotation = '项目流程按选择项目、制定计划、活动探究、制作作品、成果交流、活动评价六个环节推进，活动探究是核心环节。';
    const nodes = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'].map((label, index) => ({ id: `s${index}`, label }));
    const capacity = await evaluateSemanticPageCapacity(outline([fact], { visualIntent: {
      representation: 'native-diagram', observationGoal: '完整流程与核心环节',
      diagram: { topology: 'sequence', annotation, nodes,
        edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })) },
    } }), { measure });
    expect(capacity.groups.find((group) => group.kind === 'text')?.visibleText).toBe(fact);
    expect(capacity.groups.find((group) => group.kind === 'diagram')?.visibleText).toBe(annotation);
  });
});
