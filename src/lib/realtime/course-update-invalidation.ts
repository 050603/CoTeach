// @ts-nocheck
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
  const event = await prisma.courseEvent.create({
    data: {
      courseId: input.courseId,
      requestId: randomUUID(),
      type: "UPDATE_COURSE",
      actorId: "server",
      actorRole: "system",
      courseVersion: input.courseVersion,
      payload: {
        source: "server-course-update",
        scope: input.targetStudentId ? "student" : "course",
        ...(input.targetStudentId ? { studentId: input.targetStudentId } : {}),
      },
    },
    select: { cursor: true },
  });
  const cursor = event.cursor.toString();
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
