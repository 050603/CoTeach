import { randomUUID } from "node:crypto";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { StudentAiProgress } from "@/lib/session/types";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export async function persistStudentAiProgress(
  courseId: string,
  studentId: string,
  progress: StudentAiProgress,
  stageProgress: number,
): Promise<StudentAiProgress> {
  const result = await runMutationTransaction(async (tx) => {
    await lockProjectedCourse(tx, courseId);
    const participation = await tx.classroomParticipation.findFirst({ where: { instanceId: courseId, enrollment: { userId: studentId, status: "ACTIVE" } }, include: { workspace: true, enrollment: true } });
    if (!participation) throw new Error("STUDENT_NOT_FOUND");
    const projectState = (participation.workspace?.projectState ?? {}) as Record<string, unknown>;
    const previous = projectState.aiLearningProgress as StudentAiProgress | undefined;
    const matchingPrevious = previous?.classroomId === progress.classroomId ? previous : undefined;
    const completedScenes = Array.from(new Set([
      ...(matchingPrevious?.completedScenes ?? []),
      ...progress.completedScenes,
    ]));
    const completedOutlineIds = Array.from(new Set([
      ...(matchingPrevious?.completedOutlineIds ?? []),
      ...(progress.completedOutlineIds ?? []),
    ]));
    const mergedProgress: StudentAiProgress = {
      ...matchingPrevious,
      ...progress,
      completedScenes,
      ...(completedOutlineIds.length ? { completedOutlineIds } : {}),
      // The playback update may have been built before a concurrent quiz/tutor
      // transaction. Keep those independently persisted records from the row
      // locked above instead of restoring the caller's older snapshot.
      ...(matchingPrevious?.knowledgeLectureAttempts ? { knowledgeLectureAttempts: matchingPrevious.knowledgeLectureAttempts } : {}),
      ...(matchingPrevious?.knowledgeLectureTutorThreads ? { knowledgeLectureTutorThreads: matchingPrevious.knowledgeLectureTutorThreads } : {}),
      ...(matchingPrevious?.adaptiveLearning ? { adaptiveLearning: matchingPrevious.adaptiveLearning } : {}),
      masteryLevel: completedScenes.length >= progress.totalScenes && progress.totalScenes > 0
        ? "completed"
        : completedScenes.length > 0 || progress.currentSceneIndex > 0 || (matchingPrevious?.knowledgeLectureAttempts?.length ?? 0) > 0
          ? "in-progress"
          : "not-started",
      quizScore: undefined,
    };
    await tx.studentProjectWorkspace.upsert({ where: { participationId: participation.id }, create: { participationId: participation.id, projectState: JSON.parse(JSON.stringify({ aiLearningProgress: mergedProgress })) }, update: { projectState: JSON.parse(JSON.stringify({ ...projectState, aiLearningProgress: mergedProgress })), version: { increment: 1 } } });
    const stageState = (participation.stageProgress ?? {}) as Record<string, unknown>;
    const values = (stageState.progress ?? {}) as Record<string, number>;
    await tx.classroomParticipation.update({ where: { id: participation.id }, data: { stageProgress: JSON.parse(JSON.stringify({ ...stageState, progress: { ...values, "ai-learning": Math.max(values["ai-learning"] ?? 0, stageProgress) } })) } });
    const instance = await tx.classroomInstance.findUniqueOrThrow({ where: { id: courseId } });
    const runtime = (instance.runtimeConfig ?? {}) as Record<string, unknown>;
    const version = Number(runtime.version ?? 1) + 1;
    await tx.classroomInstance.update({ where: { id: courseId }, data: { runtimeConfig: JSON.parse(JSON.stringify({ ...runtime, version })) } });
    const row = await tx.domainEvent.create({ data: { idempotencyKey: randomUUID(), actorId: studentId, offeringId: participation.enrollment.offeringId, classroomInstanceId: courseId, participationId: participation.id, researchKey: participation.enrollment.researchKey, eventType: "UPDATE_STUDENT_PROGRESS", payload: { studentId, stageKey: "ai-learning", progress: stageProgress, scope: "student", courseVersion: version } } });
    return { event: { courseVersion: version, cursor: `${row.createdAt.toISOString()}~${row.id}` }, progress: mergedProgress };
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
