import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export const PREPARED_OUTLINES_STEP = "prepared-outlines";
export const TEACHING_BLUEPRINT_STEP = "teaching-blueprint";
export const KNOWLEDGE_STRUCTURE_STEP = "course-design:knowledge-structure";
export const KNOWLEDGE_STRUCTURE_ATTEMPT_STEP = "course-design-attempt:knowledge-structure";
export const AI_DURATION_STEP = "course-design:ai-duration";
export const AI_DURATION_ATTEMPT_STEP = "course-design-attempt:ai-duration";
export async function loadGenerationCheckpoints(jobId: string) {
  const rows = await prisma.generationCheckpoint.findMany({ where: { jobId } });
  return {
    preparedOutlines: rows.find((row) => row.step === PREPARED_OUTLINES_STEP)?.state ?? [],
    teachingBlueprint: rows.find((row) => row.step === TEACHING_BLUEPRINT_STEP)?.state ?? null,
    knowledgeStructure: rows.find((row) => row.step === KNOWLEDGE_STRUCTURE_STEP)?.state ?? null,
    knowledgeStructureAttempt: rows.find((row) => row.step === KNOWLEDGE_STRUCTURE_ATTEMPT_STEP)?.state ?? null,
    aiDuration: rows.find((row) => row.step === AI_DURATION_STEP)?.state ?? null,
    aiDurationAttempt: rows.find((row) => row.step === AI_DURATION_ATTEMPT_STEP)?.state ?? null,
    pages: rows.filter((row) => row.step.startsWith("page:")).map((row) => row.state),
    stages: rows.filter((row) => row.step.startsWith("stage:")).map((row) => row.state),
    stageAttempts: rows.filter((row) => row.step.startsWith("stage-attempt:")).map((row) => row.state),
    teachingSections: rows.filter((row) => row.step.startsWith("teaching-section:")).map((row) => row.state),
  };
}
export async function saveGenerationCheckpoint(jobId: string, step: string, state: unknown) {
  const value = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
  await prisma.generationCheckpoint.upsert({ where: { jobId_step: { jobId, step } }, create: { jobId, step, state: value }, update: { state: value } });
}
export async function resetGenerationCheckpoints(jobId: string) {
  await prisma.generationCheckpoint.deleteMany({ where: { jobId } });
}
/**
 * A test lesson and its later full-course promotion share page checkpoints.
 * Only discard the prepared outline envelope so the next request adopts the
 * newly confirmed full outline; every retained page is still guarded by its
 * exact outline, model, and production-input fingerprints.
 */
export async function resetPreparedOutlinesCheckpoint(jobId: string) {
  await prisma.generationCheckpoint.deleteMany({ where: { jobId, step: PREPARED_OUTLINES_STEP } });
}
export async function countGenerationPageCheckpoints(jobId: string) {
  return prisma.generationCheckpoint.count({ where: { jobId, step: { startsWith: "page:" } } });
}
