import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { isStudentAiLearningScene } from "@openmaic/lib/pbl/scene-routing";
import type { PersistedClassroomData } from "@openmaic/lib/server/classroom-storage";
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
 * Build a read-only classroom from durable per-page generation checkpoints.
 * This deliberately does not link the draft to the course or expose it to
 * students; it only lets the owning teacher inspect pages while later pages
 * and optional assets continue generating.
 */
export async function loadCourseGenerationPreviewClassroom(
  classroomId: string,
): Promise<PersistedClassroomData | null> {
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
      createdAt: true,
      updatedAt: true,
      checkpoints: { select: { step: true, state: true } },
    },
  });
  if (!job) return null;

  const prepared = job.checkpoints.find((row) => row.step === "prepared-outlines")?.state;
  const outlineOrder = new Map<string, number>();
  if (Array.isArray(prepared)) {
    prepared.forEach((value, index) => {
      const outline = object(value);
      if (typeof outline.id === "string") outlineOrder.set(outline.id, index);
    });
  }

  const checkpointScenes = job.checkpoints
    .filter((row) => row.step.startsWith("page:"))
    .map((row) => checkpointScene(row.state))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => (
      (outlineOrder.get(left.pageKey) ?? Number.MAX_SAFE_INTEGER)
      - (outlineOrder.get(right.pageKey) ?? Number.MAX_SAFE_INTEGER)
    ));
  const hasRoutingMetadata = checkpointScenes.some(({ scene }) =>
    Boolean(scene.stageKey || scene.audience || scene.generationPurpose),
  );
  const previewable = checkpointScenes.filter(({ scene }) =>
    hasRoutingMetadata ? isStudentAiLearningScene(scene) : scene.audience !== "teacher",
  );
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

  return {
    id: classroomId,
    stage,
    scenes,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    revision: previewable.length,
  };
}
