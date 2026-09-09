import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

export const PREPARED_OUTLINES_STEP = "prepared-outlines";
export async function loadGenerationCheckpoints(jobId: string) {
  const rows = await prisma.generationCheckpoint.findMany({ where: { jobId } });
  return {
    preparedOutlines: rows.find((row) => row.step === PREPARED_OUTLINES_STEP)?.state ?? [],
    pages: rows.filter((row) => row.step.startsWith("page:")).map((row) => row.state),
  };
}
export async function saveGenerationCheckpoint(jobId: string, step: string, state: unknown) {
  const value = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
  await prisma.generationCheckpoint.upsert({ where: { jobId_step: { jobId, step } }, create: { jobId, step, state: value }, update: { state: value } });
}
export async function resetGenerationCheckpoints(jobId: string) {
  await prisma.generationCheckpoint.deleteMany({ where: { jobId } });
}
export async function countGenerationPageCheckpoints(jobId: string) {
  return prisma.generationCheckpoint.count({ where: { jobId, step: { startsWith: "page:" } } });
}
