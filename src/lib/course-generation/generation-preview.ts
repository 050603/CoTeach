import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { isStudentAiLearningScene } from "@openmaic/lib/pbl/scene-routing";
import { isValidClassroomId, readClassroom, type PersistedClassroomData } from "@openmaic/lib/server/classroom-storage";
import { reusePersistedSceneAssets } from "@openmaic/lib/server/classroom-asset-recovery";
import type { GenerationPreviewStatus } from "./preview-status";
import { classroomPreviewStatus } from "./classroom-preview-status";
import type { Scene, Stage } from "@openmaic/lib/types/stage";

export const COURSE_GENERATION_PREVIEW_PREFIX = "course-generation-preview-";

export function courseGenerationPreviewClassroomId(jobId: string): string {
  return `${COURSE_GENERATION_PREVIEW_PREFIX}${jobId}`;
}

export function courseGenerationPreviewJobId(classroomId: string): string | null {
  if (!classroomId.startsWith(COURSE_GENERATION_PREVIEW_PREFIX)) return null;
  const jobId = classroomId.slice(COURSE_GENERATION_PREVIEW_PREFIX.length);
  return /^[a-zA-Z0-9_-]+$/.test(jobId) ? jobId : null;
}

function object(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function checkpointScene(value: Prisma.JsonValue): { pageKey: string; scene: Scene } | null {
  const checkpoint = object(value);
  const scene = object(checkpoint.scene ?? null);
  if (
    typeof checkpoint.pageKey !== "string"
    || typeof scene.id !== "string"
    || typeof scene.title !== "string"
    || typeof scene.type !== "string"
    || !scene.content
    || typeof scene.content !== "object"
    || !Array.isArray(scene.actions)
  ) return null;
  return { pageKey: checkpoint.pageKey, scene: scene as unknown as Scene };
}

/** Resolve a generated-preview classroom back to its owning course template. */
export async function findCourseGenerationPreviewCourseId(classroomId: string): Promise<string | null> {
  const jobId = courseGenerationPreviewJobId(classroomId);
  if (!jobId) return null;
  const job = await prisma.generationJob.findFirst({
    where: {
      id: jobId,
      targetType: "CLASSROOM_TEMPLATE",
      jobType: "COURSE_CONTENT",
    },
    select: { targetId: true },
  });
  return job?.targetId ?? null;
}

/**
 * Build a read-only preview from this task's persisted classroom, falling back
 * to its per-page checkpoints until the durable classroom exists.
 * This deliberately does not link the draft to the course or expose it to
 * students; it only lets the owning teacher inspect pages while later pages
 * and optional assets continue generating.
 */
export async function loadCourseGenerationPreviewClassroom(
  classroomId: string,
): Promise<(PersistedClassroomData & { generationPreview: GenerationPreviewStatus }) | null> {
  const jobId = courseGenerationPreviewJobId(classroomId);
  if (!jobId) return null;
  const job = await prisma.generationJob.findFirst({
    where: {
      id: jobId,
      targetType: "CLASSROOM_TEMPLATE",
      jobType: "COURSE_CONTENT",
    },
    select: {
      request: true,
      result: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      checkpoints: { select: { step: true, state: true } },
    },
  });
  if (!job) return null;

  const finalization = object(job.checkpoints.find((row) => row.step === "course-finalization")?.state ?? null);
  const split = object(finalization.split ?? null);
  const result = object(job.result ?? null);
  // Never resolve via the course's current classroom: another job may own it.
  const persistedId = typeof split.studentClassroomId === "string"
    ? split.studentClassroomId
    : typeof result.id === "string" ? result.id : null;
  const persisted = persistedId && isValidClassroomId(persistedId)
    ? await readClassroom(persistedId)
    : null;

  const prepared = job.checkpoints.find((row) => row.step === "prepared-outlines")?.state;
  const outlineOrder = new Map<string, number>();
  if (Array.isArray(prepared)) {
    prepared.forEach((value, index) => {
      const outline = object(value);
      if (typeof outline.id === "string") outlineOrder.set(outline.id, index);
    });
  }

  const completedPages = job.checkpoints
    .filter((row) => row.step.startsWith("page:"))
    .map((row) => checkpointScene(row.state))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => (
      (Number.isFinite(left.scene.order) ? left.scene.order : outlineOrder.get(left.pageKey) ?? Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(right.scene.order) ? right.scene.order : outlineOrder.get(right.pageKey) ?? Number.MAX_SAFE_INTEGER)
    ));
  const hasRoutingMetadata = completedPages.some(({ scene }) =>
    Boolean(scene.stageKey || scene.audience || scene.generationPurpose),
  );
  const previewablePages = completedPages.filter(({ scene }) =>
    hasRoutingMetadata ? isStudentAiLearningScene(scene) : scene.audience !== "teacher",
  );
  // A promoted test job can still point at its previous 11-page classroom
  // while the full run has already persisted later page checkpoints. Prefer
  // the growing current task and carry over only exactly matching speech/media
  // assets from accepted pages; the new classroom takes over once persisted.
  const useCompletedPages = !persisted || previewablePages.length > persisted.scenes.length;
  const priorScenes = new Map(persisted?.scenes.map((scene) => [scene.id, scene]) ?? []);
  const previewable = useCompletedPages
    ? previewablePages.map(({ pageKey, scene }) => ({
      pageKey,
      scene: reusePersistedSceneAssets(scene, priorScenes.get(scene.id)),
    }))
    : persisted!.scenes.map((scene) => ({ pageKey: scene.outlineId ?? scene.id, scene }));
  if (previewable.length === 0) return null;

  const request = object(job.request);
  const now = job.updatedAt.getTime();
  const stage: Stage = {
    id: classroomId,
    name: typeof request.courseTitle === "string"
      ? request.courseTitle
      : previewable[0].scene.title,
    style: "professional",
    createdAt: job.createdAt.getTime(),
    updatedAt: now,
  };
  const scenes = previewable.map(({ scene, pageKey }, index) => ({
    ...scene,
    stageId: classroomId,
    outlineId: scene.outlineId ?? pageKey,
    order: index,
  })) as Scene[];

  // Prisma persists enum statuses in uppercase; public job DTOs use lowercase.
  const jobStatus = job.status.toLowerCase();
  const active = ["queued", "pending", "running", "cancelling"].includes(jobStatus);
  const generationPreview = classroomPreviewStatus(
    { scenes, assetGeneration: persisted?.assetGeneration },
    { active, status: jobStatus },
  );
  return {
    ...(persisted ?? {}),
    id: classroomId,
    stage,
    scenes,
    createdAt: job.createdAt.toISOString(),
    updatedAt: useCompletedPages ? job.updatedAt.toISOString() : persisted?.updatedAt ?? job.updatedAt.toISOString(),
    revision: useCompletedPages ? previewable.length : persisted?.revision ?? previewable.length,
    generationPreview,
  };
}
