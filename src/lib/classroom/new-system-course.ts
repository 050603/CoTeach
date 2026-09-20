import type {
  PblModuleTimingPlan,
  PblTimingRecommendationConfidence,
} from "@/lib/pbl-time-model";
import type { Course, KnowledgePoint, OpenMaicSceneOutlineSnapshot, TeachingOutlineSection } from "@/lib/session/types";
import { allocateLectureBudget, isKnowledgeLectureBudgetInRange } from "./knowledge-lecture-budget";
import type { CourseStagePlan } from "@/lib/resource-package/types";

export const NEW_SYSTEM_STAGE_KEYS = [
  "launch",
  "ai-learning",
  "make",
  "showcase",
  "reflection",
] as const;

export type NewSystemReadinessCheck = {
  id: string;
  label: string;
  ok: boolean;
  message: string;
};

export type NewSystemAiDurationRecommendation = {
  durationMin: number;
  rationale: string;
  confidence: PblTimingRecommendationConfidence;
  knowledgePointBudgets: Array<{
    knowledgePointId: string;
    durationMin: number;
    rationale: string;
  }>;
  evidence: string[];
  assumptions: string[];
  scopeWarning?: string;
};

function distributeIntegerMinutes(totalMinutes: number, weights: readonly number[]): number[] {
  const unit = weights.length > totalMinutes ? 60 : 1;
  return allocateLectureBudget(totalMinutes * unit, weights).map((value) => value / unit);
}

export function buildNewSystemAiTimingPlan(
  recommendation: NewSystemAiDurationRecommendation,
  knowledgePoints: readonly KnowledgePoint[],
  generatedAt: string = new Date().toISOString(),
): PblModuleTimingPlan {
  const totalMinutes = Math.max(1, Math.round(recommendation.durationMin));
  const budgetById = new Map(recommendation.knowledgePointBudgets.map((budget) => [
    budget.knowledgePointId,
    budget,
  ]));
  const weights = knowledgePoints.map((point) => budgetById.get(point.id)?.durationMin ?? 1);
  const distributed = distributeIntegerMinutes(totalMinutes, weights);
  const recommendedStageTotals = {
    launch: 0,
    knowledge: totalMinutes,
    proposal: 0,
    practice: 0,
    showcase: 0,
    reflection: 0,
    other: 0,
  };
  return {
    schemaVersion: 1,
    totalMinutes,
    status: "confirmed",
    allocations: knowledgePoints.map((point, index) => ({
      id: `new-system-ai-learning-${point.id}`,
      title: point.name,
      stageKey: "ai-learning",
      activityKind: "knowledge",
      durationMin: distributed[index] ?? 1,
      recommendedDurationMin: distributed[index] ?? 1,
      knowledgePointIds: [point.id],
    })),
    recommendedStageTotals,
    recommendationSource: "llm",
    confidence: recommendation.confidence,
    rationaleByStage: {
      "ai-learning": recommendation.rationale,
    },
    assumptions: recommendation.assumptions,
    evidence: [
      ...recommendation.evidence,
      ...(recommendation.scopeWarning ? [`范围提醒：${recommendation.scopeWarning}`] : []),
      ...knowledgePoints.map((point, index) => {
        const budget = budgetById.get(point.id);
        return `${point.name}：${distributed[index] ?? 1} 分钟${budget?.rationale ? `（${budget.rationale}）` : ""}`;
      }),
    ],
    generatedAt,
    confirmedAt: generatedAt,
  };
}

/** Deterministic compatibility helper used only when no model judgment exists. */
export function buildNewSystemTimingPlan(
  aiDurationMinutes: number,
  generatedAt: string = new Date().toISOString(),
): PblModuleTimingPlan {
  const plan = buildNewSystemAiTimingPlan({
    durationMin: aiDurationMinutes,
    rationale: "按当前知识结构为知识讲授预留分节讲解、练习与节末小测时间。",
    confidence: "medium",
    knowledgePointBudgets: [{
      knowledgePointId: "all-knowledge",
      durationMin: aiDurationMinutes,
      rationale: "尚未提供逐知识点时间判断。",
    }],
    evidence: ["知识讲授总时长"],
    assumptions: ["该计划只描述第二阶段知识讲授，不分配其他 PBL 阶段时间。"],
  }, [{
    id: "all-knowledge",
    name: "知识讲授",
    description: "当前课程的分节知识讲授内容",
    level: "core",
  }], generatedAt);
  return {
    ...plan,
    recommendationSource: "deterministic-fallback",
  };
}

export function isNewSystemAiTimingPlan(
  timing: PblModuleTimingPlan | null | undefined,
  courseHours?: number,
  stagePlan?: CourseStagePlan,
): timing is PblModuleTimingPlan {
  if (!timing || timing.status !== "confirmed") return false;
  const aiAllocations = timing.allocations.filter(
    (allocation) => allocation.stageKey === "ai-learning",
  );
  const aiMinutes = aiAllocations.reduce(
    (sum, allocation) => sum + Math.max(0, allocation.durationMin),
    0,
  );
  return aiAllocations.length > 0
    && timing.allocations.length === aiAllocations.length
    && Math.abs(timing.totalMinutes - aiMinutes) < 0.000001
    && aiMinutes > 0
    && ((courseHours === undefined && !stagePlan) || isKnowledgeLectureBudgetInRange(timing.totalMinutes, courseHours ?? 0, stagePlan));
}

export function buildNewSystemAiTeachingOutline(
  timingPlan: PblModuleTimingPlan,
  knowledgePoints: readonly KnowledgePoint[],
): TeachingOutlineSection[] {
  const durationMin = timingPlan.allocations
    .filter((allocation) => allocation.stageKey === "ai-learning")
    .reduce((sum, allocation) => sum + allocation.durationMin, 0) || 1;
  return [{
    id: "new-system-ai-learning",
    stageKey: "ai-learning",
    title: "知识讲授",
    durationMin,
    teachingGoal: "帮助学生理解完成项目所需的核心知识，并通过互动练习确认掌握情况。",
    teacherRole: "巡视学习进展，对共性困难进行现场补充讲解。",
    platformRole: "呈现分节讲授内容、节末小测、AI 助教讲解与学习进度。",
    aiRole: "讲解核心知识，提供针对性练习并反馈学生作答。",
    studentActivity: "按顺序完成知识学习、互动练习和阶段检测。",
    activityKind: "knowledge",
    knowledgePointIds: knowledgePoints.map((point) => point.id),
    openMaicUse: "student-ai-learning",
    resourceTypes: ["ppt", "interactive-demo"],
    notes: "新版备课阶段唯一需要生成的课堂内容。",
  }];
}

export function hasExactKnowledgeLecturePageBudget(
  outlines: ReadonlyArray<Pick<OpenMaicSceneOutlineSnapshot, "targetDurationSec" | "estimatedDuration">>,
  minutes: number,
): boolean {
  const durations = outlines.map((outline) => outline.targetDurationSec ?? outline.estimatedDuration);
  return durations.length > 0 && durations.every((seconds) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
    && Math.abs(durations.reduce<number>((sum, seconds) => sum + (seconds ?? 0), 0) - minutes * 60) < 0.001;
}

function sameStageKeys(keys: readonly string[]): boolean {
  return keys.length === NEW_SYSTEM_STAGE_KEYS.length
    && keys.every((key, index) => key === NEW_SYSTEM_STAGE_KEYS[index]);
}

export function getNewSystemCourseReadiness(
  course: Course,
): NewSystemReadinessCheck[] {
  const timing = course.content.moduleTimingPlan;
  const outlines = course.content._openmaicSceneOutlines ?? [];
  const aiOnlyOutlines = outlines.length > 0 && outlines.every(
    (outline) =>
      outline.stageKey === "ai-learning"
      && outline.audience !== "teacher",
  );
  const lectureSections = course.content.knowledgeLectureSections ?? [];
  const blueprintMode = course.content.teachingBlueprint?.assessmentMode;
  const timingAudit = course.content.teachingTimingAudit;
  // Natural narration can differ from its planning estimate. Preserve the
  // measured deviation for teacher review, but only missing/incomplete audio
  // evidence blocks readiness; a duration preference must not force rewrites.
  const blueprintTimingAuditValid = !blueprintMode || Boolean(
    timingAudit?.complete
    && Number.isFinite(timingAudit.substantiveTeachingDurationSec)
    && timingAudit.substantiveTeachingDurationSec > 0
    && (timingAudit.narrationDurationSource === "estimated-script"
      || (timingAudit.narrationDurationSource === "actual-audio"
        && Number.isInteger(timingAudit.narrationSegmentCount)
        && timingAudit.narrationSegmentCount > 0
        && timingAudit.measuredSegmentCount === timingAudit.narrationSegmentCount)),
  );
  const blueprintQuizConfigs = lectureSections.flatMap((section) => {
    const quiz = outlines.find((outline) => outline.id === section.quizOutlineId);
    return quiz?.quizConfig && typeof quiz.quizConfig === "object"
      ? [quiz.quizConfig as { questionCount?: number; questionTypes?: string[]; minShortAnswerQuestions?: number; maxShortAnswerQuestions?: number }]
      : [];
  });
  const blueprintCourseAssessmentValid = !blueprintMode
    || (blueprintQuizConfigs.length === lectureSections.length
      && (blueprintMode === "constructed-response"
        ? blueprintQuizConfigs.every((config) => (config.questionTypes ?? []).length === 1
          && config.questionTypes?.[0] === "short_answer"
          && config.minShortAnswerQuestions === config.questionCount
          && config.maxShortAnswerQuestions === config.questionCount)
        : blueprintQuizConfigs.every((config) => (config.minShortAnswerQuestions ?? 0) >= 1
          && (config.maxShortAnswerQuestions ?? 0) >= (config.minShortAnswerQuestions ?? 0)
          && (config.maxShortAnswerQuestions ?? 0) <= (config.questionCount ?? 0))));
  const hasSectionChecks = lectureSections.length > 0 && lectureSections.every((section) => {
    const quiz = outlines.find((outline) => outline.id === section.quizOutlineId);
    const quizConfig = quiz?.quizConfig as { questionCount?: number; questionTypes?: string[]; minShortAnswerQuestions?: number; maxShortAnswerQuestions?: number } | undefined;
    const questionTypes = quizConfig?.questionTypes ?? [];
    const blueprintCheck = blueprintMode
      ? (quizConfig?.questionCount ?? 0) >= 1
        && questionTypes.length > 0
        && (blueprintMode === "constructed-response"
          ? (quizConfig?.questionCount ?? 0) <= 2
            && questionTypes.every((type) => type === "short_answer")
          : (quizConfig?.questionCount ?? 0) <= 3
            && questionTypes.every((type) => ["single", "multiple", "matching", "true_false", "short_answer"].includes(type))
            && (quizConfig?.minShortAnswerQuestions ?? 0) >= 1
            && (quizConfig?.maxShortAnswerQuestions ?? 0) >= (quizConfig?.minShortAnswerQuestions ?? 0)
            && (quizConfig?.maxShortAnswerQuestions ?? 0) <= (quizConfig?.questionCount ?? 0))
      : (quizConfig?.questionCount ?? 0) >= 2
        && (quizConfig?.questionCount ?? 0) <= 3
        && questionTypes.every((type) => type === "short_answer");
    return section.sceneOutlineIds.length > 0
      && quiz?.type === "quiz"
      && blueprintCheck;
  }) && blueprintCourseAssessmentValid;

  return [
    ...(course.content.classroomGenerationRun ? [{
      id: "full-classroom-generation",
      label: "完整课程生成",
      ok: course.content.classroomGenerationRun.scope === "full-course"
        && course.content.classroomGenerationRun.status === "completed",
      message: course.content.classroomGenerationRun.scope === "test-lesson"
        ? "当前是正式链路生成的单节测试样本；确认效果后，请返回生成完整课程再发布。"
        : "完整课程仍在生成，请等待全部课堂页面保存完成。",
    }] : []),
    ...((course.content.qualityReviewRequired || Number(course.content.resourcePackage?.schemaVersion ?? 0) >= 2 || Number(course.content.stagePlan?.schemaVersion ?? 0) >= 2) ? [{
      id: "teacher-review",
      label: "教师终审",
      ok: Boolean(course.content.teacherReview?.signature
        && course.content.teacherReview.classroomId === (course.aiLearningClassroomId || course.content._openmaicClassroomId)),
      message: "请在预览发布页面确认当前版本可以授课。",
    }] : []),
    {
      id: "basics",
      label: "课程基本信息",
      ok: Boolean(course.name.trim() && course.subject.trim() && course.grade.trim() && course.hours > 0),
      message: "课程名称、学科、年级和课时需要完整。",
    },
    {
      id: "stages",
      label: "五阶段课堂流程",
      ok: sameStageKeys(course.stages.map((stage) => stage.key)),
      message: "新版课堂必须依次包含项目启动、知识讲授、项目实践、成果汇报与评价、学习反思。",
    },
    {
      id: "timing",
      label: course.content.stagePlan ? "知识讲授时长（教案预算）" : "知识讲授时长（整课 20%–40%）",
      ok: isNewSystemAiTimingPlan(timing, course.hours, course.content.stagePlan)
        && (!lectureSections.length || hasExactKnowledgeLecturePageBudget(outlines, timing!.totalMinutes))
        && blueprintTimingAuditValid,
      message: course.content.stagePlan
        ? "页面规划须采用教师确认的教案时长，讲解、例证、互动和小测的计划时长合计须等于该预算；开启语音后还须完成全部讲授音频及其时长记录。实际语速造成的时长偏差供教师评估，不要求自动改稿。"
        : `知识讲授计划须占总课时的 20%–40%（${Math.ceil(course.hours * 60 * 0.2)}–${Math.floor(course.hours * 60 * 0.4)} 分钟），按确认预算分配页面；开启语音后须完成全部讲授音频及其时长记录。实际时长偏差供教师评估。`,
    },
    {
      id: "ai-outline",
      label: "知识讲授内容",
      // Existing published courses predate the section manifest and must stay
      // teachable; every newly generated course writes the manifest and is
      // held to the stricter section-check contract above.
      ok: aiOnlyOutlines && (!lectureSections.length || hasSectionChecks),
      message: "需要生成至少一个包含讲授页面与节末小测的知识讲授小节。",
    },
    {
      id: "ai-classroom",
      label: "知识讲授课堂",
      ok: Boolean(course.aiLearningClassroomId ?? course.content._openmaicClassroomId),
      message: "知识讲授课堂尚未生成完成。",
    },
  ];
}

export function isNewSystemCourseReady(course: Course): boolean {
  return getNewSystemCourseReadiness(course).every((check) => check.ok);
}
