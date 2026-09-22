import { getCourse, updateCourse } from "@/lib/session/server-store";
import {
  readClassroom,
  updatePersistedClassroomScenes,
  updatePersistedClassroomScenesIfRevision,
} from "@/lib/openmaic/server/classroom-storage";
import { generateClassroomAssets } from "@/lib/openmaic/server/classroom-asset-generation";
import {
  findUnresolvedClassroomMedia,
  alignClassroomSpeechActions,
  generateTTSForClassroom,
  resolveServerTtsTimingSelection,
} from "@/lib/openmaic/server/classroom-media-generation";
import {
  findMissingTtsResources,
  repairMissingTeachingToolResources,
} from "@/lib/course-generation/resource-readiness";
import { generateAdaptiveBranchResource } from "@/lib/course-generation/job-runner";
import { resolveDurableCourseSceneOutlines } from "@/lib/course-generation/course-resource-outlines";
import { mapWithConcurrency } from "@openmaic/lib/utils/concurrency";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import {
  calibrateGeneratedVisualCues,
  recoverLegacyVisualCueAnchors,
} from "@/lib/openmaic/generation/semantic-visual-cues";

export type CourseResourceRepairMode = "missing-resources" | "speech-sync";

export type CourseResourceRepairStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  mode?: CourseResourceRepairMode;
  completed?: number;
  total?: number;
  failed?: number;
};

type CourseResourceRepairJob = {
  status: CourseResourceRepairStatus;
  completion: Promise<void>;
};

type ResourceRepairRuntimeState = {
  jobs: Map<string, CourseResourceRepairJob>;
};

const RESOURCE_REPAIR_STATE_KEY = Symbol.for("openpbl.course-resource-repair");

function runtimeState(): ResourceRepairRuntimeState {
  const scope = globalThis as typeof globalThis & {
    [RESOURCE_REPAIR_STATE_KEY]?: ResourceRepairRuntimeState;
  };
  return scope[RESOURCE_REPAIR_STATE_KEY] ??= { jobs: new Map() };
}

function repairKey(courseId: string, mode: CourseResourceRepairMode): string {
  return `${courseId}:${mode}`;
}

export function getCourseResourceRepairStatus(
  courseId: string,
  mode: CourseResourceRepairMode = "missing-resources",
): CourseResourceRepairStatus {
  return runtimeState().jobs.get(repairKey(courseId, mode))?.status ?? { status: "idle", mode };
}

async function repairCourseResources(courseId: string, baseUrl: string): Promise<void> {
  const course = await getCourse(courseId);
  if (!course) throw new Error("Course not found");
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const classroom = classroomId ? await readClassroom(classroomId) : null;
  const storedOutlines = course.content._openmaicSceneOutlines ?? [];
  const outlines = await resolveDurableCourseSceneOutlines(courseId, storedOutlines);
  if (JSON.stringify(outlines) !== JSON.stringify(storedOutlines)) {
    await updateCourse(courseId, (current) => ({
      ...current,
      content: { ...current.content, _openmaicSceneOutlines: outlines },
    }));
  }

  if (classroom && classroomId) {
    const repairedTools = repairMissingTeachingToolResources(outlines, classroom.scenes);
    const scenes = repairedTools.scenes;
    if (repairedTools.changed) await updatePersistedClassroomScenes(classroomId, scenes);

    const recordedMediaFailures = classroom.assetGeneration?.failures.filter(
      (failure) => failure.type === "image" || failure.type === "video",
    ) ?? [];
    const mediaFailures = Array.from(new Map(
      [...findUnresolvedClassroomMedia(outlines, scenes), ...recordedMediaFailures].map((failure) => [
        `${failure.type}:${failure.elementId}`,
        failure,
      ]),
    ).values());
    if (mediaFailures.length > 0) {
      const missingElementIds = new Set(mediaFailures.map((failure) => failure.elementId));
      const repairOutlines = outlines.flatMap((outline) => {
        const mediaGenerations = (outline.mediaGenerations ?? []).filter((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const elementId = (candidate as { elementId?: unknown }).elementId;
          return typeof elementId === "string" && missingElementIds.has(elementId);
        });
        return mediaGenerations.length > 0 ? [{ ...outline, mediaGenerations }] : [];
      }) as unknown as SceneOutline[];
      try {
        await generateClassroomAssets({
          outlines: repairOutlines,
          baseUrl,
          studentClassroomId: classroomId,
          studentScenes: scenes,
          enableImageGeneration: mediaFailures.some((failure) => failure.type === "image"),
          enableVideoGeneration: mediaFailures.some((failure) => failure.type === "video"),
          enableTTS: false,
          isPblCourse: true,
          ttsTimingSelection: resolveServerTtsTimingSelection(),
        });
      } catch {
        // Exact provider failures are persisted by the asset generator. Keep
        // repairing independent resources and expose them through the audit.
      }
    }

    if (findMissingTtsResources(scenes).length > 0) {
      try {
        await generateTTSForClassroom(
          scenes,
          classroomId,
          baseUrl,
          undefined,
          resolveServerTtsTimingSelection(),
        );
      } catch {
        // Keep successfully generated clips and continue with adaptive assets.
      } finally {
        await updatePersistedClassroomScenes(classroomId, scenes);
      }
    }
  }

  const plan = course.content.adaptiveLearningPlan;
  const branchIds = plan?.enabled
    ? plan.branches.flatMap((branch) =>
        branch.enabled !== false
        && branch.status === "teacher-confirmed"
        && (branch.preparedResource?.status !== "ready" || !branch.preparedResource.classroomId)
          ? [branch.id]
          : [],
      )
    : [];
  const repairController = new AbortController();
  await mapWithConcurrency(branchIds, 2, async (branchId) => {
    try {
      await generateAdaptiveBranchResource(courseId, branchId, repairController.signal);
    } catch {
      // The branch helper persists its exact failure; continue other branches.
    }
  });
}

async function repairSpeechSynchronization(
  courseId: string,
  onProgress: (completed: number, total: number, failed: number) => void,
): Promise<{ total: number; failed: number }> {
  const course = await getCourse(courseId);
  if (!course) throw new Error("Course not found");
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId) throw new Error("课程尚未生成 AI 课堂，无法修复朗读同步");
  const classroom = await readClassroom(classroomId);
  if (!classroom) throw new Error("课程课堂文件不存在，无法修复朗读同步");
  const expectedRevision = classroom.revision ?? 0;
  const scenes = structuredClone(classroom.scenes);
  const bindingIssues: Array<{ sceneId: string; speechId?: string; reason: string }> = [];
  for (const scene of scenes) {
    if (scene.content.type !== "slide") continue;
    const recovered = recoverLegacyVisualCueAnchors({
      elements: scene.content.canvas.elements,
      actions: scene.actions ?? [],
    });
    scene.actions = recovered.actions;
    bindingIssues.push(...recovered.issues.map((issue) => ({ ...issue, sceneId: scene.id })));
  }
  let failed = 0;
  const result = await alignClassroomSpeechActions({
    scenes,
    classroomId,
    onProgress: (progress) => {
      if (progress.status === "failed") failed += 1;
      onProgress(progress.completed, progress.total, failed);
    },
  });
  for (const issue of bindingIssues) {
    if (!issue.speechId) continue;
    const speech = scenes.find((scene) => scene.id === issue.sceneId)?.actions
      ?.find((action) => action.type === "speech" && action.id === issue.speechId);
    if (speech?.type !== "speech" || speech.speechAlignment?.status !== "aligned") continue;
    speech.speechAlignment.error = issue.reason;
  }
  const bindingWarningCount = new Set(bindingIssues.flatMap((issue) => (
    issue.speechId ? [JSON.stringify([issue.sceneId, issue.speechId])] : []
  ))).size;
  const reportedFailed = Math.min(result.total, result.failed + bindingWarningCount);
  onProgress(result.total, result.total, reportedFailed);
  const outlines = await resolveDurableCourseSceneOutlines(
    courseId,
    course.content._openmaicSceneOutlines ?? [],
  );
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  for (const scene of scenes) {
    const outline = outlineById.get(scene.outlineId ?? scene.id);
    if (!outline || scene.content.type !== "slide") continue;
    scene.actions = calibrateGeneratedVisualCues({
      outline: outline as SceneOutline,
      elements: scene.content.canvas.elements,
      actions: scene.actions ?? [],
    });
  }
  await updatePersistedClassroomScenesIfRevision(classroomId, scenes, expectedRevision);
  if (result.total > 0 && result.aligned === 0) {
    throw new Error("语音对齐服务未能完成任何讲稿，请检查本机对齐服务后重试");
  }
  return { total: result.total, failed: reportedFailed };
}

/**
 * Start one process-wide repair per course. The returned promise is intended
 * for Next.js `after()`, so long TTS batches do not keep the POST open until a
 * reverse proxy mistakes healthy generation for a timed-out request.
 */
export function startCourseResourceRepair(
  courseId: string,
  baseUrl: string,
  mode: CourseResourceRepairMode = "missing-resources",
): CourseResourceRepairJob & { started: boolean } {
  const state = runtimeState();
  const key = repairKey(courseId, mode);
  const existing = state.jobs.get(key);
  if (existing?.status.status === "running") return { ...existing, started: false };

  const startedAt = new Date().toISOString();
  const job = {
    status: { status: "running", startedAt, mode, completed: 0, total: 0, failed: 0 } as CourseResourceRepairStatus,
    completion: Promise.resolve(),
  };
  state.jobs.set(key, job);
  const work = mode === "speech-sync"
    ? repairSpeechSynchronization(courseId, (completed, total, failed) => {
        job.status = { ...job.status, status: "running", completed, total, failed };
      })
    : repairCourseResources(courseId, baseUrl).then(() => ({ total: 0, failed: 0 }));
  job.completion = work
    .then((result) => {
      job.status = {
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        mode,
        completed: result.total,
        total: result.total,
        failed: result.failed,
      };
    })
    .catch((error: unknown) => {
      job.status = {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        mode,
        error: error instanceof Error ? error.message : "课程资源修复失败",
      };
    });
  return { ...job, started: true };
}
