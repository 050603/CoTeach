import type { SceneOutline } from '@openmaic/lib/types/generation';

export const ASSESSMENT_DEPENDENCY_VERSION = 'actual-taught-assessment-v2';

export type CompletedTeachingEvidence = {
  outline: SceneOutline;
  /** Only generated speech actions; never substitute outline intentions. */
  speech: readonly { text: string }[];
};

function sectionIdentity(outline: SceneOutline): string {
  return outline.lectureSectionId?.trim()
    || outline.parentActivityId?.trim()
    || outline.activityId?.trim()
    || outline.stageKey?.trim()
    || '__course__';
}

function missingDependency(assessment: SceneOutline): Error {
  return Object.assign(new Error(
    `测验“${assessment.title}”缺少已生成的学生讲授内容；请先生成对应教学页面，再生成测验。`,
  ), { code: 'ASSESSMENT_TEACHING_DEPENDENCY_MISSING', isRetryable: false });
}

/**
 * Ground assessment in what students will actually hear before this quiz.
 * Section membership is enough for local checks; crossing sections requires
 * explicit confirmed teaching-unit references, never a guessed title match.
 */
export function buildAssessmentContext(
  assessment: SceneOutline,
  completed: readonly CompletedTeachingEvidence[],
): string {
  if (assessment.type !== 'quiz') return '';
  const eligible = completed.filter(({ outline, speech }) => (
    outline.type !== 'quiz'
    && outline.audience !== 'teacher'
    && outline.generationPurpose !== 'teacher-resource'
    && outline.order < assessment.order
    && speech.some(({ text }) => text.trim().length > 0)
  ));
  const local = eligible.filter(({ outline }) => sectionIdentity(outline) === sectionIdentity(assessment));
  let evidence = local;
  if (evidence.length === 0) {
    const requiredUnits = new Set([
      ...(assessment.assessmentUnitIds ?? []),
      ...(assessment.assessmentTargets ?? []).map((target) => target.unitId),
      ...(assessment.assessmentUnitMap ?? []).map((target) => target.unitId),
    ].filter((unit) => unit.trim().length > 0));
    if (requiredUnits.size === 0) throw missingDependency(assessment);
    evidence = eligible.filter(({ outline }) => (
      outline.teachingUnitIds?.some((unit) => requiredUnits.has(unit))
    ));
    const coveredUnits = new Set(evidence.flatMap(({ outline }) => outline.teachingUnitIds ?? []));
    if ([...requiredUnits].some((unit) => !coveredUnits.has(unit))) throw missingDependency(assessment);
  }
  if (evidence.length === 0) throw missingDependency(assessment);
  const seen = new Set<string>();
  const pages = [...evidence].sort((a, b) => a.outline.order - b.outline.order)
    .filter(({ outline }) => {
      if (seen.has(outline.id)) return false;
      seen.add(outline.id);
      return true;
    })
    .map(({ outline, speech }) => ({
      pageId: outline.id,
      title: outline.title,
      teachingUnitIds: outline.teachingUnitIds ?? [],
      narration: speech.map(({ text }) => text.trim()).filter(Boolean),
    }));
  return JSON.stringify({
    kind: 'completed-student-teaching',
    instruction: '以下讲稿只限定学生已经学过、可以考查的范围。答案是否正确仍由已确认资料、概念边界和适用条件决定；不得把讲稿里的简化线索、替换检验、删除检验或案例特征升级为定义、充分条件或通用规则。规划目标或资料中出现但尚未讲清的内容不能视为已教。',
    answerAuthority: {
      evidence: assessment.teachingBrief?.evidence ?? [],
      conditions: assessment.teachingBrief?.conditions ?? [],
      conceptBoundaries: assessment.teachingBrief?.sharedContext?.conceptBoundaries ?? [],
    },
    pages,
  });
}
