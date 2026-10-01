import type { Prisma } from '@prisma/client';

export const CLASSROOM_MEDIA_ORIGIN_PREFIX = 'classroom-media-origin:';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keep the synthesis classroom as well as the routed outputs: reused clips
 * can still point at the former after a job's finalization is replaced. */
export async function saveFinalizationMediaOrigins(
  tx: Prisma.TransactionClient,
  jobId: string,
  finalization: unknown,
  resultValue: unknown = null,
): Promise<void> {
  const saved = record(finalization);
  const generated = record(saved.generated);
  const split = record(saved.split);
  const result = record(resultValue);
  const ids = new Set([generated.id, result.id, result.teacherClassroomId,
    split.studentClassroomId, split.teacherClassroomId]
    .filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)));
  for (const classroomId of ids) {
    const step = CLASSROOM_MEDIA_ORIGIN_PREFIX + classroomId;
    await tx.generationCheckpoint.upsert({
      where: { jobId_step: { jobId, step } },
      create: { jobId, step, state: { classroomId } },
      update: {},
    });
  }
}

/** Archive server output before reusing a job; never derive ownership from its editable request. */
export async function preserveClassroomMediaOrigins(
  tx: Prisma.TransactionClient,
  job: { id: string; result: unknown },
): Promise<void> {
  const finalization = await tx.generationCheckpoint.findUnique({
    where: { jobId_step: { jobId: job.id, step: 'course-finalization' } },
    select: { state: true },
  });
  await saveFinalizationMediaOrigins(tx, job.id, finalization?.state, job.result);
}
