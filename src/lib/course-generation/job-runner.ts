import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { CourseGenerationJob } from "@/lib/course-generation/job-storage";
import { COURSE_FINALIZATION_STEP, loadGenerationCheckpoints, saveGenerationCheckpoint, resetGenerationCheckpoints, resetPreparedOutlinesCheckpoint, countGenerationPageCheckpoints } from "./checkpoint-storage";
import { contentGenerationJobs } from "@/lib/course-generation/job-storage";
import { createLogger } from "@openmaic/lib/logger";
import {
  generateClassroom,
  type ClassroomGenerationProgress,
  type GenerateClassroomInput,
} from "@openmaic/lib/server/classroom-generation";
import {
  generateClassroomAssets,
  type ClassroomAssetGenerationProgress,
} from "@openmaic/lib/server/classroom-asset-generation";
import { reusePersistedSceneAssets } from "@openmaic/lib/server/classroom-asset-recovery";
import { readClassroom } from "@openmaic/lib/server/classroom-storage";
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
  fingerprintGenerationValue,
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
import { TEMPLATE_COVER_MEDIA_PREFIX } from "@/lib/platform/classroom-cover";
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
import { COURSE_DESIGN_WORKSPACE_SECTIONS } from "@/lib/course-design/workspace";
import type {
  ClassroomGenerationScope,
  TestLessonGenerationTarget,
} from "@/lib/course-generation/generation-scope";

const log = createLogger("CourseGenerationWorker");
const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 5_000;
const LEASE_DURATION_MS = 30_000;
const WORKER_ID = `course-content:${process.pid}:${randomUUID()}`;
const MAX_STORED_EVENTS = 80;

async function hydrateTextbookFigureBytes(
  images: NonNullable<GenerateClassroomInput["textbookImages"]> | undefined,
): Promise<NonNullable<GenerateClassroomInput["textbookImages"]> | undefined> {
  if (!images?.length) return undefined;
  const assetIds = [...new Set(images.map((image) => image.assetId))];
  const assets = await prisma.fileAsset.findMany({
    where: { id: { in: assetIds }, deletedAt: null },
    select: { id: true, storageKey: true, mimeType: true, size: true },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const uploadDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
  const hydrated = await Promise.all(images.map(async (image) => {
    const asset = assetById.get(image.assetId);
    const invalidReason = !asset
      ? "文件记录不存在或已删除"
      : !asset.mimeType.startsWith("image/")
        ? `文件类型无效：${asset.mimeType}`
        : path.basename(asset.storageKey) !== asset.storageKey
          ? "存储路径无效"
          : Number(asset.size) > 16 * 1024 * 1024
            ? "文件超过 16MB"
            : undefined;
    if (invalidReason) {
      if (image.required) throw new Error(`必用教材原图 ${image.figureId} 不可读取：${invalidReason}`);
      return image;
    }
    if (!asset) return image;
    const bytes = await readFile(/* turbopackIgnore: true */ path.join(uploadDir, asset.storageKey)).catch(() => null);
    if (!bytes || bytes.byteLength !== Number(asset.size)) {
      if (image.required) throw new Error(`必用教材原图 ${image.figureId} 不可读取：文件缺失或大小不一致`);
      return image;
    }
    return {
      ...image,
      publicSrc: image.src,
      src: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
    };
  }));
  return hydrated;
}
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
  courseFinalization: unknown;
};

type TeachingSectionCheckpointSnapshot = {
  schemaVersion: 1;
  sectionKey: string;
  inputFingerprint: string;
  modelFingerprint: string;
  briefs: Array<[string, unknown]>;
};

type GeneratedClassroomSnapshot = Awaited<ReturnType<typeof generateClassroom>>;
type SplitClassroomSnapshot = Awaited<ReturnType<typeof splitGeneratedClassroom>>;
type CourseFinalizationCheckpoint = {
  schemaVersion: 1;
  inputFingerprint: string;
  generated: GeneratedClassroomSnapshot;
  split?: SplitClassroomSnapshot;
  courseLinkedAt?: string;
  assetsCompletedAt?: string;
  teachingTimingAudit?: Awaited<ReturnType<typeof generateClassroomAssets>>;
};

/** Finalized output belongs to the submitted teaching input, not its expanded pages. */
export function fingerprintCourseFinalizationRequest(request: PersistedCourseGenerationRequest): string {
  const teachingRequest = { ...request };
  delete teachingRequest.managedRecoveryCount;
  return fingerprintGenerationValue({ policy: "course-finalization-v2", request: teachingRequest });
}

export function restoreCourseFinalizationCheckpoint(
  value: unknown,
  request: PersistedCourseGenerationRequest,
  preparedOutlines: readonly SceneOutline[],
): CourseFinalizationCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Partial<CourseFinalizationCheckpoint>;
  if (checkpoint.schemaVersion !== 1) return null;
  if (!checkpoint.generated || !Array.isArray(checkpoint.generated.scenes)
    || !checkpoint.generated.stage || typeof checkpoint.generated.stage.id !== "string") return null;
  if (checkpoint.split && (typeof checkpoint.split.studentClassroomId !== "string"
    || !Array.isArray(checkpoint.split.studentScenes)
    || !Array.isArray(checkpoint.split.teacherScenes))) return null;
  if (checkpoint.inputFingerprint === fingerprintCourseFinalizationRequest(request)) {
    return checkpoint as CourseFinalizationCheckpoint;
  }

  // Legacy hashes included mutable recovery bookkeeping and the current
  // preparation result. Accept only a reconstructable hash of this request,
  // then verify the generated output covers exactly its selected parent pages.
  const originalRequest = { ...request };
  delete originalRequest.managedRecoveryCount;
  const variants = [request, originalRequest, { ...originalRequest, managedRecoveryCount: 0 }];
  const outlineVariants = [request.sceneOutlines ?? [], preparedOutlines];
  const matchingInput = variants.some((candidate) => outlineVariants.some((outlines) =>
    checkpoint.inputFingerprint === fingerprintGenerationValue({ request: candidate, outlines }),
  ));
  if (!matchingInput) return null;
  const roots = (outline: SceneOutline) => outline.spatialParentId ?? outline.id;
  const selected = request.generationScope === "test-lesson"
    ? new Set(request.testLesson?.sceneOutlineIds ?? []) : null;
  const expected = (request.sceneOutlines ?? []).filter((outline) => !selected || selected.has(roots(outline)));
  const actual = checkpoint.generated.assetContext?.outlines;
  if (!expected.length || !Array.isArray(actual) || !actual.length) return null;
  const expectedRoots = new Set(expected.map(roots));
  if (new Set(actual.map(roots)).size !== expectedRoots.size
    || actual.some((outline) => !expectedRoots.has(roots(outline)))
    || new Set(actual.map((outline) => outline.id)).size !== actual.length) return null;
  const duration = (pages: readonly SceneOutline[]) => pages.reduce(
    (sum, outline) => sum + (outline.targetDurationSec ?? outline.estimatedDuration ?? 0), 0,
  );
  for (const parent of expectedRoots) {
    if (Math.abs(duration(expected.filter((outline) => roots(outline) === parent))
      - duration(actual.filter((outline) => roots(outline) === parent))) > 0.001) return null;
  }
  const sceneOutlines = new Set(checkpoint.generated.scenes.map((scene) => scene.outlineId));
  if (sceneOutlines.size !== actual.length || actual.some((outline) => !sceneOutlines.has(outline.id))) return null;
  return checkpoint as CourseFinalizationCheckpoint;
}

/** The resume boundary must be resolved before any content model is invoked. */
export async function restoreOrGenerateFinalizedClassroom(input: {
  checkpoint: unknown;
  request: PersistedCourseGenerationRequest;
  preparedOutlines: readonly SceneOutline[];
  generate: () => Promise<GeneratedClassroomSnapshot>;
  previousScenes?: ReadonlyMap<string, Scene>;
}) {
  const inputFingerprint = fingerprintCourseFinalizationRequest(input.request);
  const restoredFinalization = restoreCourseFinalizationCheckpoint(input.checkpoint, input.request, input.preparedOutlines);
  const authored = restoredFinalization?.generated ?? await input.generate();
  // A grouped page can be rebuilt from stage checkpoints without passing through
  // loadSceneCheckpoint. Promote its accepted assets at the common finalization
  // boundary, before the new classroom is split and its media is generated.
  const generated = input.previousScenes?.size ? {
    ...authored,
    scenes: authored.scenes.map((scene) => reusePersistedSceneAssets(scene, input.previousScenes?.get(scene.id))),
  } : authored;
  return { inputFingerprint, restoredFinalization, generated };
}

function stageCheckpointKey(pageKey: string, stage: SceneGenerationCheckpointStage): string {
  return `${pageKey}:${stage}`;
}

export function hasExactTestLessonBudget(
  outlines: readonly SceneOutline[],
  testLesson: { sceneOutlineIds: readonly string[]; durationSeconds: number } | undefined,
  fullSceneCount: number | undefined,
): boolean {
  if (!testLesson) return false;
  const requested = new Set(testLesson.sceneOutlineIds);
  const parentId = (outline: SceneOutline) => outline.spatialParentId ?? outline.id;
  const fullParents = new Set(outlines.map(parentId));
  const selected = outlines.filter((outline) => requested.has(parentId(outline)));
  const selectedParents = new Set(selected.map(parentId));
  return requested.size > 0
    && requested.size === testLesson.sceneOutlineIds.length
    && selectedParents.size === requested.size
    && fullParents.size === fullSceneCount
    && new Set(selected.map((outline) => outline.id)).size === selected.length
    && hasExactKnowledgeLecturePageBudget(selected, testLesson.durationSeconds / 60);
}

export function hasExactUpdateTargetBudget(
  outlines: readonly SceneOutline[],
  confirmedOutlines: readonly SceneOutline[],
  affectedOutlineIds: readonly string[],
): boolean {
  const affected = new Set(affectedOutlineIds);
  const expected = confirmedOutlines.filter((outline) => affected.has(outline.id));
  const actualIds = new Set(outlines.map((outline) => outline.id));
  return affected.size === affectedOutlineIds.length
    && expected.length === affected.size
    && outlines.length === affected.size
    && actualIds.size === outlines.length
    && affectedOutlineIds.every((id) => actualIds.has(id))
    && hasExactKnowledgeLecturePageBudget(
      outlines,
      expected.reduce(
        (sum, outline) => sum + (outline.targetDurationSec ?? outline.estimatedDuration ?? 0),
        0,
      ) / 60,
    );
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
    courseFinalization: stored.courseFinalization,
  };
}

async function persistPreparedOutlines(jobId: string, executionId: string, outlines: SceneOutline[]): Promise<void> {
  await saveGenerationCheckpoint(jobId, "prepared-outlines", outlines, { executionId });
}

async function persistSceneCheckpoint(
  jobId: string,
  outline: SceneOutline,
  scene: Scene,
  modelFingerprint: string,
  inputFingerprint: string,
  executionId: string,
): Promise<PageCheckpointSnapshot> {
  const checkpoint: PageCheckpointSnapshot = {
    pageKey: outline.id,
    outlineFingerprint: fingerprintSceneOutline(outline),
    modelFingerprint,
    inputFingerprint,
    scene,
  };
  await saveGenerationCheckpoint(jobId, `page:${checkpoint.pageKey}`, checkpoint, { executionId });
  return checkpoint;
}

async function persistSceneStageCheckpoint(input: {
  jobId: string;
  outline: SceneOutline;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
  payload: unknown;
  executionId: string;
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
    { executionId: input.executionId },
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
  executionId: string;
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
    { executionId: input.executionId },
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
  /** Bounded post-generation update. It produces a candidate classroom and never replaces the live draft automatically. */
  updateTarget?: {
    baseDesignRevision: number;
    baseClassroomId: string;
    affectedSectionIds: string[];
    affectedOutlineIds: string[];
  };
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
  stageProgress?: ClassroomGenerationProgress["stageProgress"];
  stageDetail?: ClassroomGenerationProgress["stage"];
};

let workerStarted = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let activeController: AbortController | null = null;
let activeCourseId: string | null = null;
const activeRuns = new Set<Promise<void>>();
const cancellationRequested = new Set<string>();

class CourseGenerationExecutionLostError extends Error {
  constructor() {
    super("Course generation execution lease was lost");
    this.name = "CourseGenerationExecutionLostError";
  }
}

function leaseDeadline(now = Date.now()): Date {
  return new Date(now + LEASE_DURATION_MS);
}

async function assertCourseGenerationExecution(job: CourseGenerationJob): Promise<void> {
  if (!job.executionId) throw new CourseGenerationExecutionLostError();
  const current = await contentGenerationJobs.findUnique({ where: { id: job.id } });
  if (current?.status !== "running" || current.executionId !== job.executionId) {
    throw new CourseGenerationExecutionLostError();
  }
}

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
    stageProgress: progress.stageProgress,
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
    where: { id: job.id, status: "running", executionId: job.executionId },
    data: {
      step: event.step,
      progress: event.progress,
      message,
      scenesGenerated: event.scenesGenerated,
      totalScenes: event.totalScenes,
      estimatedRemainingSeconds: remaining,
      activePages: (progress.activePages ?? []) as unknown as Prisma.InputJsonValue,
      stageProgress: (progress.stageProgress ?? job.stageProgress ?? []) as unknown as Prisma.InputJsonValue,
      currentStage: progress.stage ?? null,
      events: events as unknown as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: leaseDeadline(),
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
    where: { id: job.id, status: "running", executionId: job.executionId },
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
      leaseExpiresAt: leaseDeadline(),
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
    where: { id: job.id, status: "running", executionId: job.executionId },
    data: {
      step: input.step,
      progress: event.progress,
      message: input.message,
      estimatedRemainingSeconds: input.estimatedRemainingSeconds ?? job.estimatedRemainingSeconds,
      events: [...asEvents(job.events), event].slice(-MAX_STORED_EVENTS) as unknown as Prisma.InputJsonValue,
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: leaseDeadline(),
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
    const coverImageUrl = await generateCourseCoverImageOnServer(
      course,
      `${TEMPLATE_COVER_MEDIA_PREFIX}${courseId}`,
      signal,
    );
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
  const now = new Date();
  const candidate = await contentGenerationJobs.findFirst({
    where: {
      OR: [
        { status: "queued" },
        { status: "running", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  return claimCourseGenerationJob(candidate, now);
}

async function claimCourseGenerationJob(
  candidate: CourseGenerationJob,
  now = new Date(),
): Promise<CourseGenerationJob | null> {
  const executionId = randomUUID();
  const recovering = candidate.status === "running";
  const claimed = await contentGenerationJobs.updateMany({
    where: {
      id: candidate.id,
      version: candidate.version,
      ...(recovering
        ? { status: "running", executionId: candidate.executionId, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }
        : { status: "queued" }),
    },
    data: {
      status: "running",
      step: recovering ? "recovering_scenes" : "initializing",
      message: recovering ? "检测到执行租约已过期，正在从已保存进度继续" : "正在启动课程生成任务",
      startedAt: candidate.startedAt ?? now,
      lastHeartbeatAt: now,
      executionId,
      executionOwner: WORKER_ID,
      leaseExpiresAt: leaseDeadline(now.getTime()),
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
  const job = await claimCourseGenerationJob(candidate);
  if (job) void runJob(job);
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
  const job = await claimCourseGenerationJob(candidate);
  if (job) await runJob(job);
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
  const queued = await contentGenerationJobs.replace({
    where: { id: job.id, status: "failed", version: job.version },
    checkpointPolicy: { prefixes: ["stage-attempt:"] },
    data: {
      status: "queued",
      step: "recovering_scenes",
      message,
      // Stage counters are presentation state, not durable page evidence.
      // Rebuild them from the retained stage/page checkpoints on this run.
      activePages: [],
      stageProgress: [],
      currentStage: null,
      currentCall: Prisma.JsonNull,
      request: {
        ...request,
        managedRecoveryCount: 0,
      } as unknown as Prisma.InputJsonValue,
      error: null,
      completedAt: null,
      estimatedRemainingSeconds: 600,
      lastHeartbeatAt: new Date(),
      executionId: null,
      executionOwner: null,
      leaseExpiresAt: null,
      version: { increment: 1 },
    },
  });
  // An open canonical preview has stopped polling a failed job. Publish the
  // normal course-version invalidation only after the guarded requeue commits,
  // so that preview can discover the new active lifecycle without a focus event.
  // The identity updater preserves every adopted teaching field and classroom ID.
  if (queued.status === "queued") await updateCourse(courseId, (current) => current);
  return contentGenerationJobs.findUnique({ where: { id: job.id } });
}

function runJob(job: CourseGenerationJob): Promise<void> {
  const execution = runWithCourseGenerationLlmContext(
    () => runJobWithCourseGenerationContext(job),
    {
      onTokenUsage: async (totalTokens) => {
        try {
          await contentGenerationJobs.update({
            where: { id: job.id, status: "running", executionId: job.executionId },
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
  activeRuns.add(execution);
  return execution.finally(() => activeRuns.delete(execution));
}

async function runJobWithCourseGenerationContext(job: CourseGenerationJob): Promise<void> {
  const executionId = job.executionId;
  if (!executionId) throw new CourseGenerationExecutionLostError();
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
  delete (generationInput as Partial<PersistedCourseGenerationRequest>).updateTarget;
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
  const heartbeatTimer = setInterval(() => {
    const now = new Date();
    void contentGenerationJobs.updateMany({
      where: { id: job.id, status: "running", executionId },
      data: { lastHeartbeatAt: now, leaseExpiresAt: leaseDeadline(now.getTime()) },
    }).then(({ count }) => {
      if (count === 0 && !controller.signal.aborted) {
        controller.abort(new CourseGenerationExecutionLostError());
      }
    }).catch((error) => log.warn("Unable to renew course-generation lease", error));
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  try {
    generationInput.textbookImages = await hydrateTextbookFigureBytes(generationInput.textbookImages);
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
    const testLessonIdsMatch = !isTestLesson || hasExactTestLessonBudget(
      outlines, request.testLesson, request.fullSceneCount,
    );
    const updateBudgetMatches = !request.updateTarget || hasExactUpdateTargetBudget(
      outlines,
      course?.content._openmaicSceneOutlines as SceneOutline[] ?? [],
      request.updateTarget.affectedOutlineIds,
    );
    if (!course || !isNewSystemAiTimingPlan(timing, course.hours, course.content.stagePlan)
      || !testLessonIdsMatch
      || !updateBudgetMatches
      || (!request.updateTarget && !hasExactKnowledgeLecturePageBudget(outlines, timing?.totalMinutes ?? 0))) {
      throw new Error("知识讲授必须符合已确认的课程时间预算，且讲解与小测合计必须等于该预算。资源包课程以教案分钟数为准，请重新规划后生成，不可继续使用不匹配的页面或检查点。");
    }
    const previousClassroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
    const previousClassroom = previousClassroomId ? await readClassroom(previousClassroomId) : null;
    const previousScenes = new Map(previousClassroom?.scenes.map((scene) => [scene.id, scene]) ?? []);
    const { inputFingerprint: finalizationFingerprint, restoredFinalization, generated } = await restoreOrGenerateFinalizedClassroom({
      checkpoint: checkpointState.courseFinalization,
      request,
      preparedOutlines: outlines,
      previousScenes,
      generate: () => generateClassroom(generationInput, {
      signal: controller.signal,
      initialStageProgress: Array.isArray(job.stageProgress)
        ? job.stageProgress as unknown as NonNullable<ClassroomGenerationProgress["stageProgress"]>
        : undefined,
      generationOutlineIds: isTestLesson ? request.testLesson?.sceneOutlineIds : undefined,
      preparedOutlines: checkpointState.preparedOutlines,
      onOutlinesPrepared: (outlines) => persistPreparedOutlines(job.id, executionId, outlines),
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
        await saveGenerationCheckpoint(job.id, `teaching-section:${sectionKey}`, checkpoint, { executionId });
        checkpointState.teachingSectionCheckpoints.set(sectionKey, checkpoint);
      },
      loadSceneCheckpoint: (outline, _index, stageId, modelFingerprint, inputFingerprint) => {
        const restored = restoreSceneCheckpoint(
          outline, checkpointState.checkpoints.get(outline.id), stageId, modelFingerprint, inputFingerprint,
        );
        return restored ? reusePersistedSceneAssets(restored, previousScenes.get(restored.id)) : null;
      },
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
          executionId,
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
          executionId,
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
          executionId,
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
      }),
    });
    if (!restoredFinalization) {
      await saveGenerationCheckpoint(job.id, COURSE_FINALIZATION_STEP, {
        schemaVersion: 1,
        inputFingerprint: finalizationFingerprint,
        generated,
      } satisfies CourseFinalizationCheckpoint, { executionId });
    }
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "separating_classrooms",
      progress: 91,
      message: "正在拆分学生课堂与教师授课资源",
      estimatedRemainingSeconds: 180,
    }));
    const split = restoredFinalization?.split ?? await splitGeneratedClassroom({
      stage: generated.stage,
      scenes: generated.scenes,
      courseName: request.courseTitle,
      pblMode: false,
      signal: controller.signal,
    });
    // Asset writes are newer than pre-asset finalization checkpoints. Reuse
    // their durable scenes instead of replacing successful clips on resume.
    if (restoredFinalization?.split) {
      const student = await readClassroom(split.studentClassroomId);
      if (student) split.studentScenes = student.scenes;
      if (split.teacherClassroomId) {
        const teacher = await readClassroom(split.teacherClassroomId);
        if (teacher) split.teacherScenes = teacher.scenes;
      }
    }
    if (!restoredFinalization?.split) {
      await saveGenerationCheckpoint(job.id, COURSE_FINALIZATION_STEP, {
        schemaVersion: 1,
        inputFingerprint: finalizationFingerprint,
        generated,
        split,
      } satisfies CourseFinalizationCheckpoint, { executionId });
    }
    if (request.updateTarget) {
      await assertCourseGenerationExecution(job);
      const baseUrl = process.env.PUBLIC_BASE_URL?.trim() || "";
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
          progress: progress.status === "completed" ? 99 : 96,
          message: progress.message,
          estimatedRemainingSeconds: progress.phase === "persisting" ? 20 : 60,
          assetPhaseStatus: progress.status,
          assetCompleted: progress.completed,
          assetTotal: progress.total,
        })),
      };
      await generateClassroomAssets(assetInput);
      const candidateId = `candidate-${job.id}-${Date.now()}`;
      await updateCourse(courseId, (current) => {
        const revision = current.content.designWorkspaceRevision;
        const currentClassroomId = current.aiLearningClassroomId || current.content._openmaicClassroomId;
        if ((revision?.revision ?? 0) !== request.updateTarget!.baseDesignRevision
          || currentClassroomId !== request.updateTarget!.baseClassroomId) {
          throw new Error("局部更新完成前课程设计已经变化，候选结果未被采用，请按最新内容重新生成。");
        }
        const previousCandidates = revision?.candidateUpdates ?? [];
        return {
          ...current,
          content: {
            ...current.content,
            designWorkspaceRevision: {
              ...(revision ?? {
                schemaVersion: 1 as const,
                revision: 0,
                updatedAt: new Date().toISOString(),
                sections: {},
                pendingUpdates: [],
              }),
              candidateUpdates: [
                ...previousCandidates.filter((candidate) => candidate.target !== "classroom"),
                {
                  id: candidateId,
                  target: "classroom" as const,
                  classroomId: split.studentClassroomId,
                  baseClassroomId: request.updateTarget!.baseClassroomId,
                  baseRevision: request.updateTarget!.baseDesignRevision,
                  affectedSectionIds: request.updateTarget!.affectedSectionIds,
                  affectedOutlineIds: request.updateTarget!.affectedOutlineIds,
                  generatedAt: new Date().toISOString(),
                },
              ],
            },
          },
        };
      });
      const completedAt = new Date();
      const message = `已生成 ${split.studentSceneCount} 个页面的局部更新候选，等待教师确认采用`;
      await contentGenerationJobs.update({
        where: { id: job.id, status: "running", executionId },
        data: {
          status: "completed",
          step: "candidate_ready",
          progress: 100,
          message,
          scenesGenerated: split.studentSceneCount,
          totalScenes: split.studentSceneCount,
          estimatedRemainingSeconds: 0,
          result: {
            id: split.studentClassroomId,
            candidateId,
            updateTarget: request.updateTarget,
          } as unknown as Prisma.InputJsonValue,
          qualityReport: generated.qualityReport as unknown as Prisma.InputJsonValue,
          events: [...asEvents(job.events), {
            step: "candidate_ready",
            progress: 100,
            message,
            scenesGenerated: split.studentSceneCount,
            totalScenes: split.studentSceneCount,
            ts: completedAt.getTime(),
          }].slice(-MAX_STORED_EVENTS) as unknown as Prisma.InputJsonValue,
          completedAt,
          lastHeartbeatAt: completedAt,
          leaseExpiresAt: null,
          executionId: null,
          executionOwner: null,
          version: { increment: 1 },
        },
      });
      return;
    }
    await serializeWorkerWrite(() => persistWorkerPhase(job, {
      step: "saving_classrooms",
      progress: 93,
      message: "正在关联并保存学生课堂与教师资源",
      estimatedRemainingSeconds: 150,
    }));
    await assertCourseGenerationExecution(job);
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
    await updateCourse(courseId, (current) => {
      const alreadyApplied = (current.aiLearningClassroomId || current.content._openmaicClassroomId)
        === split.studentClassroomId
        && current.content.classroomGenerationRun?.status === "completed"
        && current.content.classroomGenerationRun.generatedOutlineIds.length === generatedOutlineIds.length
        && current.content.classroomGenerationRun.generatedOutlineIds.every(
          (id, index) => id === generatedOutlineIds[index],
        );
      if (alreadyApplied) return current;
      return {
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
        designWorkspaceRevision: {
          schemaVersion: 1,
          revision: (current.content.designWorkspaceRevision?.revision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
          sections: Object.fromEntries(COURSE_DESIGN_WORKSPACE_SECTIONS.map((section) => [section.key, {
            status: "ready" as const,
            revision: (current.content.designWorkspaceRevision?.revision ?? 0) + 1,
            manuallyEdited: current.content.designWorkspaceRevision?.sections[section.key]?.manuallyEdited ?? false,
            updatedAt: new Date().toISOString(),
          }])),
          pendingUpdates: [],
          candidateUpdates: [],
        },
        },
      };
    });
    await saveGenerationCheckpoint(job.id, COURSE_FINALIZATION_STEP, {
      schemaVersion: 1,
      inputFingerprint: finalizationFingerprint,
      generated,
      split,
      courseLinkedAt: restoredFinalization?.courseLinkedAt ?? new Date().toISOString(),
    } satisfies CourseFinalizationCheckpoint, { executionId });
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
    // Old completed markers did not guarantee complete speech assets. Always
    // resume the idempotent asset pipeline, which reuses files and alignment cache.
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
      return await generateClassroomAssets(assetInput);
    })();
    const [, teachingTimingAudit] = await Promise.all([adaptivePromise, assetPromise]);
    if (teachingTimingAudit) {
      await assertCourseGenerationExecution(job);
      await updateCourse(courseId, (current) => ({
        ...current,
        content: { ...current.content, teachingTimingAudit },
      }));
    }
    await saveGenerationCheckpoint(job.id, COURSE_FINALIZATION_STEP, {
      schemaVersion: 1,
      inputFingerprint: finalizationFingerprint,
      generated,
      split,
      courseLinkedAt: restoredFinalization?.courseLinkedAt ?? new Date().toISOString(),
      assetsCompletedAt: new Date().toISOString(),
      teachingTimingAudit,
    } satisfies CourseFinalizationCheckpoint, { executionId });
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
    await assertCourseGenerationExecution(job);
    await contentGenerationJobs.update({
      where: { id: job.id, status: "running", executionId },
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
        leaseExpiresAt: null,
        executionId: null,
        executionOwner: null,
        version: { increment: 1 },
      },
    });


  } catch (error) {
    const currentStatus = await contentGenerationJobs.findUnique({ where: { id: job.id } });
    if (cancellationRequested.has(courseId)
      || currentStatus?.status === "cancelling"
      || currentStatus?.status === "cancelled") {
      await contentGenerationJobs.updateMany({
        where: { id: job.id, status: { in: ["running", "cancelling"] }, executionId },
        data: {
          status: "cancelled",
          step: "cancelled",
          message: "课程生成已中断",
          error: null,
          estimatedRemainingSeconds: null,
          completedAt: new Date(),
          lastHeartbeatAt: new Date(),
          leaseExpiresAt: null,
          executionId: null,
          executionOwner: null,
          version: { increment: 1 },
        },
      });
      return;
    }
    if (error instanceof CourseGenerationExecutionLostError
      || currentStatus?.executionId !== executionId) {
      return;
    }
    if (stopping && (controller.signal.aborted || isAbortError(error))) {
      await contentGenerationJobs.updateMany({
        where: { id: job.id, status: "running", executionId },
        data: {
          status: "queued",
          step: "queued",
          message: "等待服务器继续生成",
          lastHeartbeatAt: new Date(),
          leaseExpiresAt: null,
          executionId: null,
          executionOwner: null,
        },
      });
      return;
    }
    log.error(`Course generation job ${job.id} failed`, error);
    await contentGenerationJobs.updateMany({
      where: { id: job.id, status: "running", executionId },
      data: {
        status: "failed",
        step: "failed",
        message: "课程生成未完成",
        error: serializeCourseGenerationFailure(error),
        estimatedRemainingSeconds: null,
        completedAt: new Date(),
        lastHeartbeatAt: new Date(),
        leaseExpiresAt: null,
        executionId: null,
        executionOwner: null,
        version: { increment: 1 },
      },
    });
  } finally {
    clearInterval(heartbeatTimer);
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
      where: { id: job.id, status: "queued", version: job.version },
      data: {
        status: "cancelled",
        step: "cancelled",
        message: "课程生成已中断",
        completedAt: new Date(),
        estimatedRemainingSeconds: null,
        leaseExpiresAt: null,
        executionId: null,
        executionOwner: null,
        version: { increment: 1 },
      },
    });
  }
  cancellationRequested.add(courseId);
  const cancelling = await contentGenerationJobs.update({
    where: { id: job.id, status: job.status, version: job.version },
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
  await contentGenerationJobs.updateMany({
    where: { status: "cancelling" },
    data: {
      status: "cancelled",
      step: "cancelled",
      message: "课程生成已中断",
      completedAt: new Date(),
      leaseExpiresAt: null,
      executionId: null,
      executionOwner: null,
    },
  });
  void tick();
}

export async function stopCourseGenerationWorker(): Promise<void> {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  activeController?.abort(new Error("Server shutting down"));
  await Promise.allSettled([...activeRuns]);
  workerStarted = false;
}
