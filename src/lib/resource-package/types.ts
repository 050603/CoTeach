/** Shared, browser-safe contract for the external teaching resource package. */
export const RESOURCE_PACKAGE_STAGE_KEYS = ["launch", "ai-learning", "make", "showcase", "reflection"] as const;
export type ResourcePackageStageKey = typeof RESOURCE_PACKAGE_STAGE_KEYS[number];
export const RESOURCE_PACKAGE_STAGE_LABELS: Record<ResourcePackageStageKey, string> = {
  launch: "项目启动", "ai-learning": "知识讲授", make: "项目实践", showcase: "成果展示", reflection: "反思评价",
};
export type ResourcePackageRole = "knowledge" | "lessonPlan" | "launchPresentation";
export type ResourcePackageFile = { id: string; fileName: string; url: string; sha256?: string };
export type ResourcePackageSource = { documentRole: ResourcePackageRole; locator: string; quote: string; archivePath?: string };
export type ResourcePackageEvaluationRubric = {
  id: string; version: number; dimensions: { id: string; name: string; weight: number; description: string }[];
  sourceWeights: { teacher: number; ai: number }; confirmedAt?: string;
};
export type ResourcePackageReflectionQuestionSet = { id: string; version: number; questions: { id: string; prompt: string; required: boolean }[] };
export type ResourcePackageDeliverable = { id: string; name: string; format: string; requirements: string; required: boolean };
export type ResourcePackageConflict = { id: string; kind: "organization" | "evaluation" | "presentation"; summary: string; reason: string; suggestion: string; evidence: ResourcePackageSource[] };
export type ResourcePackageStage = {
  key: ResourcePackageStageKey;
  title: string;
  durationMin: number | null;
  requirements: string;
  outputs: string;
  teacherActions: string;
  aiActions: string;
  checkpoints?: string[];
  observationPoints?: string[];
};
export type ResourcePackageKnowledge = { id?: string; name: string; description: string; subPoints: string[]; source?: ResourcePackageSource;
  children?: { id: string; name: string; description: string; source?: ResourcePackageSource }[] };
export type ResourcePackageDraft = {
  courseName: string;
  subject: string;
  grade: string;
  drivingQuestion: string;
  learningObjectives: string[];
  expectedOutcome: string;
  learnerContext: string;
  lessonCount: number | null;
  minutesPerLesson: number | null;
  totalMinutes: number | null;
  knowledgePoints: ResourcePackageKnowledge[];
  stages: ResourcePackageStage[];
  evaluationCriteria: string;
  reflectionQuestions: string[];
  parsingVersion?: 2;
  evaluationRubric?: ResourcePackageEvaluationRubric;
  reflectionQuestionSet?: ResourcePackageReflectionQuestionSet;
  finalDeliverables?: ResourcePackageDeliverable[];
  sourceEvidence?: Record<string, ResourcePackageSource[]>;
  originalEvaluationSources?: string;
};
/** Teacher-only authoring metadata. Never send this field in student snapshots. */
export type CourseResourcePackage = {
  schemaVersion: 1 | 2;
  id: string;
  revision: number;
  source: ResourcePackageFile;
  documents: Partial<Record<ResourcePackageRole, ResourcePackageFile>>;
  draft: ResourcePackageDraft;
  launchResourceId?: string;
  confirmedAt?: string;
  conflicts?: ResourcePackageConflict[];
  conflictVersion?: string;
  adaptation?: { sourceRevision: number; conflictVersion: string; authorizedBy: string; authorizedAt: string; draftSignature: string; changes: string[] };
  classroomPresentation?: ResourcePackageFile;
};
/** Teaching requirements safe to project into a student's classroom. */
export type CourseStagePlan = {
  schemaVersion: 1 | 2;
  source: "resource-package";
  totalMinutes: number;
  lessonCount: number | null;
  minutesPerLesson: number | null;
  stages: ResourcePackageStage[];
  evaluationCriteria: string;
  reflectionQuestions: string[];
  evaluationRubric?: ResourcePackageEvaluationRubric;
  reflectionQuestionSet?: ResourcePackageReflectionQuestionSet;
  finalDeliverables?: ResourcePackageDeliverable[];
};
export type ResourcePackageJobSnapshot = {
  id: string;
  status: string;
  message: string;
  error?: string | null;
  progress: number;
  candidates?: Partial<Record<ResourcePackageRole, string[]>>;
  package?: CourseResourcePackage | null;
};

export function emptyResourcePackageDraft(): ResourcePackageDraft {
  return {
    courseName: "", subject: "", grade: "", drivingQuestion: "", learningObjectives: [],
    expectedOutcome: "", learnerContext: "", lessonCount: null, minutesPerLesson: null, totalMinutes: null,
    knowledgePoints: [], stages: RESOURCE_PACKAGE_STAGE_KEYS.map((key) => ({ key, title: RESOURCE_PACKAGE_STAGE_LABELS[key],
      durationMin: null, requirements: "", outputs: "", teacherActions: "", aiActions: "" })),
    evaluationCriteria: "", reflectionQuestions: [],
  };
}

export function resourcePackageDraftErrors(draft: ResourcePackageDraft): string[] {
  const errors: string[] = [];
  if (!draft.courseName.trim()) errors.push("请补充课程名称。");
  if (!draft.grade.trim()) errors.push("请补充教学对象 / 学段。");
  if (!draft.drivingQuestion.trim()) errors.push("请补充项目学习驱动问题。");
  if (!draft.learningObjectives.some((item) => item.trim())) errors.push("请补充学习目标。");
  if (!draft.expectedOutcome.trim()) errors.push("请补充项目成果要求。");
  if (!draft.knowledgePoints.length || draft.knowledgePoints.some((item) => !item.name.trim())) errors.push("请补充课程必须覆盖的知识点。");
  if (draft.parsingVersion === 2) {
    for (const stage of draft.stages) {
      if (!stage.requirements.trim()) errors.push(`请补充${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}的任务与教学活动。`);
      if (!stage.outputs.trim()) errors.push(`请补充${RESOURCE_PACKAGE_STAGE_LABELS[stage.key]}的阶段产出。`);
    }
    if (!draft.finalDeliverables?.length) errors.push("请补充项目最终交付物。");
    if (!draft.evaluationRubric?.dimensions.length) errors.push("请补充课程评价维度及权重。");
    if (!draft.reflectionQuestionSet?.questions.length) errors.push("请补充课程反思题。");
  }
  if (draft.finalDeliverables?.some((item) => !item.name.trim() || !item.requirements.trim() || !item.format.trim())) errors.push("请填写每项最终交付物的名称、格式与具体要求。");
  if (draft.reflectionQuestionSet?.questions.some((item) => !item.id.trim() || !item.prompt.trim())) errors.push("请补充完整的反思题目。");
  if (draft.reflectionQuestionSet && new Set(draft.reflectionQuestionSet.questions.map((item) => item.id)).size !== draft.reflectionQuestionSet.questions.length) errors.push("反思题标识重复，请重新添加重复题目。");
  if (draft.evaluationRubric && new Set(draft.evaluationRubric.dimensions.map((item) => item.id)).size !== draft.evaluationRubric.dimensions.length) errors.push("评价维度标识重复，请重新添加重复维度。");
  if (draft.evaluationRubric) {
    const rubric = draft.evaluationRubric;
    if (rubric.dimensions.some((item) => !item.name.trim() || !Number.isFinite(item.weight) || item.weight <= 0)
      || Math.abs(rubric.dimensions.reduce((sum, item) => sum + item.weight, 0) - 100) > 0.01) errors.push("评价维度权重之和必须为100%。");
    if ([rubric.sourceWeights.teacher, rubric.sourceWeights.ai].some((weight) => !Number.isFinite(weight) || weight < 0)
      || Math.abs(rubric.sourceWeights.teacher + rubric.sourceWeights.ai - 100) > 0.01) errors.push("教师和AI评价来源权重之和必须为100%。");
  }
  if (!Number.isInteger(draft.totalMinutes) || (draft.totalMinutes ?? 0) <= 0) errors.push("请填写有效的课程总分钟数。");
  if (draft.stages.length !== 5 || RESOURCE_PACKAGE_STAGE_KEYS.some((key) => draft.stages.filter((stage) => stage.key === key).length !== 1)) {
    errors.push("教案必须包含完整的五阶段安排。");
  }
  if (draft.stages.some((stage) => !Number.isInteger(stage.durationMin) || (stage.durationMin ?? 0) <= 0)) {
    errors.push("请填写五个阶段的正整数分钟数。");
  } else if (draft.stages.reduce((sum, stage) => sum + (stage.durationMin ?? 0), 0) !== draft.totalMinutes) {
    errors.push("五阶段时长之和必须等于课程总分钟数，请修正教案时间。");
  }
  if (draft.lessonCount !== null && (!Number.isInteger(draft.lessonCount) || draft.lessonCount <= 0)) errors.push("课次数必须为正整数。");
  if (draft.minutesPerLesson !== null && (!Number.isInteger(draft.minutesPerLesson) || draft.minutesPerLesson <= 0)) errors.push("每课次分钟数必须为正整数。");
  if (draft.lessonCount && draft.minutesPerLesson && draft.lessonCount * draft.minutesPerLesson !== draft.totalMinutes) errors.push("课次数乘以每课次分钟数必须等于课程总分钟数。");
  return errors;
}

export function stagePlanFromResourcePackage(draft: ResourcePackageDraft): CourseStagePlan {
  const errors = resourcePackageDraftErrors(draft);
  if (errors.length) throw new Error(errors.join("\n"));
  return { schemaVersion: draft.parsingVersion === 2 ? 2 : 1, source: "resource-package", totalMinutes: draft.totalMinutes!,
    lessonCount: draft.lessonCount, minutesPerLesson: draft.minutesPerLesson,
    stages: draft.stages.map((stage) => draft.parsingVersion === 2 ? { ...stage } : ({ ...stage,
      requirements: adaptPersonalProjectText(stage.requirements), outputs: adaptPersonalProjectText(stage.outputs),
      teacherActions: adaptPersonalProjectText(stage.teacherActions), aiActions: adaptPersonalProjectText(stage.aiActions),
    })), evaluationCriteria: draft.parsingVersion === 2 ? draft.evaluationCriteria : adaptPersonalProjectText(draft.evaluationCriteria),
    reflectionQuestions: draft.reflectionQuestionSet?.questions.map((question) => question.prompt) ?? draft.reflectionQuestions.map(adaptPersonalProjectText),
    evaluationRubric: draft.evaluationRubric, reflectionQuestionSet: draft.reflectionQuestionSet, finalDeliverables: draft.finalDeliverables };
}

/** Upstream sample group logistics are never instructions to create real teams. */
export function adaptPersonalProjectText(text: string): string {
  return text
    .replace(/(?:将(?:全班|学生))?分成\s*[\d一二三四五六七八九十]+\s*(?:个)?(?:小)?组/g, '每位学生建立个人 AI 协作空间')
    .replace(/(?:建议)?每组(?:约)?\s*[\d一二三四五六七八九十]+(?:\s*[-—～~至]\s*[\d一二三四五六七八九十]+)?\s*(?:名)?(?:学生|人)|[\d一二三四五六七八九十]+(?:\s*[-—～~至]\s*[\d一二三四五六七八九十]+)?\s*人一组/g, '每位学生与自己的 AI 伙伴协作')
    .replace(/共\s*\d+\s*组/g, '每人一个 AI 协作空间')
    .replace(/(?:每组必须)?全员上台(?:或指定代表配合讲解)?/g, '学生独立展示并说明 AI 协作过程')
    .replace(/记录组员姓名及联系方式/g, '明确个人任务与 AI 伙伴职责')
    .replace(/组建小组|小组组建|完成分组/g, '建立个人 AI 协作空间')
    .replace(/分组过程中的冷场或冲突/g, '个人任务理解与 AI 协作中的困难')
    .replace(/小组共同讨论|小组内部讨论|小组讨论|分组讨论/g, '学生与 AI 伙伴讨论，由学生作出决定')
    .replace(/其他组/g, '其他学生').replace(/各小组|每个小组|各组|每组|全组/g, '每位学生')
    .replace(/(AI\s*虚拟小组)|本组|小组/g, (_match, preserved: string | undefined) => preserved ?? '个人与 AI 伙伴')
    .replace(/组员姓名|组员/g, 'AI 伙伴');
}
