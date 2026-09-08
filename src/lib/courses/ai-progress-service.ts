// @ts-nocheck
import { randomUUID } from "node:crypto";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { StudentAiProgress } from "@/lib/session/types";
import { lockCourseMutation } from "@/lib/db/course-mutation-lock";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export async function persistStudentAiProgress(
  courseId: string,
  studentId: string,
  progress: StudentAiProgress,
  stageProgress: number,
): Promise<StudentAiProgress> {
  const result = await runMutationTransaction(async (tx) => {
    await lockCourseMutation(tx, courseId);
    const [courseRow, studentRow] = await Promise.all([
      tx.course.findUnique({
        where: { id: courseId },
        select: { aiLearningProgress: true },
      }),
      tx.student.findUnique({
        where: { courseId_id: { courseId, id: studentId } },
        select: { progress: true },
      }),
    ]);
    if (!courseRow) throw new Error("COURSE_NOT_FOUND");
    if (!studentRow) throw new Error("STUDENT_NOT_FOUND");

    const progressByStudent =
      (courseRow.aiLearningProgress as Record<string, StudentAiProgress> | null) ?? {};
    const previous = progressByStudent[studentId];
    const completedScenes = Array.from(new Set([
      ...(previous?.completedScenes ?? []),
      ...progress.completedScenes,
    ]));
    const completedOutlineIds = Array.from(new Set([
      ...(previous?.completedOutlineIds ?? []),
      ...(progress.completedOutlineIds ?? []),
    ]));
    const masteryRank: Record<StudentAiProgress["masteryLevel"], number> = {
      "not-started": 0,
      "in-progress": 1,
      completed: 2,
      mastered: 3,
    };
    const mergedProgress: StudentAiProgress = {
      ...previous,
      ...progress,
      completedScenes,
      ...(completedOutlineIds.length ? { completedOutlineIds } : {}),
      masteryLevel:
        previous && masteryRank[previous.masteryLevel] > masteryRank[progress.masteryLevel]
          ? previous.masteryLevel
          : progress.masteryLevel,
    };
    const updatedCourse = await tx.$executeRaw`
      UPDATE "Course"
      SET "aiLearningProgress" = jsonb_set(
            COALESCE("aiLearningProgress", '{}'::jsonb),
            ARRAY[${studentId}]::text[],
            ${JSON.stringify(mergedProgress)}::jsonb,
            true
          ),
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "id" = ${courseId}
    `;
    if (updatedCourse !== 1) throw new Error("COURSE_NOT_FOUND");

    const studentProgress =
      (studentRow.progress as Record<string, number> | null) ?? {};
    await tx.student.update({
      where: { courseId_id: { courseId, id: studentId } },
      data: {
        progress: {
          ...studentProgress,
          "ai-learning": Math.max(studentProgress["ai-learning"] ?? 0, stageProgress),
        },
        version: { increment: 1 },
      },
    });

    const course = await tx.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { version: true },
    });
    const event = await tx.courseEvent.create({
      data: {
        courseId,
        requestId: randomUUID(),
        type: "UPDATE_STUDENT_PROGRESS",
        actorId: studentId,
        actorRole: "student",
        courseVersion: course.version,
        payload: { studentId, stageKey: "ai-learning", progress: stageProgress },
      },
      select: { cursor: true, courseVersion: true },
    });
    return { event, progress: mergedProgress };
  });

  try {
    await publishCourseEvent(courseId, {
      type: "course-updated",
      courseId,
      at: new Date().toISOString(),
      payload: {
        actionType: "UPDATE_STUDENT_PROGRESS",
        studentId,
        courseVersion: result.event.courseVersion,
        eventCursor: result.event.cursor.toString(),
      },
    });
  } catch (error) {
    console.error("[ai-progress] realtime invalidation failed; clients will reconcile by cursor", {
      courseId,
      studentId,
      eventCursor: result.event.cursor.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result.progress;
}
