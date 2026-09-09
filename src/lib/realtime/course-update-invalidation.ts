import { encodeEventCursor } from "./event-cursor";
import { resolveCourseEventScope } from "./course-event-scope";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { publishCourseEvent } from "@/lib/realtime/event-bus";

/**
 * Give direct server-side course updates the same durable invalidation path as
 * browser SessionActions. The database cursor is the correctness path; Redis
 * and WebSocket only reduce latency.
 */
export async function persistCourseUpdateInvalidation(input: {
  courseId: string;
  courseVersion: number;
  updatedAt: string;
  targetStudentId?: string;
}): Promise<string> {
  const scope = await resolveCourseEventScope(input.courseId);
  if (!scope) throw new Error('CLASSROOM_NOT_FOUND');
  const event = await prisma.domainEvent.create({
    data: {
      classroomInstanceId: scope.classroomInstanceId,
      offeringId: scope.offeringId,
      idempotencyKey: randomUUID(), eventType: 'UPDATE_COURSE',
      payload: {
        courseVersion: input.courseVersion,
        source: 'server-course-update',
        scope: input.targetStudentId ? 'student' : 'course',
        ...(scope.templateId ? { templateId: scope.templateId } : {}),
        ...(input.targetStudentId ? { studentId: input.targetStudentId } : {}),
      },
    },
    select: { id: true, createdAt: true },
  });
  const cursor = encodeEventCursor(event);
  try {
    await publishCourseEvent(input.courseId, {
      type: "course-updated",
      courseId: input.courseId,
      at: input.updatedAt,
      payload: {
        actionType: "UPDATE_COURSE",
        courseVersion: input.courseVersion,
        eventCursor: cursor,
        scope: input.targetStudentId ? "student" : "course",
        ...(input.targetStudentId ? { studentId: input.targetStudentId } : {}),
      },
    });
  } catch (error) {
    console.error("[course-update] realtime publish failed; clients will reconcile by cursor", {
      courseId: input.courseId,
      eventCursor: cursor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return cursor;
}
