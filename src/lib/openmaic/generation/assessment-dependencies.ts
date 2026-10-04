import type { SceneOutline } from '@openmaic/lib/types/generation';
import { firstPassUnderstandingGoals } from './first-pass-authoring';

export const ASSESSMENT_DEPENDENCY_VERSION = 'predeclared-understanding-standard-v4-reference-actions';

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
  const requiredUnits = new Set([
    ...(assessment.teachingBrief?.understandingCriteria?.supportingUnitIds ?? []),
    ...(assessment.assessmentUnitIds ?? []),
    ...(assessment.assessmentTargets ?? []).map((target) => target.unitId),
    ...(assessment.assessmentUnitMap ?? []).map((target) => target.unitId),
  ].filter((unit) => unit.trim().length > 0));
  // A quiz can assess both the current section and explicitly referenced
  // teaching from an earlier section. Keep all local teaching, then add only
  // prior pages whose declared teaching units are required by this quiz.
  // Previously, finding any local page prevented the cross-section evidence
  // from being considered, so a valid mixed quiz was reported as uncovered.
  const referencedPrior = requiredUnits.size === 0
    ? []
    : eligible.filter(({ outline }) => (
        sectionIdentity(outline) !== sectionIdentity(assessment)
        && outline.teachingUnitIds?.some((unit) => requiredUnits.has(unit))
      ));
  const evidence = [...local, ...referencedPrior];
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
  if (assessment.teachingBrief?.manuscript
    || assessment.teachingBrief?.authoring && assessment.teachingBrief.understandingCriteria?.goalSource === 'references') {
    return JSON.stringify({
      kind: 'completed-student-teaching',
      instruction: '实际讲稿只证明学生获得了哪些学习机会，不证明讲稿中的命题正确。考查动作和引用由主请求的 understandingCriteria 指定，事实与必要条件由主请求的原文和实际案例前提决定；兼容目标、概括、误区和讲稿结论都不是独立答案依据。保留真实讲授范围，不能以讲评代替未讲核心内容。',
      pages,
    });
  }
  return JSON.stringify({
    kind: 'completed-student-teaching',
    instruction: '以下讲稿只限定学生已经获得的学习机会。答案是否正确和怎样算理解由已采用的资料、概念边界与预定理解标准决定。不得把简化线索或案例特征升级为定义，也不得因讲稿解释不足而降低标准或只考名称识别；发现缺口应保留为教学覆盖不足。按知识目标选择需要的作答形式；讲评不能承担未讲核心内容的补课职责。',
    answerAuthority: {
      evidence: assessment.teachingBrief?.evidence ?? [],
      conditions: assessment.teachingBrief?.conditions ?? [],
      conceptBoundaries: assessment.teachingBrief?.sharedContext?.conceptBoundaries ?? [],
      understandingCriteria: assessment.teachingBrief?.understandingCriteria,
    },
    pages,
  });
}

/** Give the quiz narration the actual teaching on either side of its page. */
export function buildQuizNarrationContext(
  assessment: SceneOutline,
  completed: readonly CompletedTeachingEvidence[],
  progression: readonly SceneOutline[],
): string {
  if (assessment.type !== 'quiz') return '';
  const referenceGoals = Boolean(assessment.teachingBrief?.manuscript || assessment.teachingBrief?.authoring
    && assessment.teachingBrief.understandingCriteria?.goalSource === 'references');
  const precedingSection = completed
    .filter(({ outline, speech }) => outline.type !== 'quiz'
      && outline.audience !== 'teacher'
      && outline.generationPurpose !== 'teacher-resource'
      && outline.order < assessment.order
      && sectionIdentity(outline) === sectionIdentity(assessment)
      && speech.some(({ text }) => text.trim()))
    .sort((left, right) => left.outline.order - right.outline.order)
    .map(({ outline, speech }) => ({
      pageId: outline.id,
      coreUnderstanding: referenceGoals ? undefined : outline.teachingBrief?.teachingPlan?.takeaway,
      actualNarration: speech.map(({ text }) => text.trim()).filter(Boolean),
    }));
  const position = progression.findIndex((outline) => outline.id === assessment.id);
  const nextOutline = position >= 0 ? progression.slice(position + 1).find((outline) =>
    outline.audience !== 'teacher' && outline.generationPurpose !== 'teacher-resource') : undefined;
  const nextTeaching = nextOutline && nextOutline.type !== 'quiz'
    ? completed.find(({ outline }) => outline.id === nextOutline.id)
    : undefined;
  const continuesIntoProject = nextOutline?.type === 'pbl'
    || nextOutline?.stageKey === 'make'
    || nextOutline?.stageKey === 'project-practice'
    || (!nextOutline && assessment.stageKey === 'ai-learning' && assessment.narrationMode !== 'embedded-segment');
  return JSON.stringify({
    currentSection: {
      ...(referenceGoals ? { sectionId: sectionIdentity(assessment),
        understandingCriteria: firstPassUnderstandingGoals(assessment) } : {
        learningPurpose: assessment.teachingBrief?.sharedContext?.learningPurpose,
        understandingGoals: assessment.teachingBrief?.understandingCriteria?.goals,
        assessmentFocus: assessment.teachingBrief?.assessmentFocus,
      }),
    },
    precedingSection,
    continuation: nextOutline
      ? continuesIntoProject ? 'project-practice' : 'next-page'
      : continuesIntoProject ? 'project-practice' : 'verified-course-end',
    nextPage: nextOutline ? {
      type: nextOutline.type,
      stageLabel: nextOutline.stageLabel || (continuesIntoProject ? '项目实践' : undefined),
      title: nextOutline.type === 'quiz' ? undefined : nextOutline.title,
      sectionTitle: nextOutline.lectureSectionTitle,
      learningPurpose: referenceGoals ? undefined : nextOutline.teachingBrief?.sharedContext?.learningPurpose,
      teachingObjective: referenceGoals ? undefined : nextOutline.teachingObjective,
      entryPoint: nextOutline.teachingBrief?.teachingPlan?.entryPoint,
      newContent: referenceGoals ? undefined : nextOutline.teachingBrief?.teachingPlan?.newContent,
      actualOpening: nextTeaching?.speech.find(({ text }) => text.trim())?.text.trim(),
    } : continuesIntoProject
      ? { type: 'pbl', stageLabel: '项目实践' }
      : null,
  });
}
