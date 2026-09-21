import { Prisma } from "@prisma/client";
import { after } from "next/server";
import { z } from "zod";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import {
  getPblTemplatePublicationState,
  loadPblTemplateCourse,
} from "@/lib/platform/pbl-template-repository";
import { updateCourse } from "@/lib/session/server-store";
import type {
  Course,
  CourseDesignWorkspaceSectionKey,
  KnowledgeGraph,
  KnowledgePoint,
  KnowledgeScopePlan,
  TeachingBlueprint,
} from "@/lib/session/types";
import type { CourseStagePlan } from "@/lib/resource-package/types";
import type { PblModuleTimingPlan } from "@/lib/pbl-time-model";
import {
  COURSE_DESIGN_WORKSPACE_SECTIONS,
  courseDesignWorkspaceStatuses,
  mergeCourseDesignClassroomScenes,
  recordCourseDesignEdit,
  resolveCourseDesignUpdate,
} from "@/lib/course-design/workspace";
import {
  teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget,
} from "@/lib/course-design/teaching-blueprint";
import { ZH_CN_COURSE_LANGUAGE_DIRECTIVE } from "@/lib/openmaic/generation/course-language";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import { buildNewSystemAiTeachingOutline } from "@/lib/classroom/new-system-course";
import { contentGenerationJobs, designGenerationJobs } from "@/lib/course-generation/job-storage";
import {
  estimatePersistedCourseGenerationSeconds,
  resetCourseGenerationCheckpoints,
  runQueuedCourseGenerationToCompletion,
  type PersistedCourseGenerationRequest,
} from "@/lib/course-generation/job-runner";
import { isBackgroundCourseGenerationEnabled } from "@/lib/course-generation/capability";
import {
  readClassroom,
  updatePersistedClassroomForEditing,
} from "@/lib/openmaic/server/classroom-storage";
import { collectGeneratedTeacherReviewItems, teacherReviewSummary } from "@/lib/course-generation/teacher-review-items";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { summarizeTeachingTimingAudit } from "@/lib/openmaic/server/classroom-asset-generation";
import {
  buildCourseTeachingConstraints,
  buildPblCourseRequirement,
} from "@/lib/openmaic/pbl/course-request";
import { buildCourseTeachingRequirements } from "@/lib/course-design/teaching-requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ courseId: string }> };

const sectionKeySchema = z.enum(["materials", "stage-plan", "knowledge", "timing", "blueprint", "classroom"]);
const saveSchema = z.object({
  action: z.literal("save"),
  section: sectionKeySchema,
  expectedVersion: z.number().int().positive(),
  data: z.unknown(),
}).strict();
const confirmSchema = z.object({
  action: z.literal("confirm-current"),
  target: sectionKeySchema,
  expectedVersion: z.number().int().positive(),
}).strict();
const generateCandidateSchema = z.object({
  action: z.literal("generate-classroom-candidate"),
  expectedVersion: z.number().int().positive(),
  sectionIds: z.array(z.string().min(1).max(200)).min(1).max(50),
}).strict();
const candidateDecisionSchema = z.object({
  action: z.enum(["adopt-classroom-candidate", "discard-classroom-candidate"]),
  expectedVersion: z.number().int().positive(),
  candidateId: z.string().min(1).max(300),
}).strict();
const requestSchema = z.union([saveSchema, confirmSchema, generateCandidateSchema, candidateDecisionSchema]);

const materialsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(100),
  grade: z.string().trim().min(1).max(100),
  hours: z.number().positive().max(100),
  summary: z.string().trim().max(4_000),
  drivingQuestion: z.string().trim().max(2_000),
  expectedOutcome: z.string().trim().max(4_000),
  learningObjectives: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  learnerProfile: z.object({
    priorKnowledge: z.string().trim().max(2_000).optional(),
    learningNeeds: z.string().trim().max(2_000).optional(),
    familiarContexts: z.string().trim().max(2_000).optional(),
  }).strict().optional(),
}).strict();

class WorkspaceInputError extends Error {
  constructor(message: string, readonly code = "INVALID_DESIGN_WORKSPACE_INPUT", readonly status = 400) {
    super(message);
  }
}

function stagePlanFrom(value: unknown): CourseStagePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceInputError("五阶段教学安排格式无效。");
  const plan = structuredClone(value) as CourseStagePlan;
  const required = ["launch", "ai-learning", "make", "showcase", "reflection"];
  if (!Array.isArray(plan.stages) || plan.stages.length !== 5
    || required.some((key) => plan.stages.filter((stage) => stage.key === key).length !== 1)) {
    throw new WorkspaceInputError("教学安排必须完整包含项目启动、知识讲授、项目实践、成果展示和反思评价五个阶段。");
  }
  if (!Number.isInteger(plan.totalMinutes) || plan.totalMinutes <= 0
    || plan.stages.some((stage) => !Number.isInteger(stage.durationMin) || (stage.durationMin ?? 0) <= 0)
    || plan.stages.reduce((sum, stage) => sum + (stage.durationMin ?? 0), 0) !== plan.totalMinutes) {
    throw new WorkspaceInputError("五阶段时长必须为正整数，且合计等于课程总时长。");
  }
  for (const stage of plan.stages) {
    for (const field of ["title", "requirements", "outputs", "teacherActions", "aiActions"] as const) {
      if (typeof stage[field] !== "string" || !stage[field].trim()) throw new WorkspaceInputError(`请补充“${stage.title || stage.key}”的${field}。`);
    }
  }
  if (plan.evaluationRubric) {
    const dimensions = plan.evaluationRubric.dimensions;
    if (!dimensions.length || dimensions.some((item) => !item.id?.trim() || !item.name?.trim() || !Number.isFinite(item.weight) || item.weight <= 0)
      || new Set(dimensions.map((item) => item.id)).size !== dimensions.length
      || Math.abs(dimensions.reduce((sum, item) => sum + item.weight, 0) - 100) > 0.01) {
      throw new WorkspaceInputError("评价量规需要完整且不重复的维度，维度权重合计必须为 100%。");
    }
    const sourceWeight = plan.evaluationRubric.sourceWeights;
    if (!Number.isFinite(sourceWeight.teacher) || !Number.isFinite(sourceWeight.ai)
      || sourceWeight.teacher < 0 || sourceWeight.ai < 0
      || Math.abs(sourceWeight.teacher + sourceWeight.ai - 100) > 0.01) {
      throw new WorkspaceInputError("教师与 AI 的评价来源权重合计必须为 100%。");
    }
  }
  if (plan.reflectionQuestionSet) {
    const questions = plan.reflectionQuestionSet.questions;
    if (questions.some((item) => !item.id?.trim() || !item.prompt?.trim())
      || new Set(questions.map((item) => item.id)).size !== questions.length) {
      throw new WorkspaceInputError("反思题需要完整且不重复的题目标识和题目内容。");
    }
  }
  return plan;
}

function knowledgeFrom(value: unknown): { knowledgePoints: KnowledgePoint[]; knowledgeGraph: KnowledgeGraph; knowledgeScopePlan?: KnowledgeScopePlan } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceInputError("知识结构格式无效。");
  const data = structuredClone(value) as { knowledgePoints?: KnowledgePoint[]; knowledgeGraph?: KnowledgeGraph; knowledgeScopePlan?: KnowledgeScopePlan };
  if (!Array.isArray(data.knowledgePoints) || !data.knowledgePoints.length
    || data.knowledgePoints.some((point) => !point.id?.trim() || !point.name?.trim() || !point.description?.trim())) {
    throw new WorkspaceInputError("每个知识点都需要名称和说明。");
  }
  if (new Set(data.knowledgePoints.map((point) => point.id)).size !== data.knowledgePoints.length) {
    throw new WorkspaceInputError("知识点标识重复，请刷新后重试。");
  }
  if (!data.knowledgeGraph || !Array.isArray(data.knowledgeGraph.nodes) || !Array.isArray(data.knowledgeGraph.edges)) {
    throw new WorkspaceInputError("知识图谱节点或关系缺失。");
  }
  const nodeIds = new Set(data.knowledgeGraph.nodes.map((node) => node.id));
  if (data.knowledgePoints.some((point) => !nodeIds.has(point.id))
    || data.knowledgeGraph.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new WorkspaceInputError("知识图谱必须覆盖全部课程知识点，且关系两端必须指向已有节点。");
  }
  return {
    knowledgePoints: data.knowledgePoints,
    knowledgeGraph: { ...data.knowledgeGraph, semanticReview: undefined },
    knowledgeScopePlan: data.knowledgeScopePlan,
  };
}

function timingFrom(value: unknown, course: Course): PblModuleTimingPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceInputError("讲授时间规划格式无效。");
  const plan = structuredClone(value) as PblModuleTimingPlan;
  if (!Number.isFinite(plan.totalMinutes) || plan.totalMinutes <= 0 || !Array.isArray(plan.allocations) || !plan.allocations.length) {
    throw new WorkspaceInputError("请至少保留一个有效的知识簇时间分配。");
  }
  const knownIds = new Set(course.content.knowledgePoints.map((point) => point.id));
  if (plan.allocations.some((item) => !item.id?.trim() || !Number.isFinite(item.durationMin) || item.durationMin <= 0
    || (item.knowledgePointIds ?? []).some((id) => !knownIds.has(id)))) {
    throw new WorkspaceInputError("时间分配包含无效时长或不存在的知识点。");
  }
  const allocated = plan.allocations.reduce((sum, item) => sum + item.durationMin, 0);
  if (Math.abs(allocated - plan.totalMinutes) > 0.001) throw new WorkspaceInputError("知识簇时长合计必须等于知识讲授总时长。");
  const stageBudget = course.content.stagePlan?.stages.find((stage) => stage.key === "ai-learning")?.durationMin;
  if (stageBudget && Math.abs(stageBudget - plan.totalMinutes) > 0.001) {
    throw new WorkspaceInputError(`知识讲授总时长必须等于五阶段教案中的 ${stageBudget} 分钟。`);
  }
  return { ...plan, status: "confirmed", recommendationSource: "teacher", confirmedAt: new Date().toISOString() };
}

function blueprintFrom(value: unknown, course: Course): { blueprint: TeachingBlueprint; outlines: ReturnType<typeof teachingBlueprintToOutlines> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceInputError("教学蓝图格式无效。");
  const blueprint = structuredClone(value) as TeachingBlueprint;
  if (![1, 2, 3].includes(blueprint.schemaVersion) || !Array.isArray(blueprint.sections) || !blueprint.sections.length) {
    throw new WorkspaceInputError("教学蓝图至少需要一个知识小节。");
  }
  const knownPointIds = new Set(course.content.knowledgePoints.map((point) => point.id));
  for (const section of blueprint.sections) {
    const unitIds = new Set(section.units.map((unit) => unit.id));
    const referencedKnowledge = [
      ...section.knowledgePointIds,
      ...section.units.flatMap((unit) => unit.knowledgePointIds),
      ...section.pages.flatMap((page) => page.knowledgePointIds),
    ];
    if (referencedKnowledge.some((id) => !knownPointIds.has(id))) {
      throw new WorkspaceInputError(`小节“${section.title}”引用了已经移除的知识点，请重新关联后保存。`);
    }
    if (section.pages.some((page) => page.unitIds.some((id) => !unitIds.has(id)))) {
      throw new WorkspaceInputError(`小节“${section.title}”的页面引用了不存在的讲授单元。`);
    }
  }
  const outlines = teachingBlueprintToOutlines(blueprint, ZH_CN_COURSE_LANGUAGE_DIRECTIVE);
  const issues = validateTeachingBlueprintBudget(blueprint, outlines);
  if (issues.length) throw new WorkspaceInputError(issues.slice(0, 5).join("；"));
  return { blueprint, outlines };
}

function syncResourcePackage(course: Course, patch: Partial<{
  materials: z.infer<typeof materialsSchema>;
  stagePlan: CourseStagePlan;
}>): Course["content"]["resourcePackage"] {
  const current = course.content.resourcePackage;
  if (!current) return undefined;
  const draft = { ...current.draft };
  if (patch.materials) Object.assign(draft, {
    courseName: patch.materials.name,
    subject: patch.materials.subject,
    grade: patch.materials.grade,
    drivingQuestion: patch.materials.drivingQuestion,
    learningObjectives: patch.materials.learningObjectives,
    expectedOutcome: patch.materials.expectedOutcome,
    learnerContext: [patch.materials.learnerProfile?.priorKnowledge, patch.materials.learnerProfile?.learningNeeds, patch.materials.learnerProfile?.familiarContexts].filter(Boolean).join("；"),
    totalMinutes: Math.round(patch.materials.hours * 60),
  });
  if (patch.stagePlan) Object.assign(draft, {
    totalMinutes: patch.stagePlan.totalMinutes,
    lessonCount: patch.stagePlan.lessonCount,
    minutesPerLesson: patch.stagePlan.minutesPerLesson,
    stages: patch.stagePlan.stages,
    evaluationCriteria: patch.stagePlan.evaluationCriteria,
    reflectionQuestions: patch.stagePlan.reflectionQuestions,
    evaluationRubric: patch.stagePlan.evaluationRubric,
    reflectionQuestionSet: patch.stagePlan.reflectionQuestionSet,
    finalDeliverables: patch.stagePlan.finalDeliverables,
    aiUsagePolicy: patch.stagePlan.aiUsagePolicy,
  });
  return { ...current, draft, revision: current.revision + 1, confirmedAt: new Date().toISOString() };
}

function invalidateReview(course: Course): Course {
  return {
    ...course,
    status: "preparing",
    content: {
      ...course.content,
      teacherReview: undefined,
      renderReview: undefined,
      qualityReview: undefined,
    },
  };
}

function applySectionSave(course: Course, section: CourseDesignWorkspaceSectionKey, value: unknown): Course {
  let next = invalidateReview(course);
  let changedKnowledgePointIds: string[] = [];
  let impactTargets: CourseDesignWorkspaceSectionKey[] | undefined;
  if (section === "materials") {
    const data = materialsSchema.parse(value);
    next = {
      ...next,
      ...data,
      content: { ...next.content, resourcePackage: syncResourcePackage(course, { materials: data }) },
    };
  } else if (section === "stage-plan") {
    const stagePlan = stagePlanFrom(value);
    const previousKnowledgeStage = course.content.stagePlan?.stages.find((stage) => stage.key === "ai-learning");
    const nextKnowledgeStage = stagePlan.stages.find((stage) => stage.key === "ai-learning");
    const knowledgeGenerationInputChanged = course.content.stagePlan?.totalMinutes !== stagePlan.totalMinutes
      || JSON.stringify(previousKnowledgeStage) !== JSON.stringify(nextKnowledgeStage);
    impactTargets = knowledgeGenerationInputChanged ? undefined : [];
    next = {
      ...next,
      hours: stagePlan.totalMinutes / 60,
      content: {
        ...next.content,
        stagePlan,
        resourcePackage: syncResourcePackage(course, { stagePlan }),
      },
    };
  } else if (section === "knowledge") {
    const data = knowledgeFrom(value);
    const previous = new Map(course.content.knowledgePoints.map((point) => [point.id, JSON.stringify(point)]));
    changedKnowledgePointIds = data.knowledgePoints.filter((point) => previous.get(point.id) !== JSON.stringify(point)).map((point) => point.id);
    for (const point of course.content.knowledgePoints) if (!data.knowledgePoints.some((item) => item.id === point.id)) changedKnowledgePointIds.push(point.id);
    next = { ...next, content: { ...next.content, ...data } };
  } else if (section === "timing") {
    const moduleTimingPlan = timingFrom(value, next);
    next = {
      ...next,
      content: {
        ...next.content,
        moduleTimingPlan,
        teachingOutline: buildNewSystemAiTeachingOutline(moduleTimingPlan, next.content.knowledgePoints),
      },
    };
  } else if (section === "blueprint") {
    const { blueprint, outlines } = blueprintFrom(value, next);
    next = {
      ...next,
      content: {
        ...next.content,
        teachingBlueprint: blueprint,
        _openmaicSceneOutlines: outlines,
        _openmaicScenesCount: outlines.length,
        lessonOutline: outlines.map((outline) => ({
          id: outline.id,
          stageKey: outline.stageKey ?? "ai-learning",
          title: outline.title,
          objectives: outline.teachingObjective ? [outline.teachingObjective] : [],
          activities: outline.keyPoints ?? [],
          durationMin: Math.max(1, Math.round((outline.targetDurationSec ?? outline.estimatedDuration ?? 60) / 60)),
          parentActivityId: outline.parentActivityId,
          knowledgePointIds: outline.knowledgePointIds,
          resourceTypes: outline.resourceTypes,
          targetDurationSec: outline.targetDurationSec,
        })),
        knowledgeLectureSections: deriveKnowledgeLectureSectionsFromOutlines(outlines),
      },
    };
  } else {
    throw new WorkspaceInputError("课堂内容请在课堂编辑器中修改。", "CLASSROOM_EDITOR_REQUIRED", 409);
  }
  if (section === "materials" || section === "stage-plan") {
    const teacherBrief = course.content.teachingRequirements?.items
      .filter((item) => item.kind === "teacher-directive")
      .map((item) => item.text).join("\n") ?? "";
    next.content.teachingRequirements = buildCourseTeachingRequirements({
      resourcePackage: next.content.resourcePackage,
      teacherBrief,
    });
  }
  next.content.designWorkspaceRevision = recordCourseDesignEdit(next, section, {
    changedKnowledgePointIds,
    impactTargets,
  });
  return next;
}

function jobSummary(job: { status: string; step: string; message: string; progress: number; error?: string | null } | null) {
  return job ? { status: job.status, step: job.step, message: job.message, progress: job.progress, error: job.error ?? null } : null;
}

async function responsePayload(course: Course) {
  const [designJob, contentJob, publication] = await Promise.all([
    designGenerationJobs.findUnique({ where: { courseId: course.id }, select: { status: true, step: true, message: true, progress: true, error: true } }),
    contentGenerationJobs.findUnique({ where: { courseId: course.id }, select: { status: true, step: true, message: true, progress: true, error: true } }),
    getPblTemplatePublicationState(course.id),
  ]);
  return {
    course,
    sections: COURSE_DESIGN_WORKSPACE_SECTIONS,
    statuses: courseDesignWorkspaceStatuses(course),
    pendingUpdates: course.content.designWorkspaceRevision?.pendingUpdates ?? [],
    publication,
    jobs: { design: jobSummary(designJob), classroom: jobSummary(contentJob) },
  };
}

function assertExpectedVersion(course: Course, expectedVersion: number | undefined) {
  if (expectedVersion !== undefined && course.version !== expectedVersion) {
    throw new WorkspaceInputError("课程已在其他页面更新，请刷新后再操作。", "VERSION_CONFLICT", 409);
  }
}

async function queueClassroomCandidate(
  course: Course,
  sectionIds: string[],
): Promise<void> {
  const revision = course.content.designWorkspaceRevision;
  const baseClassroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!revision || !baseClassroomId) {
    throw new WorkspaceInputError("课程尚未生成完整课堂，请先完成一次课程生成。", "FULL_GENERATION_REQUIRED", 409);
  }
  const fullOutlines = course.content._openmaicSceneOutlines ?? [];
  const sectionIdSet = new Set(sectionIds);
  const affected = fullOutlines.filter((outline) => outline.lectureSectionId && sectionIdSet.has(outline.lectureSectionId));
  if (!affected.length || sectionIds.some((id) => !affected.some((outline) => outline.lectureSectionId === id))) {
    throw new WorkspaceInputError("选择的知识小节不存在，请刷新后重试。", "INVALID_UPDATE_TARGET", 400);
  }
  const job = await contentGenerationJobs.findUnique({ where: { courseId: course.id } });
  if (!job) throw new WorkspaceInputError("没有找到正式课程生成配置，请先重新生成整门课程。", "FULL_GENERATION_REQUIRED", 409);
  if (["queued", "running", "cancelling"].includes(job.status)) {
    throw new WorkspaceInputError("课程内容正在生成，请等待当前任务结束。", "GENERATION_BUSY", 409);
  }
  const previous = job.request as unknown as PersistedCourseGenerationRequest;
  if (!previous.requirement || !previous.generationModelString) {
    throw new WorkspaceInputError("历史生成配置不完整，请重新生成整门课程。", "FULL_GENERATION_REQUIRED", 409);
  }
  const request: PersistedCourseGenerationRequest = {
    ...previous,
    courseId: course.id,
    courseTitle: course.name,
    requirement: buildPblCourseRequirement(course, course.content, affected as SceneOutline[]),
    teachingConstraints: buildCourseTeachingConstraints(course, course.content),
    generationScope: "full-course",
    fullSceneCount: fullOutlines.length,
    testLesson: undefined,
    sceneOutlines: affected as SceneOutline[],
    knowledgePoints: course.content.knowledgePoints,
    moduleTimingPlan: course.content.moduleTimingPlan,
    updateTarget: {
      baseDesignRevision: revision.revision,
      baseClassroomId,
      affectedSectionIds: sectionIds,
      affectedOutlineIds: affected.map((outline) => outline.id),
    },
  };
  await resetCourseGenerationCheckpoints(job.id);
  const estimate = estimatePersistedCourseGenerationSeconds({
    totalScenes: affected.length,
    adaptiveBranchCount: 0,
    enableImageGeneration: request.enableImageGeneration,
    enableVideoGeneration: request.enableVideoGeneration,
    enableTTS: request.enableTTS,
  });
  try {
    await contentGenerationJobs.update({
      where: { id: job.id, version: job.version, status: job.status },
      data: {
      status: "queued",
      step: "queued",
      progress: 0,
      message: `等待更新 ${sectionIds.length} 个知识小节`,
      scenesGenerated: 0,
      totalScenes: affected.length,
      estimatedRemainingSeconds: estimate,
      tokenUsage: 0,
      tokenUsageCalls: 0,
      request: request as unknown as Prisma.InputJsonValue,
      result: Prisma.JsonNull,
      qualityReport: Prisma.JsonNull,
      events: [],
      error: null,
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
        version: { increment: 1 },
      },
    });
  } catch {
    throw new WorkspaceInputError("课程内容任务已经被其他操作更新，请刷新后重试。", "VERSION_CONFLICT", 409);
  }
  if (!isBackgroundCourseGenerationEnabled()) {
    after(() => runQueuedCourseGenerationToCompletion(course.id));
  }
}

async function adoptClassroomCandidate(
  course: Course,
  candidateId: string,
  teacherId: string,
): Promise<Course> {
  const workspace = course.content.designWorkspaceRevision;
  const candidate = workspace?.candidateUpdates?.find((item) => item.id === candidateId);
  if (!workspace || !candidate) throw new WorkspaceInputError("局部更新候选不存在或已经处理。", "CANDIDATE_NOT_FOUND", 404);
  if (workspace.revision !== candidate.baseRevision) {
    throw new WorkspaceInputError("课程设计在候选生成后已经修改，请丢弃候选并重新生成。", "CANDIDATE_STALE", 409);
  }
  const currentClassroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (currentClassroomId !== candidate.baseClassroomId) {
    throw new WorkspaceInputError("课堂内容在候选生成后已经变化，请重新生成局部更新。", "CANDIDATE_STALE", 409);
  }
  const [base, generated, job] = await Promise.all([
    readClassroom(candidate.baseClassroomId),
    readClassroom(candidate.classroomId),
    contentGenerationJobs.findUnique({ where: { courseId: course.id } }),
  ]);
  if (!base || !generated) throw new WorkspaceInputError("局部更新课堂资源已失效，请重新生成。", "CANDIDATE_RESOURCE_MISSING", 409);
  const fullOutlineIds = (course.content._openmaicSceneOutlines ?? []).map((outline) => outline.id);
  const mergedScenes = mergeCourseDesignClassroomScenes({
    outlineIds: fullOutlineIds,
    affectedOutlineIds: candidate.affectedOutlineIds,
    baseScenes: base.scenes,
    candidateScenes: generated.scenes,
  });
  if (!mergedScenes) {
    throw new WorkspaceInputError("候选页面不完整，原课堂保持不变，请重新生成。", "CANDIDATE_INCOMPLETE", 409);
  }
  const persisted = await updatePersistedClassroomForEditing(
    candidate.classroomId,
    { stage: base.stage, scenes: mergedScenes },
    generated.revision ?? 1,
  );
  const outlines = course.content._openmaicSceneOutlines ?? [];
  const reviewItems = collectGeneratedTeacherReviewItems({ outlines: outlines as SceneOutline[], scenes: mergedScenes });
  const request = job?.request as unknown as Partial<PersistedCourseGenerationRequest> | undefined;
  const timingAudit = summarizeTeachingTimingAudit({
    outlines: outlines as SceneOutline[],
    studentScenes: mergedScenes,
    enableTTS: request?.enableTTS !== false,
  });
  const state = await updateCourse(course.id, (current) => {
    const currentWorkspace = current.content.designWorkspaceRevision;
    const liveCandidate = currentWorkspace?.candidateUpdates?.find((item) => item.id === candidateId);
    if (current.version !== course.version || !currentWorkspace || !liveCandidate
      || currentWorkspace.revision !== candidate.baseRevision
      || (current.aiLearningClassroomId || current.content._openmaicClassroomId) !== candidate.baseClassroomId) {
      throw new WorkspaceInputError("课程已在其他页面更新，候选未被采用。", "VERSION_CONFLICT", 409);
    }
    const resolved = resolveCourseDesignUpdate(current.content, "classroom");
    return {
      ...current,
      status: "preparing",
      aiLearningClassroomId: candidate.classroomId,
      content: {
        ...current.content,
        teacherReview: undefined,
        renderReview: undefined,
        qualityReview: undefined,
        teachingTimingAudit: timingAudit,
        teachingRevisionState: undefined,
        teacherReviewItems: reviewItems,
        teacherReviewSummary: teacherReviewSummary(reviewItems),
        teacherReviewVersion: {
          generationPolicyVersion: "bounded-classroom-update-v1",
          classroomId: candidate.classroomId,
          classroomRevision: persisted.revision,
          generatedAt: new Date().toISOString(),
        },
        _openmaicClassroomId: candidate.classroomId,
        _openmaicScenesCount: mergedScenes.length,
        classroomGenerationRun: {
          scope: "full-course",
          status: "completed",
          generatedOutlineIds: fullOutlineIds,
          fullOutlineCount: fullOutlineIds.length,
          generatedAt: new Date().toISOString(),
        },
        designWorkspaceRevision: {
          ...resolved,
          candidateUpdates: (resolved.candidateUpdates ?? []).filter((item) => item.id !== candidateId),
        },
      },
    };
  }, { actor: { id: teacherId, role: "teacher" } });
  const updated = state.courses.find((item) => item.id === course.id);
  if (!updated) throw new WorkspaceInputError("课程不存在。", "COURSE_NOT_FOUND", 404);
  return updated;
}

export async function GET(request: Request, context: Context) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const course = await loadPblTemplateCourse(courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND", message: "课程不存在。" }, { status: 404 });
  return Response.json(await responsePayload(course), { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request, context: Context) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "INVALID_DESIGN_WORKSPACE_INPUT", message: "保存内容格式无效。" }, { status: 400 });
  const operation = parsed.data;
  try {
    if (operation.action === "generate-classroom-candidate") {
      const course = await loadPblTemplateCourse(courseId);
      if (!course) throw new WorkspaceInputError("课程不存在。", "COURSE_NOT_FOUND", 404);
      assertExpectedVersion(course, operation.expectedVersion);
      await queueClassroomCandidate(course, operation.sectionIds);
      return Response.json(await responsePayload(course), { status: 202 });
    }
    if (operation.action === "adopt-classroom-candidate") {
      const course = await loadPblTemplateCourse(courseId);
      if (!course) throw new WorkspaceInputError("课程不存在。", "COURSE_NOT_FOUND", 404);
      assertExpectedVersion(course, operation.expectedVersion);
      const updated = await adoptClassroomCandidate(course, operation.candidateId, requestedBy);
      return Response.json(await responsePayload(updated));
    }
    const state = await updateCourse(courseId, (current) => {
      assertExpectedVersion(current, operation.expectedVersion);
      if (operation.action === "save") return applySectionSave(current, operation.section, operation.data);
      if (operation.action === "discard-classroom-candidate") {
        const workspace = current.content.designWorkspaceRevision;
        if (!workspace?.candidateUpdates?.some((item) => item.id === operation.candidateId)) {
          throw new WorkspaceInputError("局部更新候选不存在或已经处理。", "CANDIDATE_NOT_FOUND", 404);
        }
        return {
          ...current,
          content: {
            ...current.content,
            designWorkspaceRevision: {
              ...workspace,
              candidateUpdates: workspace.candidateUpdates.filter((item) => item.id !== operation.candidateId),
            },
          },
        };
      }
      if (operation.action !== "confirm-current") {
        throw new WorkspaceInputError("不支持的课程设计操作。");
      }
      const target = operation.target;
      return {
        ...invalidateReview(current),
        content: {
          ...invalidateReview(current).content,
          designWorkspaceRevision: resolveCourseDesignUpdate(current.content, target),
        },
      };
    }, { actor: { id: requestedBy, role: "teacher" } });
    const course = state.courses.find((item) => item.id === courseId);
    if (!course) throw new WorkspaceInputError("课程不存在。", "COURSE_NOT_FOUND", 404);
    return Response.json(await responsePayload(course));
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "INVALID_DESIGN_WORKSPACE_INPUT", message: error.issues[0]?.message ?? "保存内容格式无效。" }, { status: 400 });
    if (error instanceof WorkspaceInputError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("[design-workspace] save failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "DESIGN_WORKSPACE_SAVE_FAILED", message: "课程设计保存失败，请重试。" }, { status: 503 });
  }
}
