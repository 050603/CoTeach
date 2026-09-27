import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { getCourse } from "@/lib/session/server-store";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import type { StudentAiProgress } from "@/lib/session/types";

/** Caller must authorize the course and student before exposing this context. */
export async function loadAiProgressContext(courseId: string, studentId?: string) {
  if (!isDatabaseConfigured()) return getCourse(courseId, studentId ? { studentId } : undefined);
  if (studentId) {
    // The authenticated learner branch needs the same authored binding and
    // progress, not five ORM trips or unrelated workspace/document state.
    const rows = await prisma.$queryRaw<Array<{ id: string; snapshot: unknown; studentId: string | null; progress: StudentAiProgress | null }>>`
      SELECT ci.id, tv.snapshot, e."userId" AS "studentId", w."projectState" -> 'aiLearningProgress' AS progress
      FROM "ClassroomInstance" ci JOIN "ClassroomTemplateVersion" tv ON tv.id = ci."templateVersionId"
      LEFT JOIN "ClassroomParticipation" p ON p."instanceId" = ci.id AND p."enrollmentId" IN
        (SELECT id FROM "Enrollment" WHERE "userId" = ${studentId})
      LEFT JOIN "Enrollment" e ON e.id = p."enrollmentId"
      LEFT JOIN "StudentProjectWorkspace" w ON w."participationId" = p.id
      WHERE ci.id = ${courseId}`;
    if (!rows.length) return getCourse(courseId, { studentId });
    const design = decodePblTemplate(rows[0].snapshot);
    return {
      id: rows[0].id,
      aiLearningClassroomId: design?.aiLearningClassroomId,
      content: { _openmaicClassroomId: design?.content._openmaicClassroomId },
      students: rows.flatMap(row => row.studentId ? [{ id: row.studentId }] : []),
      aiLearningProgress: Object.fromEntries(rows.flatMap(row => row.studentId && row.progress ? [[row.studentId, row.progress]] : [])) as Record<string, StudentAiProgress>,
    };
  }
  const instance = await prisma.classroomInstance.findUnique({
    where: { id: courseId },
    select: {
      id: true,
      templateVersion: { select: { snapshot: true } },
      participations: {
        ...(studentId ? { where: { enrollment: { userId: studentId } } } : {}),
        select: { enrollment: { select: { userId: true } }, workspace: { select: { projectState: true } } },
      },
    },
  });
  if (!instance) return getCourse(courseId, studentId ? { studentId } : undefined);
  const design = decodePblTemplate(instance.templateVersion.snapshot);
  return {
    id: instance.id,
    aiLearningClassroomId: design?.aiLearningClassroomId,
    content: { _openmaicClassroomId: design?.content._openmaicClassroomId },
    students: instance.participations.map(row => ({ id: row.enrollment.userId })),
    aiLearningProgress: Object.fromEntries(instance.participations.flatMap(row => {
      const state = row.workspace?.projectState as { aiLearningProgress?: StudentAiProgress } | undefined;
      return state?.aiLearningProgress ? [[row.enrollment.userId, state.aiLearningProgress]] : [];
    })) as Record<string, StudentAiProgress>,
  };
}
