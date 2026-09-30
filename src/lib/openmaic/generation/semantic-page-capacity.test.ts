import { describe, expect, it } from 'vitest';
import type { TextMeasure } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { canonicalVisibleContent, evaluateSemanticPageCapacity } from './semantic-page-capacity';

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
          reason: '显示抽取对象' }] },
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
