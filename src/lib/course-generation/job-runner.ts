import { Prisma, type CourseGenerationJob } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { createLogger } from "@openmaic/lib/logger";
import {
  generateClassroom,
  type ClassroomGenerationProgress,
  type GenerateClassroomInput,
} from "@openmaic/lib/server/classroom-generation";
import {
  buildMediaRepairOutlines,
  generateClassroomAssets,
  type ClassroomAssetGenerationProgress,
} from "@openmaic/lib/server/classroom-asset-generation";
import { splitGeneratedClassroom } from "@/lib/openmaic-bridge/server-classroom-split";
import { linkClassroomToCourse } from "@/lib/openmaic-bridge/course-linker";
import {
  isAbortError,
  withGenerationRetry,
} from "@openmaic/lib/generation/generation-retry";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { hasExactKnowledgeLecturePageBudget, isNewSystemAiTimingPlan } from "@/lib/classroom/new-system-course";
import {
  adaptiveBranchGenerationSignature,
  selectAdaptiveBranchesForGeneration,
} from "@/lib/teacher/adaptive-resource-generation";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { runWithCourseGenerationLlmContext } from "@/lib/course-generation/llm-concurrency";
import type { Scene } from "@openmaic/lib/types/stage";
import {
  fingerprintSceneOutline,
  restoreSceneCheckpoint,
  type PageCheckpointSnapshot,
} from "@/lib/course-generation/page-checkpoints";
import {
  ADAPTIVE_RESOURCE_CONCURRENCY,
  runAdaptiveResourcePool,
} from "@/lib/course-generation/adaptive-resource-pool";
import type { AdaptivePreparedBranchResource } from "@/lib/session/types";
import { buildAdaptiveResourceRequirement } from "@/lib/adaptive-learning";
import { ensureTeachingToolPlans } from "@/lib/openmaic/generation/teaching-tool-plan";
import {
  COURSE_COVER_GENERATION_SPEC,
} from "@/lib/course-cover";
import { generateCourseCoverImageOnServer } from "@/lib/course-cover-server";
import {
  createManagedCourseGenerationRecoveryRequest,
  deserializeCourseGenerationFailure,
  serializeCourseGenerationFailure,
} from "@/lib/course-generation/failure-policy";
import {
  auditCourseGeneratedResources,
  type CourseResourceIssue,
} from "@/lib/course-generation/resource-audit-server";

const log = createLogger("CourseGenerationWorker");
const POLL_INTERVAL_MS = 1_500;
const STALE_AFTER_MS = 30 * 60 * 1_000;
const MAX_STORED_EVENTS = 80;
const FINAL_MEDIA_REPAIR_DELAYS_MS = [15_000, 60_000] as const;

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

async function waitForResourceRepair(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type StoredCheckpointState = {
  preparedOutlines: SceneOutline[];
  checkpoints: Map<string, PageCheckpointSnapshot>;
};

async function loadCheckpointState(jobId: string): Promise<StoredCheckpointState> {
  const [jobRows, checkpointRows] = await Promise.all([
    prisma.$queryRaw<Array<{ preparedOutlines: Prisma.JsonValue | null }>>`
      SELECT "preparedOutlines"
      FROM "CourseGenerationJob"
      WHERE "id" = ${jobId}
    `,
    prisma.$queryRaw<Array<{
      pageKey: string;
      outlineFingerprint: string;
      scene: Prisma.JsonValue;
    }>>`
      SELECT "pageKey", "outlineFingerprint", "scene"
      FROM "CourseGenerationPageCheckpoint"
      WHERE "jobId" = ${jobId}
    `,
  ]);
  const rawOutlines = jobRows[0]?.preparedOutlines;
  const preparedOutlines = Array.isArray(rawOutlines)
    ? rawOutlines as unknown as SceneOutline[]
    : [];
  const checkpoints = new Map<string, PageCheckpointSnapshot>();
  for (const row of checkpointRows) {
    checkpoints.set(row.pageKey, {
      pageKey: row.pageKey,
      outlineFingerprint: row.outlineFingerprint,
      scene: row.scene as unknown as Scene,
    });
  }
  return { preparedOutlines, checkpoints };
}

async function persistPreparedOutlines(jobId: string, outlines: SceneOutline[]): Promise<void> {
  const value = JSON.stringify(outlines);
  await prisma.$executeRaw`
    UPDATE "CourseGenerationJob"
    SET "preparedOutlines" = CAST(${value} AS JSONB)
    WHERE "id" = ${jobId}
  `;
}

async function persistSceneCheckpoint(
  jobId: string,
  outline: SceneOutline,
  scene: Scene,
): Promise<PageCheckpointSnapshot> {
  const checkpoint: PageCheckpointSnapshot = {
    pageKey: outline.id,
    outlineFingerprint: fingerprintSceneOutline(outline),
    scene,
  };
  const sceneJson = JSON.stringify(scene);
  await prisma.$executeRaw`
    INSERT INTO "CourseGenerationPageCheckpoint"
      ("id", "jobId", "pageKey", "outlineFingerprint", "outlineOrder", "scene", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${jobId}, ${checkpoint.pageKey}, ${checkpoint.outlineFingerprint}, ${outline.order}, CAST(${sceneJson} AS JSONB), NOW(), NOW())
    ON CONFLICT ("jobId", "pageKey") DO UPDATE SET
      "outlineFingerprint" = EXCLUDED."outlineFingerprint",
      "outlineOrder" = EXCLUDED."outlineOrder",
      "scene" = EXCLUDED."scene",
      "updatedAt" = NOW()
  `;
  return checkpoint;
}

export async function resetCourseGenerationCheckpoints(jobId: string): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "CourseGenerationJob"
      SET "preparedOutlines" = NULL
      WHERE "id" = ${jobId}
    `,
    prisma.$executeRaw`
      DELETE FROM "CourseGenerationPageCheckpoint"
      WHERE "jobId" = ${jobId}
    `,
  ]);
}

export type PersistedCourseGenerationRequest = GenerateClassroomInput & {
  courseId: string;
  systemMode?: "new";
  courseTitle?: string;
  moduleTimingPlan?: unknown;
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
    case "generating_outlines": return "正在生成课程结构与页面安排";
    case "generating_scenes":
      return progress.scenesGenerated > 0 && progress.totalScenes
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

function estimateRemainingSeconds(input: {
  startedAt: Date;
  scenePhaseStartedAt: number | null;
  scenesGenerated: number;
  totalScenes: number;
  progress: number;
  baselineSeconds: number;
}): number {
  const elapsed = Math.max(1, (Date.now() - input.startedAt.getTime()) / 1_000);
  if (input.scenesGenerated > 0 && input.totalScenes > input.scenesGenerated) {
    const phaseElapsed = input.scenePhaseStartedAt
      ? Math.max(1, (Date.now() - input.scenePhaseStartedAt) / 1_000)
      : elapsed;
    const observedWallSecondsPerPage = phaseElapsed / input.scenesGenerated;
    const secondsPerPage = Math.min(75, Math.max(25, observedWallSecondsPerPage));
    return Math.max(45, Math.round((input.totalScenes - input.scenesGenerated) * secondsPerPage + 60));
  }
  if (input.progress >= 90) return Math.max(20, Math.round(elapsed * 0.08));
  return Math.max(45, Math.round(input.baselineSeconds - elapsed));
}

async function persistProgress(
  job: CourseGenerationJob,
  progress: ClassroomGenerationProgress,
  scenePhaseStartedAt: number | null,
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
  };
  const events = [...asEvents(job.events), event].slice(-MAX_STORED_EVENTS);
  const remaining = estimateRemainingSeconds({
    startedAt: job.startedAt ?? job.createdAt,
    scenePhaseStartedAt,
    scenesGenerated: event.scenesGenerated,
    totalScenes: event.totalScenes,
    progress: event.progress,
    baselineSeconds: estimatePersistedCourseGenerationSeconds({
      totalScenes: event.totalScenes,
      adaptiveBranchCount: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).adaptiveBranchCount,
      enableImageGeneration: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableImageGeneration,
      enableVideoGeneration: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableVideoGeneration,
      enableTTS: (job.request as unknown as Partial<PersistedCourseGenerationRequest>).enableTTS,
    }),
  });
  const updated = await prisma.courseGenerationJob.update({
    where: { id: job.id },
    data: {
      step: event.step,
      progress: event.progress,
      message,
      scenesGenerated: event.scenesGenerated,
      totalScenes: event.totalScenes,
      estimatedRemainingSeconds: remaining,
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
  const updated = await prisma.courseGenerationJob.update({
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
  },
): Promise<void> {
  const event: CourseGenerationJobEvent = {
    step: input.step,
    progress: Math.max(job.progress, input.progress),
    message: input.message,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    ts: Date.now(),
  };
  const updated = await prisma.courseGenerationJob.update({
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
    const coverImageUrl = await generateCourseCoverImageOnServer(course, signal);
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
    return await withGenerationRetry(async () => {
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
        knowledgePointIds: branch.anchorKnowledgePointIds,
        ttsPolicy: "target-duration",
        resourceTypes: branch.sceneType === "interactive" ? ["interactive-demo"] : ["ppt"],
        narrationMode: "embedded-segment",
      }])[0];
      const generated = await generateClassroom({
        courseTitle: `${course.name} · ${branch.title}`,
        requirement: buildAdaptiveResourceRequirement(course.name, branch, plan),
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
        error.isRetryable = true;
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
    }, {
      label: `adaptive resource ${branch.id}`,
      maxRetries: 2,
      signal,
    });
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
  const candidate = await prisma.courseGenerationJob.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const now = new Date();
  const claimed = await prisma.courseGenerationJob.updateMany({
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
    ? prisma.courseGenerationJob.findUnique({ where: { id: candidate.id } })
    : null;
}

/**
 * Starts the already-persisted classroom job in request-bound workstation
 * environments. The durable queue remains the source of truth, so the quick
 * generator and the detailed generator still execute the exact same job.
 */
export async function startQueuedCourseGeneration(courseId: string): Promise<CourseGenerationJob | null> {
  const candidate = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!candidate || candidate.status !== "queued") return candidate;
  const now = new Date();
  const claimed = await prisma.courseGenerationJob.updateMany({
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
  const job = await prisma.courseGenerationJob.findUnique({ where: { id: candidate.id } });
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
  const candidate = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!candidate || candidate.status !== "queued") return candidate;
  const now = new Date();
  const claimed = await prisma.courseGenerationJob.updateMany({
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
  const job = await prisma.courseGenerationJob.findUnique({ where: { id: candidate.id } });
  if (claimed.count === 1 && job) await runJob(job);
  return prisma.courseGenerationJob.findUnique({ where: { id: candidate.id } });
}

export function managedCourseGenerationRetryDelayMs(recoveryCount: number): number {
  return recoveryCount <= 1 ? 2_000 : 8_000;
}

function scheduleManagedCourseGenerationRetry(courseId: string, recoveryCount: number): void {
  const retryTimer = setTimeout(() => {
    void startQueuedCourseGeneration(courseId).catch((error) => {
      log.error(`Failed to schedule managed classroom-generation recovery for ${courseId}`, error);
    });
  }, managedCourseGenerationRetryDelayMs(recoveryCount));
  retryTimer.unref?.();
}

export async function resumeRecoverableCourseGenerationJob(
  courseId: string,
): Promise<CourseGenerationJob | null> {
  const job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!job || job.status !== "failed" || !job.error) return job;
  const completedPageCount = await prisma.courseGenerationPageCheckpoint.count({
    where: { jobId: job.id },
  });
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  const recoveryRequest = createManagedCourseGenerationRecoveryRequest(
    request,
    deserializeCourseGenerationFailure(job.error),
  );
  if (!recoveryRequest) return job;
  const recoveryCount = recoveryRequest.managedRecoveryCount ?? 1;
  const updated = await prisma.courseGenerationJob.updateMany({
    where: { id: job.id, status: "failed" },
    data: {
      status: "queued",
      step: "recovering_scenes",
      message: `页面生成服务短暂中止，正在从 ${completedPageCount} 个已完成页面继续（第 ${recoveryCount} 次）`,
      request: recoveryRequest as unknown as Prisma.InputJsonValue,
      error: null,
      completedAt: null,
      estimatedRemainingSeconds: 120,
      lastHeartbeatAt: new Date(),
      version: { increment: 1 },
    },
  });
  if (updated.count === 1) scheduleManagedCourseGenerationRetry(courseId, recoveryCount);
  return prisma.courseGenerationJob.findUnique({ where: { id: job.id } });
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
  const job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!job || job.status !== "failed") return job;
  const completedPageCount = await prisma.courseGenerationPageCheckpoint.count({
    where: { jobId: job.id } });
  // 早期失败(如大纲校验)可能没有任何已完成页面或 checkpoint;此时仍需
  // 重新入队并保留原请求,否则"从已完成页面继续"会静默无效果。
  // 若之前已持久化过大纲(preparedOutlines),续跑会自动复用它们。
  const message = completedPageCount > 0
    ? `正在从 ${completedPageCount} 个已完成页面继续生成`
    : "正在重新开始课程内容生成（此前尚无已完成的页面）";
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  await prisma.courseGenerationJob.updateMany({
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
  return prisma.courseGenerationJob.findUnique({ where: { id: job.id } });
}

async function runJob(job: CourseGenerationJob): Promise<void> {
  return runWithCourseGenerationLlmContext(() => runJobWithCourseGenerationContext(job));
}

async function runJobWithCourseGenerationContext(job: CourseGenerationJob): Promise<void> {
  const request = job.request as unknown as PersistedCourseGenerationRequest;
  const generationInput = { ...request };
  const courseId = generationInput.courseId;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).courseId;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).systemMode;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).moduleTimingPlan;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).adaptiveBranchCount;
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).managedRecoveryCount;
  const controller = new AbortController();
  activeController = controller;
  activeCourseId = courseId;
  let scenePhaseStartedAt: number | null = null;
  let workerWriteChain = Promise.resolve();
  const serializeWorkerWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const result = workerWriteChain.then(work, work);
    workerWriteChain = result.then(() => undefined, () => undefined);
    return result;
  };

  try {
    const checkpointState = await loadCheckpointState(job.id);
    const course = await getCourse(courseId);
    const timing = course?.content.moduleTimingPlan;
    const outlines = checkpointState.preparedOutlines.length ? checkpointState.preparedOutlines : generationInput.sceneOutlines ?? [];
    if (!course || !isNewSystemAiTimingPlan(timing, course.hours)
      || !hasExactKnowledgeLecturePageBudget(outlines, timing.totalMinutes)) {
      throw new Error("知识讲授时长必须占整课 20%–40%，且讲解与小测合计必须等于已确定预算。请重新规划知识讲授后生成，不可继续使用旧的超长页面或检查点。");
    }
    const generated = await generateClassroom(generationInput, {
      signal: controller.signal,
      preparedOutlines: checkpointState.preparedOutlines,
      onOutlinesPrepared: (outlines) => persistPreparedOutlines(job.id, outlines),
      loadSceneCheckpoint: (outline, _index, stageId) => restoreSceneCheckpoint(
        outline,
        checkpointState.checkpoints.get(outline.id),
        stageId,
      ),
      onSceneCompleted: async (outline, scene) => {
        const checkpoint = await persistSceneCheckpoint(job.id, outline, scene);
        checkpointState.checkpoints.set(outline.id, checkpoint);
      },
      onProgress: async (progress) => {
        if (progress.step === "generating_scenes" && scenePhaseStartedAt === null) {
          scenePhaseStartedAt = Date.now();
        }
        await serializeWorkerWrite(() => persistProgress(job, progress, scenePhaseStartedAt));
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
      stage: { id: generated.stage.id, name: generated.stage.name },
    };
    const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || "";
    const adaptivePromise = prepareAdaptiveResources(
      job,
      courseId,
      controller.signal,
      serializeWorkerWrite,
    );
    const assetPromise = (async () => {
      try {
        await generateClassroomAssets({
          ...generated.assetContext,
          baseUrl,
          studentClassroomId: split.studentClassroomId,
          studentScenes: split.studentScenes,
          teacherClassroomId: split.teacherClassroomId || undefined,
          teacherScenes: split.teacherScenes,
          signal: controller.signal,
          onProgress: (progress) => serializeWorkerWrite(() => persistWorkerPhase(job, {
              step: assetPhaseStep(progress),
              progress: progress.status === "completed" ? 99 : 98,
              message: progress.message,
              estimatedRemainingSeconds: progress.phase === "persisting" ? 20 : 60,
          })),
        });
      } catch (assetError) {
        if (controller.signal.aborted || isAbortError(assetError)) throw assetError;
        // Classroom content has already been durably linked. Optional provider
        // failures must not discard a long-running successful generation.
        log.error("Background classroom asset generation failed", assetError);
      }
    })();
    await Promise.all([adaptivePromise, assetPromise]);
    const coverStatus = await generateAndPersistCourseCover(
      job,
      courseId,
      controller.signal,
      serializeWorkerWrite,
    );
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "auditing_resources",
      progress: 99,
      message: "正在进行课程页面与配套资源完整性审校",
      estimatedRemainingSeconds: 15,
    }));
    let resourceAudit = await auditCourseGeneratedResources(courseId);
    for (const [repairIndex, delayMs] of FINAL_MEDIA_REPAIR_DELAYS_MS.entries()) {
      const mediaFailures = mediaFailuresFromAudit(resourceAudit.issues);
      if (mediaFailures.length === 0) break;
      await serializeWorkerWrite(() => persistWorkerPhase(job, {
        step: "repairing_media_resources",
        progress: 99,
        message: `检测到 ${mediaFailures.length} 项图片或视频尚未落盘，正在后台自动补齐（第 ${repairIndex + 1} 次）`,
        estimatedRemainingSeconds: Math.ceil(delayMs / 1_000) + 120,
      }));
      await waitForResourceRepair(delayMs, controller.signal);
      const repairOutlines = buildMediaRepairOutlines(
        generated.assetContext.outlines,
        mediaFailures,
      );
      await generateClassroomAssets({
        ...generated.assetContext,
        outlines: repairOutlines,
        baseUrl,
        studentClassroomId: split.studentClassroomId,
        studentScenes: split.studentScenes,
        teacherClassroomId: split.teacherClassroomId || undefined,
        teacherScenes: split.teacherScenes,
        enableImageGeneration: mediaFailures.some((failure) => failure.type === "image"),
        enableVideoGeneration: mediaFailures.some((failure) => failure.type === "video"),
        enableTTS: false,
        signal: controller.signal,
        onProgress: (progress) => serializeWorkerWrite(() => persistWorkerPhase(job, {
          step: assetPhaseStep(progress),
          progress: 99,
          message: progress.message,
          estimatedRemainingSeconds: 90,
        })),
      });
      resourceAudit = await auditCourseGeneratedResources(courseId);
    }
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "generation_resources_ready",
      progress: 99,
      message: resourceAudit.issues.length > 0
        ? `课程主体已经完成，仍有 ${resourceAudit.issues.length} 项资源在自动重试后未就绪`
        : coverStatus === "ready"
          ? "课程封面、个性化学习资源与课堂素材已经就绪"
          : "课堂资源已经就绪，课程封面需要稍后补充",
      estimatedRemainingSeconds: 20,
    }));

    const finalEvent: CourseGenerationJobEvent = {
      step: "completed",
      progress: 100,
      message: resourceAudit.issues.length > 0
        ? `课程主体已生成，${resourceAudit.issues.length} 项配套资源需要在预览页继续处理`
        : "课程内容与配套资源已完整生成",
      scenesGenerated: split.studentSceneCount,
      totalScenes: Math.max(job.totalScenes, split.studentSceneCount),
      ts: Date.now(),
    };
    await prisma.courseGenerationJob.update({
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
        events: [...asEvents(job.events), finalEvent].slice(-MAX_STORED_EVENTS) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
        version: { increment: 1 },
      },
    });

  } catch (error) {
    if (cancellationRequested.has(courseId)) {
      await prisma.courseGenerationJob.update({
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
      await prisma.courseGenerationJob.updateMany({
        where: { id: job.id, status: "running" },
        data: { status: "queued", step: "queued", message: "等待服务器继续生成", lastHeartbeatAt: new Date() },
      });
      return;
    }
    const completedPageCount = await prisma.courseGenerationPageCheckpoint.count({
      where: { jobId: job.id },
    });
    const recoveryRequest = createManagedCourseGenerationRecoveryRequest(
      request,
      error,
    );
    if (recoveryRequest) {
      const recoveryCount = recoveryRequest.managedRecoveryCount ?? 1;
      log.warn(
        `Managed classroom-generation recovery ${recoveryCount} queued for ${courseId} from ${completedPageCount} checkpoints`,
        error,
      );
      await prisma.courseGenerationJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          step: "recovering_scenes",
          message: `第 ${job.scenesGenerated + 1} 个页面生成服务短暂中止，正在从 ${completedPageCount} 个已完成页面继续`,
          request: recoveryRequest as unknown as Prisma.InputJsonValue,
          error: null,
          completedAt: null,
          estimatedRemainingSeconds: 120,
          lastHeartbeatAt: new Date(),
          version: { increment: 1 },
        },
      });
      scheduleManagedCourseGenerationRetry(courseId, recoveryCount);
      return;
    }
    log.error(`Course generation job ${job.id} failed`, error);
    await prisma.courseGenerationJob.update({
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
  const job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return job;
  if (job.status === "queued") {
    return prisma.courseGenerationJob.update({
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
  const cancelling = await prisma.courseGenerationJob.update({
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
  await prisma.courseGenerationJob.updateMany({
    where: {
      status: "running",
      OR: [
        { lastHeartbeatAt: null },
        { lastHeartbeatAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      ],
    },
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
