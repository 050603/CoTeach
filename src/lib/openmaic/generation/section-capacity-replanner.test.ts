import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { SemanticCapacityGroup, SemanticPageCapacityAssessment } from './semantic-page-capacity';
import { rebalanceMeasuredTeachingSection, replanMeasuredTeachingSection } from './section-capacity-replanner';
import type { TextMeasure } from '@openmaic/generation';
import { hasCompatibleOutlinePlan } from '@/lib/course-generation/generation-scope';

const group = (id: string, sourcePageId: string, height: number, extra: Partial<SemanticCapacityGroup> = {}): SemanticCapacityGroup => ({
  id, kind: 'text', visibleText: `完整教学点 ${id}`, narrationExpansion: [`解释 ${id}`],
  sourcePageId, sourceNodeIds: [], knowledgePointIds: [sourcePageId], resourceIds: [],
  indivisibleWith: [], measuredHeight: height, ...extra,
});
const outline = (id: string): SceneOutline => ({
  id, type: 'slide', title: `原页 ${id}`, description: `讲解 ${id}`, keyPoints: [], order: 0,
  generationPurpose: 'knowledge-teaching', lectureSectionId: 'section', knowledgePointIds: [id],
  targetDurationSec: 60, estimatedDuration: 60,
  plannedTiming: { narrationSec: 40, learnerActivitySec: 15, transitionSec: 5, role: 'teaching' },
  teachingBrief: { schemaVersion: 1, explanation: `解释 ${id}`, examples: [], conditions: [], evidence: [],
    assessmentFocus: '', teachingPlan: { purpose: `认识 ${id}`, priorKnowledge: '', newContent: '',
      learnerQuestion: '', reasoningSteps: [], takeaway: '', visibleContent: [], narrationFocus: [],
      introduces: [id], deepens: [], references: [] } },
});
const assessment = (id: string, groups: SemanticCapacityGroup[], decision: SemanticPageCapacityAssessment['decision'], capacity = 330): SemanticPageCapacityAssessment => ({
  schemaVersion: 1, planningVersion: 'semantic-page-capacity-v1', outlineId: id, sourcePageId: id,
  decision, reason: '', measurementMode: 'provided-measure-v1', groups,
  layouts: [{ kind: 'full-width', bodyFontSize: 24, columnWidths: [880], usedHeight: groups.reduce((sum, item) => sum + item.measuredHeight!, 0), availableHeight: capacity, fits: decision === 'fits' }],
});

describe('measured section redistribution', () => {
  it('redistributes display projections together with their complete spoken source meaning', () => {
    const original = outline('first');
    const presentationContent = ['独立来源支持交叉核验', '记录须直接涉及同一说法'];
    const fullMeanings = ['多个网页转载同一份材料，不能作为彼此独立的证据。',
      '只有记录直接涉及待查说法，才能用来支持或者反驳该说法。'];
    original.keyPoints = presentationContent;
    original.teachingBrief!.explanation = fullMeanings.join('\n');
    original.teachingBrief!.teachingPlan!.visibleContent = fullMeanings;
    original.teachingBrief!.teachingPlan!.presentationContent = presentationContent;
    original.teachingBrief!.evidence = [{ sourceId: 'book', quote: fullMeanings[0]! }];
    const groups = presentationContent.map((visibleText, index) => group(`point-${index}`, 'first', 220,
      { visibleText, narrationExpansion: [fullMeanings[index]!], sourceNodeIds: [`definition-${index}`] }));
    const pages = rebalanceMeasuredTeachingSection([original], [assessment('first', groups, 'page-overflow')])!;
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.teachingBrief?.teachingPlan?.presentationContent)).toEqual(
      presentationContent.map((text) => [text]));
    expect(pages.flatMap((page) => page.teachingBrief?.teachingPlan?.visibleContent ?? [])).toEqual(
      [presentationContent[0], fullMeanings[0], presentationContent[1], fullMeanings[1]]);
    expect(pages.flatMap((page) => page.teachingBrief?.teachingPlan?.narrationFocus ?? [])).toEqual(fullMeanings);
    expect(pages.every((page) => page.teachingBrief?.evidence[0]?.quote === fullMeanings[0])).toBe(true);
    expect(pages.reduce((seconds, page) => seconds + page.targetDurationSec!, 0)).toBe(60);
  });

  it('keeps a slightly overloaded source at the minimum of two balanced pages', () => {
    const original = outline('first');
    const groups = [1, 2, 3, 4].map((value) => group(`unit-${value}`, 'first', 145));
    const pages = rebalanceMeasuredTeachingSection([original], [assessment('first', groups, 'page-overflow')])!;
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.keyPoints.length)).toEqual([2, 2]);
    expect(pages.flatMap((page) => page.keyPoints)).toEqual(groups.map((item) => item.visibleText));
    expect(pages.every((page) => page.sectionPlanVersion === pages[0]!.sectionPlanVersion)).toBe(true);
    expect(pages.every((page) => page.sourcePageIds?.join(',') === 'first')).toBe(true);
    expect(pages.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(60);
    expect(pages.reduce((sum, page) => sum + page.plannedTiming!.narrationSec, 0)).toBe(40);
    expect(pages.every((page) => page.targetDurationSec === page.plannedTiming!.narrationSec
      + page.plannedTiming!.learnerActivitySec + page.plannedTiming!.transitionSec)).toBe(true);
  });

  it('gives each continuation its actual visual scope instead of asking it to show the whole section again', () => {
    const original = outline('first');
    const points = ['设计时选择合适内容', '设计时平衡知识与活动', '实施时监督并调整', '评价时核对目标与证据'];
    original.teachingBrief!.teachingPlan!.presentationContent = points;
    original.teachingBrief!.teachingPlan!.visibleContent = [...points];
    original.visualIntent = { representation: 'text', observationGoal: '三个阶段全部放在一页',
      rationale: '在一页内清晰呈现三个阶段与全部建议' };
    original.teachingBrief!.teachingPlan!.visualRelationship = { kind: 'statement',
      description: '一页内呈现设计、实施和评价三个阶段', readingOrder: ['设计', '实施', '评价'],
      preferredForm: 'text', rationale: '三个阶段全部放在一页' };
    const groups = points.map((visibleText, index) => group(`unit-${index}`, 'first', 145, { visibleText }));
    const pages = rebalanceMeasuredTeachingSection([original], [assessment('first', groups, 'page-overflow')])!;
    expect(pages).toHaveLength(2);
    expect(pages[0]?.keyPoints).toEqual(points.slice(0, 2));
    expect(pages[1]?.keyPoints).toEqual(points.slice(2));
    for (const page of pages) {
      expect(page.teachingBrief?.teachingPlan?.visualRelationship?.readingOrder).toEqual(page.keyPoints);
      expect(page.visualIntent?.observationGoal).toBe(page.keyPoints.join('；'));
      expect(page.visualIntent?.rationale).not.toContain('三个阶段');
      expect(page.teachingBrief?.teachingPlan?.visualRelationship?.description).not.toContain('一页内');
    }
    expect(pages.flatMap((page) => page.keyPoints)).toEqual(points);
    expect(original.visualIntent.rationale).toContain('三个阶段');
  });

  it('uses neighboring page capacity and moves a required image with its observation', () => {
    const first = outline('first'), second = outline('second');
    first.mediaGenerations = [{ type: 'image', elementId: 'img', prompt: '教学观察图', aspectRatio: '16:9' }];
    first.teachingBrief!.resourceNeeds = [{ kind: 'image', purpose: '看图比较', required: true, prompt: '教学观察图' }];
    first.visualIntent = { representation: 'generated-image', observationGoal: '观察',
      resourceRefs: [{ kind: 'generated-image', resourceId: 'img', required: true, reason: '教学观察' }] };
    const sourceGroups = [group('a', 'first', 200), group('b', 'first', 100),
      group('c', 'first', 100, { kind: 'media', resourceIds: ['img'], visibleText: '观察图像中的差异' })];
    const nextGroups = [group('d', 'second', 100), group('e', 'second', 100)];
    const pages = rebalanceMeasuredTeachingSection([first, second], [
      assessment('first', sourceGroups, 'page-overflow'), assessment('second', nextGroups, 'fits'),
    ])!;
    expect(pages).toHaveLength(2);
    expect(pages[1]!.sourcePageIds).toEqual(['first', 'second']);
    expect(pages[1]!.mediaGenerations?.map((item) => item.elementId)).toEqual(['img']);
    expect(pages[0]!.mediaGenerations).toHaveLength(0);
    expect(pages[0]!.visualIntent?.representation).toBe('text');
    expect(pages[0]!.teachingBrief?.resourceNeeds).toHaveLength(0);
    expect(pages[1]!.teachingBrief?.resourceNeeds).toHaveLength(1);
    expect(pages.flatMap((page) => page.keyPoints)).toEqual([...sourceGroups, ...nextGroups].map((item) => item.visibleText));
    expect(pages.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(120);
  });

  it('moves only owned table regions and discards the source box budget', () => {
    const first = outline('first'), second = outline('second');
    first.visualPlan = { schemaVersion: 2, composition: 'comparison', density: 'regular',
      coreMessage: '比较两组证据', visualEvidence: ['甲组', '乙组'], readingPath: '左右比较',
      regions: [
        { id: 'premise', kind: 'text', unitId: 'premise', content: '比较条件相同', keyPointIndexes: [0],
          knowledgePointIds: ['first'], readingOrder: 0, x: 60, y: 145, width: 880, height: 90 },
        { id: 'comparison', kind: 'table', unitId: 'comparison', content: '', keyPointIndexes: [1],
          knowledgePointIds: ['first'], readingOrder: 1, x: 60, y: 250, width: 880, height: 140,
          tableCells: [['对象', '观察值'], ['甲组', '12'], ['乙组', '15']] },
      ] };
    first.spatialBudget = { conflicts: [{ first: 'premise', second: 'comparison' }] } as SceneOutline['spatialBudget'];
    const pages = rebalanceMeasuredTeachingSection([first, second], [
      assessment('first', [group('premise', 'first', 200, { sourceRegionIds: ['premise'] }),
        group('comparison', 'first', 150, { kind: 'table', visibleText: '甲组 12；乙组 15',
          sourceRegionIds: ['comparison'], tableCells: [['对象', '观察值'], ['甲组', '12'], ['乙组', '15']] })], 'page-overflow'),
      assessment('second', [group('second-text', 'second', 100)], 'fits'),
    ])!;
    expect(pages).toHaveLength(2);
    expect(pages[0]!.visualPlan?.regions?.map((region) => region.id)).toEqual(['first:premise']);
    expect(pages[1]!.visualPlan?.regions?.map((region) => region.id)).toEqual(['first:comparison']);
    expect(pages[1]!.visualPlan?.regions?.[0]?.tableCells?.[2]).toEqual(['乙组', '15']);
    expect(pages.every((page) => page.spatialBudget === undefined)).toBe(true);
  });

  it('refuses a split that would separate linked statements or cannot fit a complete unit', () => {
    const original = outline('first');
    const linked = [group('a', 'first', 180, { indivisibleWith: ['b'] }),
      group('b', 'first', 180, { indivisibleWith: ['a'] })];
    expect(rebalanceMeasuredTeachingSection([original], [assessment('first', linked, 'page-overflow')])).toBeUndefined();
    expect(rebalanceMeasuredTeachingSection([original], [assessment('first', [group('only', 'first', 340)], 'page-overflow')])).toBeUndefined();
  });

  it('uses a measured same-page composition while preserving linked visual claims', () => {
    const original = outline('first');
    original.visualIntent = { representation: 'generated-image', observationGoal: '观察完整示例',
      resourceRefs: [{ resourceId: 'picture', kind: 'generated-image', required: true, reason: '观察完整示例' }] };
    const groups = [group('observation', 'first', 180, { indivisibleWith: ['picture'] }),
      group('picture', 'first', 400, { kind: 'media', visibleText: '', resourceIds: ['picture'], indivisibleWith: ['observation'] }),
      group('next', 'first', 150)];
    const measured = assessment('first', groups, 'page-overflow');
    const layout = { ...measured.layouts[0]!, kind: 'media-side' as const, usedHeight: 240, fits: true };
    measured.units = [{ id: 'whole-visual', groupIds: ['observation', 'picture'], layouts: [layout], selectedLayout: layout, measuredHeight: 240 }];
    const pages = rebalanceMeasuredTeachingSection([original], [measured])!;
    expect(pages).toHaveLength(2);
    expect(pages[0]!.visualIntent?.resourceRefs?.map((item) => item.resourceId)).toEqual(['picture']);
    expect(pages[0]!.keyPoints).toEqual([groups[0]!.visibleText]);
    expect(pages[1]!.keyPoints).toEqual([groups[2]!.visibleText]);
    expect(pages.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(60);
    expect(pages.flatMap((page) => page.keyPoints)).toEqual(groups.filter((group) => group.visibleText).map((group) => group.visibleText));
  });

  const measure: TextMeasure = async ({ text, width, fontSize, padding }) => {
    const lines = Math.max(1, Math.ceil([...text].length / Math.max(1, Math.floor((width - padding * 2) / fontSize))));
    return { naturalWidth: text.length * fontSize, height: padding * 2 + lines * fontSize * 1.5,
      lines: Array.from({ length: lines }, () => text) };
  };

  it('replans only unlocked adopted pages and keeps original lineage and every timing component', async () => {
    const locked = outline('locked');
    locked.keyPoints = ['已经通过渲染与教材校验的内容保持原样。'];
    locked.sectionPlanVersion = 'accepted-original';
    const failed = outline('replanned-arbitrary-id');
    const facts = Array.from({ length: 5 }, (_, index) => `教材条目${index + 1}：${'完整条件与解释'.repeat(12)}`);
    failed.keyPoints = facts;
    failed.teachingBrief!.teachingPlan!.visibleContent = facts;
    failed.sectionPlanVersion = 'accepted-original';
    failed.sourcePageIds = ['original-source-a', 'original-source-b'];
    const result = await replanMeasuredTeachingSection([locked, failed], { measure, allowAcceptedPlan: true,
      lockedOutlineIds: ['locked'], reason: { category: 'section-overload', requestedPageCount: 5 } });
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines[0]).toBe(locked);
    const changed = result.outlines.slice(1);
    expect(changed).toHaveLength(3);
    expect(changed[0]?.id).toBe('replanned-arbitrary-id');
    expect(changed.flatMap((page) => page.keyPoints)).toEqual(facts);
    expect(changed.every((page) => page.sourcePageIds?.join('|') === 'original-source-a|original-source-b')).toBe(true);
    expect(changed.every((page) => page.sectionPlanVersion === 'accepted-original')).toBe(true);
    expect(hasCompatibleOutlinePlan([locked, failed], result.outlines)).toBe(true);
    expect(changed.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(60);
    expect(changed.reduce((sum, page) => sum + page.plannedTiming!.narrationSec, 0)).toBe(40);
    expect(changed.reduce((sum, page) => sum + page.plannedTiming!.learnerActivitySec, 0)).toBe(15);
    expect(changed.reduce((sum, page) => sum + page.plannedTiming!.transitionSec, 0)).toBe(5);
    expect(result.assessments.slice(1).every((item) => item.selectedLayout?.fits)).toBe(true);
  });

  it('returns an explicit failure for an indivisible definition and preserves a legal adopted plan', async () => {
    const accepted = outline('saved-plan');
    accepted.sectionPlanVersion = 'accepted-original';
    accepted.keyPoints = ['一条完整且可容纳的定义。'];
    const unchanged = await replanMeasuredTeachingSection([accepted], { measure });
    expect(unchanged.status).toBe('unchanged');
    const tooLarge = outline('definition');
    tooLarge.keyPoints = ['定义及其不能省略的适用条件'.repeat(50)];
    const result = await replanMeasuredTeachingSection([tooLarge], { measure,
      reason: { category: 'page-capacity', requestedPageCount: 9 } });
    expect(result.status).toBe('infeasible');
    expect(tooLarge.keyPoints).toEqual(['定义及其不能省略的适用条件'.repeat(50)]);
  });

  it('preserves a complete explicit overview and each ordinal requirement in exact source order', async () => {
    const overview = '教学设计共有五条独立原则，依次是——1.身体参与；2.思维可视；3.多维环境；4.身心交互；5.动态生成。';
    const details = [...'一二三四五'].map((ordinal, index) => `第${ordinal}条要求${'完整实践条件和反思活动'.repeat(7)}${index < 4 ? '；' : '。'}`);
    const point = overview + details.join('');
    const original = outline('first');
    original.keyPoints = [point];
    original.teachingBrief!.teachingPlan!.visibleContent = [point];
    original.teachingBrief!.teachingPlan!.narrationFocus = [point];
    const result = await replanMeasuredTeachingSection([original], { measure, explanationNodes: [{
      id: 'first', kind: 'concept', content: point, knowledgePointIds: ['first'],
      prerequisiteNodeIds: [], provenance: 'course-source',
    }] });
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines.flatMap((page) => page.keyPoints)).toEqual([overview, ...details]);
    expect(result.outlines.flatMap((page) => page.keyPoints).join('')).toBe(point);
    expect(result.outlines.flatMap((page) => page.semanticSourceClaims ?? []).every((claim) => claim.parts.join('') === point && claim.text === point)).toBe(true);
    expect(result.outlines.flatMap((page) => page.teachingBrief?.teachingPlan?.introduces ?? []).filter((id) => id === 'first')).toHaveLength(1);
    expect(result.outlines.slice(1).some((page) => page.teachingBrief?.teachingPlan?.deepens?.includes('first'))).toBe(true);
    expect(result.outlines.every((page) => !page.teachingBrief?.explanation.includes(point))).toBe(true);
    expect(result.assessments.every((item) => item.selectedLayout?.fits)).toBe(true);
    expect(result.outlines.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(60);
  });

  it('keeps ordinary definitions and mismatched ordinal lists indivisible', async () => {
    const original = outline('first');
    original.keyPoints = ['定义与必须同时满足的条件：' + '第一条要求完整说明适用条件；第二条要求不能忽略的例外。'.repeat(30)];
    const ordinary = await replanMeasuredTeachingSection([original], { measure });
    expect(ordinary.status).toBe('infeasible');
    expect(ordinary.assessments[0]?.groups).toHaveLength(1);
    const mismatch = '共有两项：1.甲；2.乙。第二条要求' + '完整条件'.repeat(80) + '；第一条要求' + '完整条件'.repeat(80);
    const invalidOrder = await replanMeasuredTeachingSection([{ ...original, keyPoints: [mismatch] }], { measure });
    expect(invalidOrder.status).toBe('infeasible');
    expect(invalidOrder.assessments[0]?.groups).toHaveLength(1);
  });

  it('clears a moved diagram directive on text pages and keeps the whole diagram on its owner', () => {
    const original = outline('first');
    const diagram = { topology: 'sequence' as const, nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
      edges: [{ from: 'a', to: 'b' }], annotation: '观察完整顺序' };
    original.visualIntent = { representation: 'native-diagram', observationGoal: '观察完整顺序', diagram,
      rationale: '按照原来完整流程绘制环形排列' };
    original.teachingBrief!.teachingPlan!.visualRelationship = { kind: 'sequence', description: '观察完整顺序',
      preferredForm: 'diagram', readingOrder: ['甲', '乙'] };
    const groups = [group('details', 'first', 240), group('diagram', 'first', 280, { kind: 'diagram', visibleText: '观察完整顺序' })];
    const pages = rebalanceMeasuredTeachingSection([original], [assessment('first', groups, 'page-overflow')])!;
    expect(pages[0]!.visualIntent?.diagram).toBeUndefined();
    expect(pages[0]!.visualIntent?.representation).toBe('text');
    expect(pages[0]!.teachingBrief?.teachingPlan?.visualRelationship).toBeUndefined();
    expect(pages[0]!.visualIntent?.observationGoal).toBe(groups[0]!.visibleText);
    expect(pages[0]!.visualIntent?.rationale).not.toContain('环形排列');
    expect(pages[1]!.visualIntent?.diagram).toEqual(diagram);
    expect(pages[1]!.visualIntent?.representation).toBe('native-diagram');
    expect(pages[1]!.visualIntent?.rationale).toBe(original.visualIntent.rationale);
    expect(pages[1]!.teachingBrief?.teachingPlan?.visualRelationship).toEqual(original.teachingBrief!.teachingPlan!.visualRelationship);
  });
});
