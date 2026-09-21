import { getCourse, updateCourse } from "@/lib/session/server-store";
import { readClassroom, updatePersistedClassroomScenes } from "@/lib/openmaic/server/classroom-storage";
import { generateClassroomAssets } from "@/lib/openmaic/server/classroom-asset-generation";
import {
  findUnresolvedClassroomMedia,
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

export type CourseResourceRepairStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
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

export function getCourseResourceRepairStatus(courseId: string): CourseResourceRepairStatus {
  return runtimeState().jobs.get(courseId)?.status ?? { status: "idle" };
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

/**
 * Start one process-wide repair per course. The returned promise is intended
 * for Next.js `after()`, so long TTS batches do not keep the POST open until a
 * reverse proxy mistakes healthy generation for a timed-out request.
 */
export function startCourseResourceRepair(
  courseId: string,
  baseUrl: string,
): CourseResourceRepairJob & { started: boolean } {
  const state = runtimeState();
  const existing = state.jobs.get(courseId);
  if (existing?.status.status === "running") return { ...existing, started: false };

  const startedAt = new Date().toISOString();
  const job = {
    status: { status: "running", startedAt } as CourseResourceRepairStatus,
    completion: Promise.resolve(),
  };
  state.jobs.set(courseId, job);
  job.completion = repairCourseResources(courseId, baseUrl)
    .then(() => {
      job.status = { status: "completed", startedAt, finishedAt: new Date().toISOString() };
    })
    .catch((error: unknown) => {
      job.status = {
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "课程资源修复失败",
      };
    });
  return { ...job, started: true };
}
