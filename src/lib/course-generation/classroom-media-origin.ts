import type { Prisma } from '@prisma/client';

export const CLASSROOM_MEDIA_ORIGIN_PREFIX = 'classroom-media-origin:';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const result = record(job.result);
  const split = record(record(finalization?.state).split);
  const ids = new Set([result.id, result.teacherClassroomId, split.studentClassroomId, split.teacherClassroomId]
    .filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)));
  for (const classroomId of ids) {
    const step = CLASSROOM_MEDIA_ORIGIN_PREFIX + classroomId;
    await tx.generationCheckpoint.upsert({
      where: { jobId_step: { jobId: job.id, step } },
      create: { jobId: job.id, step, state: { classroomId } },
      update: {},
    });
  }
}
