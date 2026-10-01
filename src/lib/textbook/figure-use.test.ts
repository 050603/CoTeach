import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { CourseTextbookFigureResource } from './course-evidence-types';
import { findCourseTextbookFigureUseIssues, scopeCourseTextbookFigures, type FigureUsePage } from './figure-use';
import { assertRequiredTextbookFiguresAvailable,
  bindRequiredTextbookFiguresToOutlines } from './course-visual-binding';

function figure(id: string, overrides: Partial<CourseTextbookFigureResource> = {}): CourseTextbookFigureResource {
  return {
    id: `textbook_fig_${id}`, figureId: `original-${id}`, assetId: `asset-${id}`,
    src: `/api/uploads/asset-${id}`, publicSrc: `/api/uploads/asset-${id}`,
    pageNumber: 5, relation: 'direct', required: true, status: 'available',
    description: '观察原图中的关系', sourceTitle: '参考教材',
    evidenceItemIds: [`evidence-${id}`], knowledgePointIds: ['concept'],
    width: 1600, height: 900, ...overrides,
  };
}

describe('actual textbook figure use', () => {
  it('keeps directly cited evidence images as references until an explicit page adopts them', () => {
    const resources = [figure('main'), figure('alternative'), figure('unused', {
      status: 'unavailable', failureReason: '文件已删除', assetId: undefined, src: undefined,
    })];
    const scoped = scopeCourseTextbookFigures(resources, [{ sourceSequenceUses: [] }]);

    expect(scoped.map((resource) => resource.required)).toEqual([false, false, false]);
    expect(scoped).toEqual(resources.map((resource) => ({ ...resource, required: false })));
    expect(() => assertRequiredTextbookFiguresAvailable(scoped)).not.toThrow();
    expect(resources.every((resource) => resource.required)).toBe(true);
  });

  it.each<FigureUsePage>([
    { caseObservation: { kind: 'source-image', resourceIds: ['textbook_fig_alternative'] } },
    { resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_alternative' }] },
    { resourceNeeds: [{ kind: 'source-image', assetId: 'asset-alternative' }] },
    { teachingBrief: { resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_alternative' }] } },
    { teachingBrief: { resourceNeeds: [{ kind: 'source-image', assetId: 'asset-alternative' }] } },
    { visualIntent: { resourceRefs: [{ kind: 'source-image', resourceId: 'textbook_fig_alternative', required: true }] } },
    { suggestedImageIds: ['textbook_fig_alternative'] },
  ])('requires the actually adopted alternative through each authoring or compiled field (%#)', (page) => {
    const resources = [figure('main'), figure('alternative', { relation: 'candidate', required: false })];
    const scoped = scopeCourseTextbookFigures(resources, [{ sourceSequenceUses: [], ...page }]);

    expect(scoped.map((resource) => [resource.id, resource.required]))
      .toEqual([['textbook_fig_main', false], ['textbook_fig_alternative', true]]);
  });

  it('recognizes compiled explicit scope after the raw page fields have been removed', () => {
    const scoped = scopeCourseTextbookFigures([figure('main'), figure('alternative')], [{
      teachingBrief: { teachingPlan: { sourceSequenceUses: [] },
        resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_alternative' }] },
    }]);
    expect(scoped.map((resource) => resource.required)).toEqual([false, true]);
  });

  it('does not make prose evidence, generated media, or an optional suggestion a textbook duty', () => {
    const scoped = scopeCourseTextbookFigures([figure('main')], [{ sourceSequenceUses: [],
      caseObservation: { kind: 'generated-image', resourceIds: ['textbook_fig_main'] },
      resourceNeeds: [{ kind: 'image', assetId: 'textbook_fig_main' }],
      visualIntent: { resourceRefs: [
        { kind: 'source-image', resourceId: 'textbook_fig_main', required: false },
        { kind: 'generated-image', resourceId: 'textbook_fig_main', required: true },
      ] },
    }]);
    expect(scoped[0]!.required).toBe(false);
  });

  it('keeps the entire indivisible observation group without reordering, dropping, or rewriting images', () => {
    const resources = [figure('first', { groupKey: 'same-original-observation' }),
      figure('unrelated', { groupKey: 'another-observation' }),
      figure('second', { groupKey: 'same-original-observation', relation: 'candidate', required: false })];
    const pages: FigureUsePage[] = [{ sourceSequenceUses: [],
      caseObservation: { kind: 'source-image', resourceIds: ['textbook_fig_second'] } }];
    const original = structuredClone({ resources, pages });
    const scoped = scopeCourseTextbookFigures(resources, pages);

    expect(scoped.map((resource) => [resource.id, resource.required]))
      .toEqual([['textbook_fig_first', true], ['textbook_fig_unrelated', false], ['textbook_fig_second', true]]);
    expect({ resources, pages }).toEqual(original);
    expect(scopeCourseTextbookFigures(scoped, pages)).toEqual(scoped);
  });

  it('preserves required unavailable adopted figures and unavailable members of adopted groups for diagnosis', () => {
    const unavailable = figure('missing', { status: 'unavailable', failureReason: '原图片记录不存在',
      assetId: undefined, src: undefined, groupKey: 'paired-observation', required: false });
    const scoped = scopeCourseTextbookFigures([unavailable, figure('visible', { groupKey: 'paired-observation' })], [{
      sourceSequenceUses: [], suggestedImageIds: ['textbook_fig_visible'],
    }]);
    expect(scoped[0]).toEqual({ ...unavailable, required: true });
    expect(() => assertRequiredTextbookFiguresAvailable(scoped)).toThrow('原图片记录不存在');
    const directlySelected = scopeCourseTextbookFigures([unavailable], [{ sourceSequenceUses: [],
      resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_missing' }] }]);
    expect(() => assertRequiredTextbookFiguresAvailable(directlySelected)).toThrow('原图片记录不存在');
  });

  it.each<FigureUsePage>([
    { caseObservation: { kind: 'source-image', resourceIds: ['textbook_fig_unknown'] } },
    { resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_unknown' }] },
    { teachingBrief: { resourceNeeds: [{ kind: 'source-image', assetId: 'textbook_fig_unknown' }] } },
    { visualIntent: { resourceRefs: [{ kind: 'source-image', resourceId: 'textbook_fig_unknown', required: true }] } },
    { suggestedImageIds: ['textbook_fig_unknown'] },
  ])('diagnoses an unresolved textbook identity without interrupting authoring or rewriting the choice (%#)', (page) => {
    const pages = [{ sourceSequenceUses: [], ...page }];
    const original = structuredClone(pages);
    const resources = [figure('main')];
    expect(scopeCourseTextbookFigures(resources, pages)).toEqual([{ ...resources[0], required: false }]);
    expect(findCourseTextbookFigureUseIssues(resources, pages))
      .toEqual(['实际采用的教材原图不在当前教材资源目录中：textbook_fig_unknown']);
    expect(pages).toEqual(original);
  });

  it('leaves other uploaded source images to their existing resource availability gate', () => {
    const scoped = scopeCourseTextbookFigures([figure('main')], [{ sourceSequenceUses: [],
      caseObservation: { kind: 'source-image', resourceIds: ['uploaded-image'] },
      resourceNeeds: [{ kind: 'source-image', assetId: 'uploaded-asset' }],
      suggestedImageIds: ['pdf-image-1'],
    }]);
    expect(scoped[0]!.required).toBe(false);
    expect(scopeCourseTextbookFigures([], [{ sourceSequenceUses: [] }])).toEqual([]);
    expect(findCourseTextbookFigureUseIssues([], [{ sourceSequenceUses: [], suggestedImageIds: ['pdf-image-1'] }]))
      .toEqual([]);
  });

  it('keeps old accepted resource duties exactly when pages have no explicit scope marker', () => {
    const resources = [figure('required'), figure('optional', { required: false })];
    expect(scopeCourseTextbookFigures(resources, [{ suggestedImageIds: ['textbook_fig_optional'] }]))
      .toEqual(resources);
    expect(scopeCourseTextbookFigures(resources, [])).toEqual(resources);
    expect(scopeCourseTextbookFigures(resources, [{ sourceSequenceUses: undefined }])).toEqual(resources);
  });

  it('retains adoption from every page when explicit scope and saved pages share a plan', () => {
    const resources = [figure('first'), figure('saved'), figure('unused')];
    const scoped = scopeCourseTextbookFigures(resources, [{ sourceSequenceUses: [],
      suggestedImageIds: ['textbook_fig_first'] }, { suggestedImageIds: ['textbook_fig_saved'] }]);
    expect(scoped.map((resource) => resource.required)).toEqual([true, true, false]);
  });

  it('preserves original flow facts and binds its image to the actual complete teaching page', () => {
    const source = figure('procedure', { orderedSteps: ['采集样本', '比较证据', '解释结论']
      .map((label, index) => ({ label, sourceBlockId: `step-${index}` })) });
    const outlines: SceneOutline[] = [{ id: 'overview', type: 'slide', title: '目标', description: '认识研究目标',
      keyPoints: ['了解证据研究'], order: 0, generationPurpose: 'knowledge-teaching', knowledgePointIds: ['concept'],
      teachingBrief: { schemaVersion: 1, explanation: '理解证据的用途。', examples: [], conditions: [], evidence: [],
        assessmentFocus: '研究目标', teachingPlan: { purpose: '认识目标', priorKnowledge: '', newContent: '研究目标',
          learnerQuestion: '怎样研究', reasoningSteps: [], takeaway: '以证据解释', visibleContent: ['认识研究目标'],
          narrationFocus: [], sourceSequenceUses: [] } } },
    { id: 'procedure', type: 'slide', title: '完整研究步骤', description: '按采集样本、比较证据、解释结论完成研究。',
      keyPoints: ['采集样本', '比较证据', '解释结论'], order: 1, generationPurpose: 'knowledge-teaching',
      knowledgePointIds: ['concept'], suggestedImageIds: [source.id] }];
    const scoped = scopeCourseTextbookFigures([source, figure('unused')], outlines);
    const bound = bindRequiredTextbookFiguresToOutlines(outlines, scoped);

    expect(bound[0]!.suggestedImageIds).toBeUndefined();
    expect(bound[1]!.suggestedImageIds).toEqual([source.id]);
    expect(scoped[0]).toEqual(source);
  });
});
