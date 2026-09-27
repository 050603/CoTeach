import type { Prisma } from '@prisma/client';

/** One joined read for the common classroom-instance student state request.
 * null retains the established template/offering fallback; no write permission
 * is inferred from a read (completed enrolments and finished runs stay readable).
 */
export async function resolveStudentStateScope(db: Prisma.TransactionClient, courseId: string, studentId: string) {
  const [row] = await db.$queryRaw<Array<{ accessible: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "ClassroomParticipation" p
      JOIN "Enrollment" e ON e.id = p."enrollmentId"
      JOIN "User" u ON u.id = e."userId"
      WHERE p."instanceId" = ci.id AND e."userId" = ${studentId}
        AND e."offeringId" = c."offeringId"
        AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed')
        AND lower(u.role) = 'student' AND lower(u.status) = 'active'
    ) AS accessible
    FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
    JOIN "Chapter" c ON c.id = a."chapterId"
    WHERE ci.id = ${courseId}
      AND NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = ${courseId})
      AND NOT EXISTS (SELECT 1 FROM "CourseOffering" o WHERE o.id = ${courseId})
  `;
  return row ?? null;
}
