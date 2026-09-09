import { Prisma } from "@prisma/client";

/**
 * Serialize mutations that share a Course.version consistency boundary.
 *
 * The lock is transaction-scoped, so it is always released on commit or
 * rollback. Every writer that updates Course.version must acquire this before
 * reading or changing the course aggregate.
 */
export async function lockCourseMutation(
  tx: Prisma.TransactionClient,
  courseId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`v2-course:${courseId}`}, 0))
  `;
}
