import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { getCourse } from "@/lib/session/server-store";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import type { StudentAiProgress } from "@/lib/session/types";

/** Caller must authorize the course and student before exposing this context. */
export async function loadAiProgressContext(courseId: string, studentId?: string) {
  if (!isDatabaseConfigured()) return getCourse(courseId, studentId ? { studentId } : undefined);
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
