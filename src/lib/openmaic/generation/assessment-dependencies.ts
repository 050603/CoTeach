import type { SceneOutline } from '@openmaic/lib/types/generation';

export const ASSESSMENT_DEPENDENCY_VERSION = 'predeclared-understanding-standard-v3';

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
  const requiredUnits = new Set([
    ...(assessment.teachingBrief?.understandingCriteria?.supportingUnitIds ?? []),
    ...(assessment.assessmentUnitIds ?? []),
    ...(assessment.assessmentTargets ?? []).map((target) => target.unitId),
    ...(assessment.assessmentUnitMap ?? []).map((target) => target.unitId),
  ].filter((unit) => unit.trim().length > 0));
  if (evidence.length === 0) {
    if (requiredUnits.size === 0) throw missingDependency(assessment);
    evidence = eligible.filter(({ outline }) => (
      outline.teachingUnitIds?.some((unit) => requiredUnits.has(unit))
    ));
  }
  if (evidence.length === 0) throw missingDependency(assessment);
  const coveredUnits = new Set(evidence.flatMap(({ outline }) => outline.teachingUnitIds ?? []));
  const uncoveredUnits = [...requiredUnits].filter((unit) => !coveredUnits.has(unit));
  if (uncoveredUnits.length) {
    throw Object.assign(new Error(
      `测验“${assessment.title}”对应的实际讲稿未覆盖预定理解标准所需单元：${uncoveredUnits.join('、')}。请先补足讲授，不能降低题目标准。`,
    ), { code: 'ASSESSMENT_TEACHING_COVERAGE_INSUFFICIENT', isRetryable: false });
  }
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
    instruction: '以下讲稿只限定学生已经获得的学习机会。答案是否正确和怎样算理解由已采用的资料、概念边界与预定理解标准决定。不得把简化线索或案例特征升级为定义，也不得因讲稿解释不足而降低标准或只考名称识别；发现缺口应保留为教学覆盖不足。至少一道题要求学生简短说明理由，讲评不能承担未讲核心内容的补课职责。',
    answerAuthority: {
      evidence: assessment.teachingBrief?.evidence ?? [],
      conditions: assessment.teachingBrief?.conditions ?? [],
      conceptBoundaries: assessment.teachingBrief?.sharedContext?.conceptBoundaries ?? [],
      understandingCriteria: assessment.teachingBrief?.understandingCriteria,
    },
    pages,
  });
}
