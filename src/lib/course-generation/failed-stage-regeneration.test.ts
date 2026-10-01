import { describe, expect, it } from 'vitest';
import type { SceneOutline, GeneratedSlideContent } from '@/lib/openmaic/types/generation';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import type { Scene } from '@/lib/openmaic/types/stage';
import { fingerprintSceneOutline, type SceneStageCheckpointSnapshot } from './page-checkpoints';
import { planFailedStageRegeneration, explicitFailedStageRequestIdentity } from './failed-stage-regeneration';
import { serializeCourseGenerationFailure } from './failure-policy';
const clause = '在协作学习中注意小组分工的合理安排';
const secondClause = '注意对学生自主完成项目的过程进行监督和调整';
const fullSource = `${clause}。${secondClause}。`;
const page: SceneOutline = { id: 'p1', type: 'slide', order: 0, title: '分工', description: '解释分工', keyPoints: [clause, secondClause],
  generationPurpose: 'knowledge-teaching', lectureSectionId: 's1', knowledgePointIds: ['kp'], teachingUnitIds: ['u1'] };
const sibling = { ...page, id: 'p2', order: 1, keyPoints: ['有效案例'] };
const quiz: SceneOutline = { ...page, id: 'q1', type: 'quiz', order: 2 };
const other = { ...page, id: 'p3', order: 3, lectureSectionId: 's2', knowledgePointIds: ['other'], teachingUnitIds: ['u2'] };
const otherQuiz = { ...quiz, id: 'q2', order: 4, lectureSectionId: 's2' };
const outlines = [page, sibling, quiz, other, otherQuiz];
const contract: FigureSequenceContract = { resourceId: 'book', required: true, scope: 'knowledge-point',
  knowledgePointIds: ['kp'], sequenceSemantics: 'enumerated-items', orderedSteps: [{ label: clause }, { label: secondClause }] };
function body(text = fullSource): GeneratedSlideContent {
  return { elements: [{ id: 'text', type: 'text', content: text, left: 20, top: 20, width: 800, height: 100 }] } as GeneratedSlideContent;
}
function stage(outline = page, kind: SceneStageCheckpointSnapshot['stage'] = 'content', payload: unknown = { content: body() }): SceneStageCheckpointSnapshot {
  return { schemaVersion: 1, pageKey: outline.id, stage: kind, outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint: 'm', inputFingerprint: 'input', payload };
}
function fixture(text = fullSource) {
  return { stageAttempts: [], stages: [stage(page, 'content', { content: body(text) }), stage(sibling, 'content', { content: body('有效案例') }),
    stage(other, 'content'), stage(page, 'narration'), stage(sibling, 'narration')], pages: [],
  sourceContents: [{ status: 'infeasible', sectionId: 's1', issues: [{ resourceId: 'book', sectionId: 's1',
    repairOutlineId: 'p1', targetOutlineIds: ['p1', 'p2'], missingCanonicalLabels: [clause], detail: '教材条目遗漏' }] }] };
}
const request = { sceneOutlines: outlines };
describe('explicit failed-stage regeneration plan', () => {
  it('preserves accepted first-pass teaching even when historical source-content diagnoses remain', () => {
    const saved = fixture('教师将在终稿判断的原始说明。');
    const failed = { ...stage(other, 'actions'), attemptsStarted: 1, status: 'response' };
    const before = JSON.stringify(saved);
    const result = planFailedStageRegeneration({ request, sourceContracts: [contract], reviewContent: false,
      saved: { ...saved, stageAttempts: [failed] } });
    expect(result.needsExplicitSourceEdit).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.resetSteps).toEqual([
      'authoring-acceptance:p3:actions', 'authoring-response:p3:actions', 'stage-attempt:p3:actions',
    ]);
    expect(JSON.stringify(saved)).toBe(before);
  });
  it('permits measured unstarted-page replanning only for the exact explicit capacity retry', () => {
    const failure = serializeCourseGenerationFailure(Object.assign(new Error('完整内容不能容纳'), {
      code: 'TEACHING_PAGE_PREFLIGHT_FAILED', isRetryable: false,
    }));
    expect(explicitFailedStageRequestIdentity(failure, 'retry-1')).toEqual({
      authoringRequestId: 'retry-1', capacityReplanRequestId: 'retry-1',
    });
    for (const error of [null, 'TEACHING_PAGE_PREFLIGHT_FAILED', serializeCourseGenerationFailure(new Error('讲稿无效'))]) {
      expect(explicitFailedStageRequestIdentity(error, 'retry-2')).toEqual({ authoringRequestId: 'retry-2' });
    }
  });
  it('resets only spent unaccepted authoring, preserving accepted bodies and media', () => {
    const accepted = stage();
    const failed = { ...stage(sibling, 'narration'), attemptsStarted: 1, status: 'response' };
    const result = planFailedStageRegeneration({ request, saved: { stages: [accepted],
      stageAttempts: [{ ...accepted, attemptsStarted: 1 }, failed], pages: [], sourceContents: [] } });
    expect(result).toEqual({ resetSteps: ['authoring-acceptance:p2:narration', 'authoring-response:p2:narration', 'stage-attempt:p2:narration'], needsExplicitSourceEdit: false, issues: [] });
  });
  it('keeps a mismatched accepted draft while clearing only its newer failed authoring attempt', () => {
    const result = planFailedStageRegeneration({ request, saved: { stages: [stage()],
      stageAttempts: [{ ...stage(), inputFingerprint: 'new-input', attemptsStarted: 1 }], pages: [], sourceContents: [] } });
    expect(result.resetSteps).not.toContain('stage:p1:content');
    expect(result.resetSteps).toContain('authoring-response:p1:content');
  });
  it('resets an unfinished legacy questions-only quiz but preserves one with accepted actions', () => {
    const legacy = stage(quiz, 'content', { content: { questions: [{ id: 'q' }] } });
    const saved = { stages: [legacy], stageAttempts: [], pages: [], sourceContents: [] };
    expect(planFailedStageRegeneration({ request, saved }).resetSteps).toContain('stage:q1:content');
    expect(planFailedStageRegeneration({ request, saved: { ...saved, stages: [legacy, stage(quiz, 'actions')] } }).resetSteps).toEqual([]);
  });
  it('replaces only the failing section narration when its complete visible source is correct', () => {
    const saved = fixture();
    const before = JSON.stringify(saved);
    const result = planFailedStageRegeneration({ request, saved, sourceContracts: [contract] });
    expect(result.needsExplicitSourceEdit).toBe(false);
    expect(result.resetSteps).toEqual(expect.arrayContaining(['stage:p1:narration', 'stage:p2:narration', 'page:p1', 'page:p2', 'stage:q1:content', 'course-finalization', 'source-content:s1']));
    expect(result.resetSteps.some((key) => key.includes('p3') || key.includes('q2') || key.includes('media'))).toBe(false);
    expect(result.resetSteps).not.toContain('stage:p1:content');
    expect(result.resetSteps).not.toContain('stage:p2:content');
    expect(JSON.stringify(saved)).toBe(before);
  });
  it('resolves section-only diagnostics without treating the section quiz as a missing slide', () => {
    const saved = fixture();
    saved.sourceContents[0]!.issues[0]!.targetOutlineIds = [];
    const result = planFailedStageRegeneration({ request, saved, sourceContracts: [contract] });
    expect(result.needsExplicitSourceEdit).toBe(false);
    expect(result.resetSteps).toContain('stage:p2:narration');
    expect(result.resetSteps).toContain('stage:q1:content');
  });

  it('invalidates only the native body with a proven visible-source failure plus its actual dependencies', () => {
    const result = planFailedStageRegeneration({ request, saved: fixture('只有概念标题'), sourceContracts: [contract] });
    expect(result.needsExplicitSourceEdit).toBe(false);
    expect(result.resetSteps).toContain('stage:p1:content');
    expect(result.resetSteps).not.toContain('stage:p2:content');
    expect(result.resetSteps).toContain('stage:q1:content');
  });
  it('recognizes source-invalid historical finalization without a source recovery checkpoint', () => {
    const scene = (outline: SceneOutline, text: string): Scene => ({ id: outline.id, outlineId: outline.id, stageId: 's', title: outline.title,
      type: 'slide', order: outline.order, content: { type: 'slide', canvas: { id: outline.id, ...body(text) } },
      actions: [{ id: `${outline.id}:speech`, type: 'speech', text: '只有简短案例' }] }) as Scene;
    const saved = { stageAttempts: [], stages: [], pages: [], sourceContents: [], courseFinalization: {
      generated: { assetContext: { outlines }, scenes: [scene(page, '标题'), scene(sibling, '案例')] } } };
    const result = planFailedStageRegeneration({ request, saved, sourceContracts: [contract] });
    expect(result.needsExplicitSourceEdit).toBe(false);
    expect(result.resetSteps).toContain('stage:p1:content');
    expect(result.resetSteps).toContain('stage:p2:narration');
  });
  it('preserves a now-correct accepted section even when an old infeasible diagnostic remains', () => {
    const saved = fixture();
    saved.stages = saved.stages.filter((item) => item.stage !== 'narration').concat([
      stage(page, 'narration', { teachingNarration: { segments: [{ text: fullSource }] } }),
      stage(sibling, 'narration', { teachingNarration: { segments: [{ text: '有效案例' }] } }),
    ]);
    expect(planFailedStageRegeneration({ request, saved, sourceContracts: [contract] }).resetSteps).toEqual([]);
  });

  it('does not buy new slides when the raw native body or source contract is unavailable', () => {
    for (const args of [{ saved: { ...fixture(), stages: [] }, sourceContracts: [contract] },
      { saved: fixture(), sourceContracts: [] }]) {
      const result = planFailedStageRegeneration({ request, ...args });
      expect(result.needsExplicitSourceEdit).toBe(true);
      expect(result.resetSteps).toEqual([]);
    }
  });
  it('invalidates an explicitly referenced cross-section quiz without touching that section teaching', () => {
    const crossQuiz = { ...otherQuiz, assessmentUnitIds: ['u1'] };
    const result = planFailedStageRegeneration({ request: { sceneOutlines: [...outlines.slice(0, -1), crossQuiz] }, saved: fixture(), sourceContracts: [contract] });
    expect(result.resetSteps).toContain('stage:q2:content');
    expect(result.resetSteps).not.toContain('stage:p3:narration');
  });
});
