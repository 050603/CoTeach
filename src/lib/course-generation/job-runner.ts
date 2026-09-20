import { Prisma } from "@prisma/client";
import type { CourseGenerationJob } from "@/lib/course-generation/job-storage";
import { loadGenerationCheckpoints, saveGenerationCheckpoint, resetGenerationCheckpoints, resetPreparedOutlinesCheckpoint, countGenerationPageCheckpoints } from "./checkpoint-storage";
import { contentGenerationJobs } from "@/lib/course-generation/job-storage";
import { createLogger } from "@openmaic/lib/logger";
import {
  generateClassroom,
  type ClassroomGenerationProgress,
  type GenerateClassroomInput,
} from "@openmaic/lib/server/classroom-generation";
import {
  generateClassroomAssets,
  summarizeTeachingTimingAudit,
  type ClassroomAssetGenerationProgress,
} from "@openmaic/lib/server/classroom-asset-generation";
import { splitGeneratedClassroom } from "@/lib/openmaic-bridge/server-classroom-split";
import { linkClassroomToCourse } from "@/lib/openmaic-bridge/course-linker";
import {
  isAbortError,
} from "@openmaic/lib/generation/generation-retry";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { hasExactKnowledgeLecturePageBudget, isNewSystemAiTimingPlan } from "@/lib/classroom/new-system-course";
import {
  adaptiveBranchGenerationSignature,
  selectAdaptiveBranchesForGeneration,
} from "@/lib/teacher/adaptive-resource-generation";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { AssessmentMode } from "@/lib/openmaic/types/generation";
import { runWithCourseGenerationLlmContext } from "@/lib/course-generation/llm-concurrency";
import type { Scene } from "@openmaic/lib/types/stage";
import {
  fingerprintSceneOutline,
  restoreSceneCheckpoint,
  restoreSceneStageAttemptCount,
  restoreSceneStageCheckpoint,
  SCENE_STAGE_CHECKPOINT_VERSION,
  type PageCheckpointSnapshot,
  type SceneGenerationCheckpointStage,
  type SceneStageAttemptSnapshot,
  type SceneStageCheckpointSnapshot,
} from "@/lib/course-generation/page-checkpoints";
import {
  ADAPTIVE_RESOURCE_CONCURRENCY,
  runAdaptiveResourcePool,
} from "@/lib/course-generation/adaptive-resource-pool";
import type { AdaptivePreparedBranchResource } from "@/lib/session/types";
import { buildAdaptiveBranchTeachingContext } from "./adaptive-teaching-context";
import { ensureTeachingToolPlans } from "@/lib/openmaic/generation/teaching-tool-plan";
import {
  COURSE_COVER_GENERATION_SPEC,
} from "@/lib/course-cover";
import { generateCourseCoverImageOnServer } from "@/lib/course-cover-server";
import {
  serializeCourseGenerationFailure,
} from "@/lib/course-generation/failure-policy";
import {
  auditCourseGeneratedResources,
  type CourseResourceIssue,
} from "@/lib/course-generation/resource-audit-server";
import { summarizeGeneratedMediaReadiness } from "@/lib/course-generation/resource-readiness";
import { estimateRemainingSeconds } from "@/lib/course-generation/progress-estimate";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import type {
  ClassroomGenerationScope,
  TestLessonGenerationTarget,
} from "@/lib/course-generation/generation-scope";

const log = createLogger("CourseGenerationWorker");
const POLL_INTERVAL_MS = 1_500;
const MAX_STORED_EVENTS = 80;
function mediaFailuresFromAudit(issues: CourseResourceIssue[]): Array<{
  elementId: string;
  type: "image" | "video";
  error: string;
}> {
  return issues.flatMap((issue) => {
    const match = /^media:(image|video):(.+)$/.exec(issue.id);
    return match
      ? [{ type: match[1] as "image" | "video", elementId: match[2], error: issue.detail }]
      : [];
  });
}

type StoredCheckpointState = {
  preparedOutlines: SceneOutline[];
  checkpoints: Map<string, PageCheckpointSnapshot>;
  stageCheckpoints: Map<string, SceneStageCheckpointSnapshot>;
  stageAttemptCheckpoints: Map<string, SceneStageAttemptSnapshot>;
  teachingSectionCheckpoints: Map<string, TeachingSectionCheckpointSnapshot>;
};

type TeachingSectionCheckpointSnapshot = {
  schemaVersion: 1;
  sectionKey: string;
  inputFingerprint: string;
  modelFingerprint: string;
  briefs: Array<[string, unknown]>;
};

function stageCheckpointKey(pageKey: string, stage: SceneGenerationCheckpointStage): string {
  return `${pageKey}:${stage}`;
}

async function loadCheckpointState(jobId: string): Promise<StoredCheckpointState> {
  const stored = await loadGenerationCheckpoints(jobId);
  const rawOutlines = stored.preparedOutlines;
  const checkpointRows = stored.pages as unknown as PageCheckpointSnapshot[];
  const preparedOutlines = Array.isArray(rawOutlines)
    ? rawOutlines as unknown as SceneOutline[]
    : [];
  const checkpoints = new Map<string, PageCheckpointSnapshot>();
  for (const row of checkpointRows) {
    checkpoints.set(row.pageKey, {
      pageKey: row.pageKey,
      outlineFingerprint: row.outlineFingerprint,
      modelFingerprint: row.modelFingerprint,
      inputFingerprint: row.inputFingerprint,
      scene: row.scene as unknown as Scene,
    });
  }
  const stageCheckpoints = new Map<string, SceneStageCheckpointSnapshot>();
  for (const row of stored.stages as unknown as SceneStageCheckpointSnapshot[]) {
    if (!row || typeof row.pageKey !== "string" || typeof row.stage !== "string") continue;
    stageCheckpoints.set(stageCheckpointKey(row.pageKey, row.stage), row);
  }
  const stageAttemptCheckpoints = new Map<string, SceneStageAttemptSnapshot>();
  for (const row of stored.stageAttempts as unknown as SceneStageAttemptSnapshot[]) {
    if (!row || typeof row.pageKey !== "string" || typeof row.stage !== "string") continue;
    stageAttemptCheckpoints.set(stageCheckpointKey(row.pageKey, row.stage), row);
  }
  const teachingSectionCheckpoints = new Map<string, TeachingSectionCheckpointSnapshot>();
  for (const row of stored.teachingSections as unknown as TeachingSectionCheckpointSnapshot[]) {
    if (!row || row.schemaVersion !== 1 || typeof row.sectionKey !== "string") continue;
    teachingSectionCheckpoints.set(row.sectionKey, row);
  }
  return {
    preparedOutlines,
    checkpoints,
    stageCheckpoints,
    stageAttemptCheckpoints,
    teachingSectionCheckpoints,
  };
}

async function persistPreparedOutlines(jobId: string, outlines: SceneOutline[]): Promise<void> {
  await saveGenerationCheckpoint(jobId, "prepared-outlines", outlines);
}

async function persistSceneCheckpoint(
  jobId: string,
  outline: SceneOutline,
  scene: Scene,
  modelFingerprint: string,
  inputFingerprint: string,
): Promise<PageCheckpointSnapshot> {
  const checkpoint: PageCheckpointSnapshot = {
    pageKey: outline.id,
    outlineFingerprint: fingerprintSceneOutline(outline),
    modelFingerprint,
    inputFingerprint,
    scene,
  };
  await saveGenerationCheckpoint(jobId, `page:${checkpoint.pageKey}`, checkpoint);
  return checkpoint;
}

async function persistSceneStageCheckpoint(input: {
  jobId: string;
  outline: SceneOutline;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
  payload: unknown;
}): Promise<SceneStageCheckpointSnapshot> {
  const checkpoint: SceneStageCheckpointSnapshot = {
    schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
    pageKey: input.outline.id,
    stage: input.stage,
    outlineFingerprint: fingerprintSceneOutline(input.outline),
    modelFingerprint: input.modelFingerprint,
    inputFingerprint: input.inputFingerprint,
    payload: input.payload,
  };
  await saveGenerationCheckpoint(
    input.jobId,
    `stage:${input.outline.id}:${input.stage}`,
    checkpoint,
  );
  return checkpoint;
}

async function persistSceneStageAttempt(input: {
  jobId: string;
  outline: SceneOutline;
  stage: SceneGenerationCheckpointStage;
  attemptsStarted: number;
  modelFingerprint: string;
  inputFingerprint?: string;
}): Promise<SceneStageAttemptSnapshot> {
  const checkpoint: SceneStageAttemptSnapshot = {
    schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
    pageKey: input.outline.id,
    stage: input.stage,
    outlineFingerprint: fingerprintSceneOutline(input.outline),
    modelFingerprint: input.modelFingerprint,
    inputFingerprint: input.inputFingerprint,
    attemptsStarted: input.attemptsStarted,
  };
  await saveGenerationCheckpoint(
    input.jobId,
    `stage-attempt:${input.outline.id}:${input.stage}`,
    checkpoint,
  );
  return checkpoint;
}

export async function resetCourseGenerationCheckpoints(jobId: string): Promise<void> {
  await resetGenerationCheckpoints(jobId);
}

export async function prepareCourseGenerationCheckpointsForFullPromotion(jobId: string): Promise<void> {
  await resetPreparedOutlinesCheckpoint(jobId);
}

export type PersistedCourseGenerationRequest = GenerateClassroomInput & {
  courseId: string;
  generationScope?: ClassroomGenerationScope;
  /** Count of pages in the confirmed full outline before a test selection. */
  fullSceneCount?: number;
  testLesson?: TestLessonGenerationTarget;
  systemMode?: "new";
  generationContractVersion?: 2 | 3;
  assessmentMode?: AssessmentMode;
  courseTitle?: string;
  moduleTimingPlan?: unknown;
  resourcePackageIdentity?: { id: string; revision: number };
  adaptiveBranchCount?: number;
  /** Internal checkpoint-recovery state; never supplied by the teacher UI. */
  managedRecoveryCount?: number;
};

export type CourseGenerationJobEvent = {
  step: string;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes: number;
  ts: number;
  assetPhaseStatus?: ClassroomAssetGenerationProgress["status"];
  assetCompleted?: number;
  assetTotal?: number;
  activePages?: ClassroomGenerationProgress["activePages"];
  stageDetail?: ClassroomGenerationProgress["stage"];
};

let workerStarted = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let activeController: AbortController | null = null;
let activeCourseId: string | null = null;
const cancellationRequested = new Set<string>();

function asEvents(value: Prisma.JsonValue): CourseGenerationJobEvent[] {
  return Array.isArray(value)
    ? value.filter((item): item is CourseGenerationJobEvent => Boolean(item && typeof item === "object"))
    : [];
}

function localizedProgress(progress: ClassroomGenerationProgress): string {
  switch (progress.step) {
    case "initializing": return "正在初始化课程生成环境";
    case "researching": return "正在整理课程资料与教学要求";
    case "generating_outlines":
      return progress.message.startsWith("正在生成分小节教学设计")
        || progress.message === "正在检查分小节教学设计"
        ? progress.message
        : "正在生成课程结构与页面安排";
    case "generating_scenes":
      return progress.stage || progress.activePages?.length
        ? progress.message
        : progress.message.startsWith("正在制作第 ")
        ? progress.message
        : progress.scenesGenerated > 0 && progress.totalScenes
        ? `已完成 ${progress.scenesGenerated} / ${progress.totalScenes} 个课堂页面`
        : "正在制作课堂页面与讲授内容";
    case "generating_media": return "正在补充课程图片与媒体资源";
    case "generating_tts": return "正在生成课堂语音";
    case "persisting": return "正在保存并检查课程内容";
    case "completed": return "课程内容已生成完成";
  }
}

export function estimatePersistedCourseGenerationSeconds(input: {
  totalScenes: number;
  adaptiveBranchCount?: number;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
}): number {
  const scenes = Math.max(input.totalScenes, 6);
  const classroomSeconds = 120 + scenes * 35;
  const adaptiveSeconds = Math.ceil(
    Math.max(0, Math.round(input.adaptiveBranchCount ?? 0)) / ADAPTIVE_RESOURCE_CONCURRENCY,
  ) * 90;
  // Media and speech run concurrently after the page bodies are durable. Use
  // the slower expected branch instead of summing both branches.
  const mediaSeconds = (input.enableImageGeneration === false ? 0 : scenes * 5)
    + (input.enableVideoGeneration === true ? scenes * 20 : 0);
  const speechSeconds = input.enableTTS === false ? 0 : scenes * 6;
  const coverSeconds = 45;
  return Math.max(5 * 60, classroomSeconds + adaptiveSeconds + Math.max(mediaSeconds, speechSeconds) + coverSeconds);
}

async function persistProgress(
  job: CourseGenerationJob,
  progress: ClassroomGenerationProgress,
  scenePhaseStartedAt: number | null,
  scenePhaseInitialGenerated: number,
): Promise<void> {
  const message = localizedProgress(progress);
  const event: CourseGenerationJobEvent = {
    step: progress.step,
    // The primary classroom owns 0-90. Splitting, adaptive resources and the
    // final durable save own the remaining range.
    progress: Math.max(job.progress, Math.min(90, progress.progress)),
    message,
    scenesGenerated: Math.max(job.scenesGenerated, progress.scenesGenerated),
    totalScenes: progress.totalScenes ?? job.totalScenes,
    ts: Date.now(),
    activePages: progress.activePages,
    stageDetail: progress.stage,
  };
  const events = [...asEvents(job.events), event].slice(-MAX_STORED_EVENTS);
  const remaining = estimateRemainingSeconds({
    startedAt: job.startedAt ?? job.createdAt,
    scenePhaseStartedAt,
    scenePhaseInitialGenerated,
    scenesGenerated: event.scenesGenerated,
    totalScenes: event.totalScenes,
    progress: event.progress,
    step: event.step,
    baselineSeconds: estimatePersistedCourseGenerationSeconds({
      totalScenes: event.totalScenes,
      adaptiveBranchCount: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).adaptiveBranchCount,
      enableImageGeneration: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableImageGeneration,
      enableVideoGeneration: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableVideoGeneration,
      enableTTS: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableTTS,
    }),
  });
  const updated = await contentGenerationJobs.update({
    where: { id: job.id },
    data: {
      step: event.step,
      progress: event.progress,
      message,
      scenesGenerated: event.scenesGenerated,
      totalScenes: event.totalScenes,
      estimatedRemainingSeconds: remaining,
      activePages: (progress.activePages ?? []) as unknown as Prisma.InputJsonValue,
      currentStage: progress.stage ?? null,
      events: events as unknown as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
      version: { increment: 1 },
    },
  });
  Object.assign(job, updated);
}

async function persistAdaptiveProgress(
  job: CourseGenerationJob,
  input: { completed: number; total: number; overallProgress: number; title: string },
): Promise<void> {
  const combined = Math.max(0, Math.min(1, input.overallProgress));
  const progress = Math.max(job.progress, Math.min(98, 90 + Math.round(combined * 8)));
  const message = `正在生成分层学习资源：${input.title}（已完成 ${input.completed} / ${input.total}）`;
  const event: CourseGenerationJobEvent = {
    step: "generating_adaptive_resources",
    progress,
    message,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    ts: Date.now(),
  };
  const events = [...asEvents(job.events), event].slice(-MAX_STORED_EVENTS);
  const updated = await contentGenerationJobs.update({
    where: { id: job.id },
    data: {
      step: event.step,
      progress,
      message,
      estimatedRemainingSeconds: Math.max(
        30,
        Math.ceil((input.total - input.completed) / ADAPTIVE_RESOURCE_CONCURRENCY) * 90,
      ),
      events: events as unknown as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
      version: { increment: 1 },
    },
  });
  Object.assign(job, updated);
}

async function persistWorkerPhase(
  job: CourseGenerationJob,
  input: {
    step: string;
    progress: number;
    message: string;
    estimatedRemainingSeconds?: number;
    assetPhaseStatus?: ClassroomAssetGenerationProgress["status"];
    assetCompleted?: number;
    assetTotal?: number;
  },
): Promise<void> {
  const event: CourseGenerationJobEvent = {
    step: input.step,
    progress: Math.max(job.progress, input.progress),
    message: input.message,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    ts: Date.now(),
    assetPhaseStatus: input.assetPhaseStatus,
    assetCompleted: input.assetCompleted,
    assetTotal: input.assetTotal,
  };
  const updated = await contentGenerationJobs.update({
    where: { id: job.id },
    data: {
      step: input.step,
      progress: event.progress,
      message: input.message,
      estimatedRemainingSeconds: input.estimatedRemainingSeconds ?? job.estimatedRemainingSeconds,
      events: [...asEvents(job.events), event].slice(-MAX_STORED_EVENTS) as unknown as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
      version: { increment: 1 },
    },
  });
  Object.assign(job, updated);
}

function assetPhaseStep(progress: ClassroomAssetGenerationProgress): string {
  if (progress.phase === "media") return "generating_media_assets";
  if (progress.phase === "tts") return "generating_tts_assets";
  return "persisting_assets";
}

async function generateAndPersistCourseCover(
  job: CourseGenerationJob,
  courseId: string,
  signal: AbortSignal,
  serializeWrite: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<"ready" | "failed"> {
  const course = await getCourse(courseId);
  if (!course) return "failed";
  if (course.coverImageUrl) return "ready";
  await serializeWrite(() => persistWorkerPhase(job, {
    step: "generating_course_cover",
    progress: 99,
    message: `正在生成课程封面：${course.name}`,
    estimatedRemainingSeconds: 45,
  }));
  try {
    const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
    if (!classroomId) throw new Error("课程课堂尚未持久化，无法保存课程封面");
    const coverImageUrl = await generateCourseCoverImageOnServer(course, classroomId, signal);
    await updateCourse(courseId, (current) => ({ ...current, coverImageUrl }));
    await serializeWrite(() => persistWorkerPhase(job, {
      step: "course_cover_ready",
      progress: 99,
      message: `课程封面已生成并保存（${COURSE_COVER_GENERATION_SPEC.width}×${COURSE_COVER_GENERATION_SPEC.height}）`,
      estimatedRemainingSeconds: 10,
    }));
    return "ready";
  } catch (coverError) {
    if (signal.aborted || isAbortError(coverError)) throw coverError;
    log.error("Automatic quick-course cover generation failed", coverError);
    await serializeWrite(() => persistWorkerPhase(job, {
      step: "course_cover_failed",
      progress: 99,
      message: "课程封面生成未完成，可在课程设计稿中重新生成",
      estimatedRemainingSeconds: 10,
    }));
    return "failed";
  }
}

async function persistAdaptiveBranchResource(
  courseId: string,
  branchId: string,
  preparedResource: AdaptivePreparedBranchResource,
): Promise<void> {
  await updateCourse(courseId, (current) => {
    const currentPlan = current.content.adaptiveLearningPlan;
    if (!currentPlan) return current;
    return {
      ...current,
      content: {
        ...current.content,
        adaptiveLearningPlan: {
          ...currentPlan,
          updatedAt: new Date().toISOString(),
          branches: currentPlan.branches.map((branch) => (
            branch.id === branchId ? { ...branch, preparedResource } : branch
          )),
        },
      },
    };
  });
}

export async function generateAdaptiveBranchResource(
  courseId: string,
  branchId: string,
  signal: AbortSignal,
  reportProgress: (progress: number) => Promise<void> = async () => undefined,
): Promise<AdaptivePreparedBranchResource> {
  const course = await getCourse(courseId);
  const plan = course?.content.adaptiveLearningPlan;
  const branch = plan?.branches.find((candidate) => candidate.id === branchId);
  if (!course || !plan || !branch || branch.enabled === false || branch.status !== "teacher-confirmed") {
    throw new Error("个性化学习资源不存在或尚未确认");
  }
  await persistAdaptiveBranchResource(courseId, branch.id, {
    status: "generating",
    generatedAt: new Date().toISOString(),
  });

  try {
    return await (async () => {
      const teachingContext = buildAdaptiveBranchTeachingContext(course, branch, plan);
      const sceneOutline: SceneOutline = ensureTeachingToolPlans([{
        id: `adaptive-${branch.id}`,
        type: branch.sceneType ?? "slide",
        title: branch.title,
        description: branch.objective,
        keyPoints: branch.keyPoints,
        teachingObjective: branch.objective,
        estimatedDuration: branch.targetDurationSec,
        targetDurationSec: branch.targetDurationSec,
        order: 0,
        stageKey: "ai-learning",
        stageLabel: "知识讲授",
        audience: "student",
        generationPurpose: "knowledge-teaching",
        detailKind: "knowledge-explanation",
        knowledgePointIds: teachingContext.knowledgePoints.map((point) => point.id),
        ttsPolicy: "target-duration",
        resourceTypes: branch.sceneType === "interactive" ? ["interactive-demo"] : ["ppt"],
        narrationMode: "embedded-segment",
      }])[0];
      const generated = await generateClassroom({
        courseTitle: `${course.name} · ${branch.title}`,
        ...teachingContext,
        sceneOutlines: [sceneOutline],
        enableTTS: true,
      }, {
        signal,
        onProgress: (progress) => reportProgress(progress.progress / 100),
      });
      const split = await splitGeneratedClassroom({
        stage: generated.stage,
        scenes: generated.scenes,
        courseName: `${course.name} · ${branch.title}`,
        pblMode: false,
        signal,
      });
      // Relative same-origin media URLs work both locally and behind a reverse
      // proxy. PUBLIC_BASE_URL remains optional and is only used when present.
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || "";
      await generateClassroomAssets({
        ...generated.assetContext,
        baseUrl,
        studentClassroomId: split.studentClassroomId,
        studentScenes: split.studentScenes,
        teacherClassroomId: split.teacherClassroomId || undefined,
        teacherScenes: split.teacherScenes,
        signal,
      });
      const speechWithoutConfiguredAudio = split.studentScenes.some((scene) =>
        (scene.actions ?? []).some((action) =>
          action.type === "speech" && action.text.trim().length > 0 && !action.audioUrl,
        ),
      );
      if (speechWithoutConfiguredAudio) {
        const error = new Error("个性化学习资源仍有语音未生成") as Error & { isRetryable: boolean };
        error.isRetryable = false;
        throw error;
      }
      const preparedResource: AdaptivePreparedBranchResource = {
        status: "ready",
        classroomId: split.studentClassroomId,
        scenesCount: split.studentSceneCount,
        generatedAt: new Date().toISOString(),
        sourceSignature: adaptiveBranchGenerationSignature(branch),
      };
      await persistAdaptiveBranchResource(courseId, branch.id, preparedResource);
      return preparedResource;
    })();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    await persistAdaptiveBranchResource(courseId, branch.id, {
      status: "failed",
      generatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function prepareAdaptiveResources(
  job: CourseGenerationJob,
  courseId: string,
  signal: AbortSignal,
  serializeProgress: (work: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const course = await getCourse(courseId);
  const plan = course?.content.adaptiveLearningPlan;
  if (
    !course
    || !plan?.enabled
    || plan.status !== "teacher-confirmed"
    || plan.prerequisiteSemanticReview?.status !== "passed"
  ) return;
  const branches = selectAdaptiveBranchesForGeneration(plan.branches);
  if (branches.length === 0) return;

  const results = await runAdaptiveResourcePool(
    branches,
    (branch, _index, reportProgress) =>
      generateAdaptiveBranchResource(courseId, branch.id, signal, reportProgress),
    {
      signal,
      onProgress: (progress) => serializeProgress(() => persistAdaptiveProgress(job, {
        completed: progress.completed,
        total: progress.total,
        overallProgress: progress.overallProgress,
        title: branches[progress.itemIndex]?.title ?? "学习分支",
      })),
    },
  );
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Course generation cancelled");
  }
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      log.error(`Adaptive resource branch ${branches[index]?.id ?? index} failed`, result.reason);
    }
  });
}

async function claimNextJob(): Promise<CourseGenerationJob | null> {
  const candidate = await contentGenerationJobs.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const now = new Date();
  const claimed = await contentGenerationJobs.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: {
      status: "running",
      step: "initializing",
      message: "正在启动课程生成任务",
      startedAt: now,
      lastHeartbeatAt: now,
      error: null,
      attempt: { increment: 1 },
      version: { increment: 1 },
    },
  });
  return claimed.count === 1
    ? contentGenerationJobs.findUnique({ where: { id: candidate.id } })
    : null;
}

/**
 * Starts the already-persisted classroom job in request-bound workstation
 * environments. The durable queue remains the source of truth, so the quick
 * generator and the detailed generator still execute the exact same job.
 */
export async function startQueuedCourseGeneration(courseId: string): Promise<CourseGenerationJob | null> {
  const candidate = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!candidate || candidate.status !== "queued") return candidate;
  const now = new Date();
  const claimed = await contentGenerationJobs.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: {
      status: "running",
      step: "initializing",
      message: "正在启动课程生成任务",
      startedAt: now,
      lastHeartbeatAt: now,
      error: null,
      attempt: { increment: 1 },
      version: { increment: 1 },
    },
  });
  const job = await contentGenerationJobs.findUnique({ where: { id: candidate.id } });
  if (claimed.count === 1 && job) void runJob(job);
  return job;
}

/**
 * Request-bound fallback for environments without the polling worker. The
 * Route Handler registers this with Next.js `after()`, so the execution is
 * explicitly retained for the route duration instead of becoming an orphaned
 * promise after the response is sent.
 */
export async function runQueuedCourseGenerationToCompletion(
  courseId: string,
): Promise<CourseGenerationJob | null> {
  const candidate = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!candidate || candidate.status !== "queued") return candidate;
  const now = new Date();
  const claimed = await contentGenerationJobs.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: {
      status: "running",
      step: "initializing",
      message: "正在启动课程生成任务",
      startedAt: now,
      lastHeartbeatAt: now,
      error: null,
      attempt: { increment: 1 },
      version: { increment: 1 },
    },
  });
  const job = await contentGenerationJobs.findUnique({ where: { id: candidate.id } });
  if (claimed.count === 1 && job) await runJob(job);
  return contentGenerationJobs.findUnique({ where: { id: candidate.id } });
}

/** Legacy read endpoint: recovery now requires explicit continuation. */
export async function resumeRecoverableCourseGenerationJob(courseId: string): Promise<CourseGenerationJob | null> {
  return contentGenerationJobs.findUnique({ where: { courseId } });
}

/**
 * Explicitly continues a failed classroom job from its durable page
 * checkpoints. Unlike submitting a new generation request, this intentionally
 * preserves prepared outlines and completed pages. The managed recovery budget
 * is reset because this is a teacher-confirmed continuation after the service
 * configuration or provider availability may have changed.
 */
export async function requeueCourseGenerationFromCheckpoints(
  courseId: string,
): Promise<CourseGenerationJob | null> {
  const job = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!job || job.status !== "failed") return job;
  const completedPageCount = await countGenerationPageCheckpoints(job.id);
  // 早期失败(如大纲校验)可能没有任何已完成页面或 checkpoint;此时仍需
  // 重新入队并保留原请求,否则"从已完成页面继续"会静默无效果。
  // 若之前已持久化过大纲(preparedOutlines),续跑会自动复用它们。
  const message = completedPageCount > 0
    ? `正在从 ${completedPageCount} 个已完成页面继续生成`
    : "正在重新开始课程内容生成（此前尚无已完成的页面）";
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  await contentGenerationJobs.updateMany({
    where: { id: job.id, status: "failed" },
    data: {
      status: "queued",
      step: "recovering_scenes",
      message,
      request: {
        ...request,
        managedRecoveryCount: 0,
      } as unknown as Prisma.InputJsonValue,
      error: null,
      completedAt: null,
      estimatedRemainingSeconds: 600,
      lastHeartbeatAt: new Date(),
      version: { increment: 1 },
    },
  });
  return contentGenerationJobs.findUnique({ where: { id: job.id } });
}

async function runJob(job: CourseGenerationJob): Promise<void> {
  return runWithCourseGenerationLlmContext(
    () => runJobWithCourseGenerationContext(job),
    {
      onTokenUsage: async (totalTokens) => {
        try {
          await contentGenerationJobs.update({
            where: { id: job.id },
            data: {
              tokenUsage: { increment: totalTokens },
              tokenUsageCalls: { increment: 1 },
            },
          });
        } catch (error) {
          log.warn("Unable to persist classroom-generation token estimate", error);
        }
      },
    },
  );
}

async function runJobWithCourseGenerationContext(job: CourseGenerationJob): Promise<void> {
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  const generationInput = { ...request };
  const courseId = generationInput.courseId;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).courseId;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).generationScope;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).fullSceneCount;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).testLesson;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).systemMode;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).generationContractVersion;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).assessmentMode;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).moduleTimingPlan;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).resourcePackageIdentity;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).adaptiveBranchCount;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).managedRecoveryCount;
  const controller = new AbortController();
  activeController = controller;
  activeCourseId = courseId;
  let scenePhaseStartedAt: number | null = null;
  let scenePhaseInitialGenerated = job.scenesGenerated;
  let workerWriteChain = Promise.resolve();
  const serializeWorkerWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const result = workerWriteChain.then(work, work);
    workerWriteChain = result.then(() => undefined, () => undefined);
    return result;
  };

  try {
    const checkpointState = await loadCheckpointState(job.id);
    const course = await getCourse(courseId);
    const currentPackage = course?.content.resourcePackage;
    if (request.resourcePackageIdentity
      ? !currentPackage?.confirmedAt || currentPackage.id !== request.resourcePackageIdentity.id || currentPackage.revision !== request.resourcePackageIdentity.revision
      : Boolean(currentPackage)) {
      throw new Error("资源包已更换或重新编辑，请按最新确认的教案重新生成，旧课堂检查点不会应用到新包。");
    }
    const timing = course?.content.moduleTimingPlan;
    const outlines = checkpointState.preparedOutlines.length ? checkpointState.preparedOutlines : generationInput.sceneOutlines ?? [];
    const isTestLesson = request.generationScope === "test-lesson";
    const outlinesById = new Map(outlines.map((outline) => [outline.id, outline]));
    const testOutlines = request.testLesson?.sceneOutlineIds.flatMap((id) => {
      const outline = outlinesById.get(id);
      return outline ? [outline] : [];
    }) ?? [];
    const testLessonIdsMatch = !isTestLesson || (
      Boolean(request.testLesson)
      && request.testLesson!.sceneOutlineIds.length === testOutlines.length
      && (request.fullSceneCount ?? 0) === outlines.length
      && hasExactKnowledgeLecturePageBudget(
        testOutlines,
        (request.testLesson?.durationSeconds ?? 0) / 60,
      )
    );
    if (!course || !isNewSystemAiTimingPlan(timing, course.hours, course.content.stagePlan)
      || !testLessonIdsMatch
      || !hasExactKnowledgeLecturePageBudget(outlines, timing?.totalMinutes ?? 0)) {
      throw new Error("知识讲授必须符合已确认的课程时间预算，且讲解与小测合计必须等于该预算。资源包课程以教案分钟数为准，请重新规划后生成，不可继续使用不匹配的页面或检查点。");
    }
    const generated = await generateClassroom(generationInput, {
      signal: controller.signal,
      generationOutlineIds: isTestLesson ? request.testLesson?.sceneOutlineIds : undefined,
      preparedOutlines: checkpointState.preparedOutlines,
      onOutlinesPrepared: (outlines) => persistPreparedOutlines(job.id, outlines),
      loadTeachingSectionCheckpoint: (sectionKey, inputFingerprint, modelFingerprint) => {
        const checkpoint = checkpointState.teachingSectionCheckpoints.get(sectionKey);
        if (
          !checkpoint
          || checkpoint.inputFingerprint !== inputFingerprint
          || checkpoint.modelFingerprint !== modelFingerprint
          || !Array.isArray(checkpoint.briefs)
        ) return null;
        return checkpoint.briefs;
      },
      onTeachingSectionCompleted: async (sectionKey, inputFingerprint, modelFingerprint, briefs) => {
        const checkpoint: TeachingSectionCheckpointSnapshot = {
          schemaVersion: 1,
          sectionKey,
          inputFingerprint,
          modelFingerprint,
          briefs,
        };
        await saveGenerationCheckpoint(job.id, `teaching-section:${sectionKey}`, checkpoint);
        checkpointState.teachingSectionCheckpoints.set(sectionKey, checkpoint);
      },
      loadSceneCheckpoint: (outline, _index, stageId, modelFingerprint, inputFingerprint) => restoreSceneCheckpoint(
        outline,
        checkpointState.checkpoints.get(outline.id),
        stageId,
        modelFingerprint,
        inputFingerprint,
      ),
      loadSceneStageCheckpoint: (outline, stage, modelFingerprint, inputFingerprint) =>
        restoreSceneStageCheckpoint({
          outline,
          checkpoint: checkpointState.stageCheckpoints.get(stageCheckpointKey(outline.id, stage)),
          stage,
          modelFingerprint,
          inputFingerprint,
        }),
      onSceneStageCompleted: async (outline, stage, payload, modelFingerprint, inputFingerprint) => {
        const checkpoint = await persistSceneStageCheckpoint({
          jobId: job.id,
          outline,
          stage,
          payload,
          modelFingerprint,
          inputFingerprint,
        });
        checkpointState.stageCheckpoints.set(stageCheckpointKey(outline.id, stage), checkpoint);
      },
      loadSceneStageAttemptCount: (outline, stage, modelFingerprint, inputFingerprint) =>
        restoreSceneStageAttemptCount({
          outline,
          checkpoint: checkpointState.stageAttemptCheckpoints.get(stageCheckpointKey(outline.id, stage)),
          stage,
          modelFingerprint,
          inputFingerprint,
        }),
      onSceneStageAttempt: async (outline, stage, attemptsStarted, modelFingerprint, inputFingerprint) => {
        const checkpoint = await persistSceneStageAttempt({
          jobId: job.id,
          outline,
          stage,
          attemptsStarted,
          modelFingerprint,
          inputFingerprint,
        });
        checkpointState.stageAttemptCheckpoints.set(stageCheckpointKey(outline.id, stage), checkpoint);
      },
      onSceneCompleted: async (outline, scene, _index, modelFingerprint, inputFingerprint) => {
        const checkpoint = await persistSceneCheckpoint(
          job.id,
          outline,
          scene,
          modelFingerprint,
          inputFingerprint,
        );
        checkpointState.checkpoints.set(outline.id, checkpoint);
      },
      onProgress: async (progress) => {
        if (progress.step === "generating_scenes" && scenePhaseStartedAt === null) {
          scenePhaseStartedAt = Date.now();
          scenePhaseInitialGenerated = job.scenesGenerated;
        }
        await serializeWorkerWrite(() => persistProgress(
          job,
          progress,
          scenePhaseStartedAt,
          scenePhaseInitialGenerated,
        ));
      },
    });
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "separating_classrooms",
      progress: 91,
      message: "正在拆分学生课堂与教师授课资源",
      estimatedRemainingSeconds: 180,
    }));
    const split = await splitGeneratedClassroom({
      stage: generated.stage,
      scenes: generated.scenes,
      courseName: request.courseTitle,
      pblMode: false,
      signal: controller.signal,
    });
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "saving_classrooms",
      progress: 93,
      message: "正在关联并保存学生课堂与教师资源",
      estimatedRemainingSeconds: 150,
    }));
    await linkClassroomToCourse(courseId, split.studentClassroomId, {
      scenesCount: split.studentSceneCount,
      stageName: generated.stage.name,
      teacherClassroomId: split.teacherClassroomId,
      teacherResourceScenes: split.teacherResourceScenes,
      sceneOutlines: generated.assetContext.outlines,
      systemMode: "new",
    }, { signal: controller.signal });
    const generatedOutlineIds = generated.assetContext.outlines.map((outline) => outline.id);
    const generatedOutlineIdSet = new Set(generatedOutlineIds);
    await updateCourse(courseId, (current) => ({
      ...current,
      content: {
        ...current.content,
        lessonOutline: current.content.lessonOutline.filter((outline) => generatedOutlineIdSet.has(outline.id)),
        knowledgeLectureSections: deriveKnowledgeLectureSectionsFromOutlines(
          generated.assetContext.outlines as unknown as import("@/lib/session/types").OpenMaicSceneOutlineSnapshot[],
        ),
        classroomGenerationRun: {
          scope: request.generationScope ?? "full-course",
          status: "completed",
          generatedOutlineIds,
          fullOutlineCount: request.fullSceneCount ?? generatedOutlineIds.length,
          ...(request.testLesson ? { testLesson: request.testLesson } : {}),
          generatedAt: new Date().toISOString(),
        },
        teacherReviewItems: generated.teacherReviewItems,
        teacherReviewSummary: generated.teacherReviewSummary,
        teacherReviewVersion: generated.teacherReviewVersion,
      },
    }));
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "checking_adaptive_resources",
      progress: 94,
      message: "正在检查个性化学习分支资源",
      estimatedRemainingSeconds: 120,
    }));
    const result = {
      id: split.studentClassroomId,
      scenesCount: split.studentSceneCount,
      studentSceneCount: split.studentSceneCount,
      teacherSceneCount: split.teacherSceneCount,
      teacherClassroomId: split.teacherClassroomId,
      teacherResourceScenes: split.teacherResourceScenes,
      pblCoverage: split.pblCoverage,
      qualityReport: generated.qualityReport,
      teacherReviewItems: generated.teacherReviewItems,
      teacherReviewSummary: generated.teacherReviewSummary,
      teacherReviewVersion: generated.teacherReviewVersion,
      stage: { id: generated.stage.id, name: generated.stage.name },
      generationScope: request.generationScope ?? "full-course",
      ...(request.testLesson ? { testLesson: request.testLesson } : {}),
    };
    const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || "";
    const adaptivePromise = prepareAdaptiveResources(
      job,
      courseId,
      controller.signal,
      serializeWorkerWrite,
    );
    const assetPromise = (async () => {
      const assetInput = {
        ...generated.assetContext,
        baseUrl,
        studentClassroomId: split.studentClassroomId,
        studentScenes: split.studentScenes,
        teacherClassroomId: split.teacherClassroomId || undefined,
        teacherScenes: split.teacherScenes,
        signal: controller.signal,
        onProgress: (progress: ClassroomAssetGenerationProgress) => serializeWorkerWrite(() => persistWorkerPhase(job, {
          step: assetPhaseStep(progress),
          progress: progress.status === "completed" ? 99 : 98,
          message: progress.message,
          estimatedRemainingSeconds: progress.phase === "persisting" ? 20 : 60,
          assetPhaseStatus: progress.status,
          assetCompleted: progress.completed,
          assetTotal: progress.total,
        })),
      };
      try {
        return await generateClassroomAssets(assetInput);
      } catch (assetError) {
        if (controller.signal.aborted || isAbortError(assetError)) throw assetError;
        // Classroom content has already been durably linked. Optional provider
        // failures must not discard a long-running successful generation.
        log.error("Background classroom asset generation failed", assetError);
        return summarizeTeachingTimingAudit(assetInput);
      }
    })();
    const [, teachingTimingAudit] = await Promise.all([adaptivePromise, assetPromise]);
    if (teachingTimingAudit) {
      await updateCourse(courseId, (current) => ({
        ...current,
        content: { ...current.content, teachingTimingAudit },
      }));
    }
    const coverStatus = await generateAndPersistCourseCover(
      job,
      courseId,
      controller.signal,
      serializeWorkerWrite,
    );
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "auditing_resources",
      progress: 99,
      message: "正在确认课程资源已保存并可用",
      estimatedRemainingSeconds: 15,
    }));
    const resourceAudit = await auditCourseGeneratedResources(courseId);
    const requiredMediaFailures = mediaFailuresFromAudit(resourceAudit.issues).filter((failure) =>
      failure.type === "image"
        ? generationInput.enableImageGeneration !== false
        : generationInput.enableVideoGeneration === true,
    );
    const {
      missingRequiredImageCount,
      missingRequiredVideoCount,
      coverNeedsAttention,
    } = summarizeGeneratedMediaReadiness({
      failures: requiredMediaFailures,
      enableImageGeneration: generationInput.enableImageGeneration !== false,
      enableVideoGeneration: generationInput.enableVideoGeneration === true,
      coverStatus,
    });
    if (missingRequiredImageCount > 0 || missingRequiredVideoCount > 0) {
      log.warn(
        `Course content completed with unresolved media [courseId=${courseId}, images=${missingRequiredImageCount}, videos=${missingRequiredVideoCount}]`,
      );
    }
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "generation_resources_ready",
      progress: 99,
      message: resourceAudit.issues.length > 0
        ? `课程主体已经完成，仍有 ${resourceAudit.issues.length} 项资源在自动重试后未就绪`
        : coverNeedsAttention
          ? "课堂资源已经就绪，课程封面需要稍后补充"
          : "课程封面、个性化学习资源与课堂素材已经就绪",
      estimatedRemainingSeconds: 20,
    }));

    const finalEvent: CourseGenerationJobEvent = {
      step: "completed",
      progress: 100,
      message: isTestLesson
        ? resourceAudit.issues.length > 0
          ? `测试小节已由正式链路生成，${resourceAudit.issues.length} 项配套资源需要在预览页继续处理`
          : "测试小节已由正式课堂链路完整生成，可开始验收"
        : resourceAudit.issues.length > 0
          ? `课程主体已生成，${resourceAudit.issues.length} 项配套资源需要在预览页继续处理`
          : coverNeedsAttention
            ? "课程内容已完整生成，课程封面可稍后补充"
            : "课程内容与配套资源已完整生成",
      scenesGenerated: split.studentSceneCount,
      totalScenes: Math.max(job.totalScenes, split.studentSceneCount),
      ts: Date.now(),
    };
    await contentGenerationJobs.update({
      where: { id: job.id },
      data: {
        status: "completed",
        step: "completed",
        progress: 100,
        message: finalEvent.message,
        scenesGenerated: finalEvent.scenesGenerated,
        totalScenes: finalEvent.totalScenes,
        estimatedRemainingSeconds: 0,
        result: {
          ...result,
          resourceIssues: resourceAudit.issues,
        } as unknown as Prisma.InputJsonValue,
        qualityReport: generated.qualityReport as unknown as Prisma.InputJsonValue,
        events: [...asEvents(job.events), finalEvent].slice(-MAX_STORED_EVENTS) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    });


  } catch (error) {
    if (cancellationRequested.has(courseId)) {
      await contentGenerationJobs.update({
        where: { id: job.id },
        data: {
          status: "cancelled",
          step: "cancelled",
          message: "课程生成已中断",
          error: null,
          estimatedRemainingSeconds: null,
          completedAt: new Date(),
          lastHeartbeatAt: new Date(),
          version: { increment: 1 },
        },
      });
      return;
    }
    if (stopping && (controller.signal.aborted || isAbortError(error))) {
      await contentGenerationJobs.updateMany({
        where: { id: job.id, status: "running" },
        data: { status: "queued", step: "queued", message: "等待服务器继续生成", lastHeartbeatAt: new Date() },
      });
      return;
    }
    log.error(`Course generation job ${job.id} failed`, error);
    await contentGenerationJobs.update({
      where: { id: job.id },
      data: {
        status: "failed",
        step: "failed",
        message: "课程生成未完成",
        error: serializeCourseGenerationFailure(error),
        estimatedRemainingSeconds: null,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    });
  } finally {
    if (activeController === controller) activeController = null;
    if (activeCourseId === courseId) activeCourseId = null;
    cancellationRequested.delete(courseId);
  }
}

export async function cancelCourseGeneration(courseId: string): Promise<CourseGenerationJob | null> {
  const job = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return job;
  if (job.status === "queued") {
    return contentGenerationJobs.update({
      where: { id: job.id },
      data: {
        status: "cancelled",
        step: "cancelled",
        message: "课程生成已中断",
        completedAt: new Date(),
        estimatedRemainingSeconds: null,
        version: { increment: 1 },
      },
    });
  }
  cancellationRequested.add(courseId);
  const cancelling = await contentGenerationJobs.update({
    where: { id: job.id },
    data: {
      status: "cancelling",
      message: "正在安全中断课程生成",
      version: { increment: 1 },
    },
  });
  if (activeCourseId === courseId) activeController?.abort(new Error("Course generation cancelled"));
  return cancelling;
}

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    const job = await claimNextJob();
    if (job) await runJob(job);
  } catch (error) {
    log.error("Course generation worker tick failed", error);
  } finally {
    if (!stopping) {
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      timer.unref?.();
    }
  }
}

export async function startCourseGenerationWorker(): Promise<void> {
  if (workerStarted) return;
  workerStarted = true;
  stopping = false;
  // This deployment owns exactly one durable course worker. Any RUNNING row
  // present before this process starts belonged to the previous process and
  // no longer has an executor, even when its last heartbeat is recent. Requeue
  // immediately so a service restart resumes page checkpoints without a
  // misleading 30-minute frozen state.
  await contentGenerationJobs.updateMany({
    where: { status: "running" },
    data: { status: "queued", step: "queued", message: "等待服务器继续生成" },
  });
  void tick();
}

export async function stopCourseGenerationWorker(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  activeController?.abort(new Error("Server shutting down"));
}
