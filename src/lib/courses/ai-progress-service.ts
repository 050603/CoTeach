import { PlatformError } from "@/lib/platform/repository";
import { createHash, randomUUID } from "node:crypto";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { StudentAiProgress } from "@/lib/session/types";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export function playbackProgress(progress: StudentAiProgress): StudentAiProgress {
  return { classroomId: progress.classroomId, studentId: progress.studentId,
    currentSceneIndex: progress.currentSceneIndex, totalScenes: progress.totalScenes,
    completedScenes: progress.completedScenes, completedOutlineIds: progress.completedOutlineIds,
    completionModelVersion: progress.completionModelVersion, masteryLevel: progress.masteryLevel,
    lastActiveAt: progress.lastActiveAt };
}

type ProgressReceipt = { requestId: string; fingerprint: string; sessionVersion?: number };

export async function persistStudentAiProgress(
  courseId: string,
  studentId: string,
  progress: StudentAiProgress,
  allowedScenes?: ReadonlyArray<{ id: string; outlineId?: string }>,
  request?: ProgressReceipt,
): Promise<StudentAiProgress> {
  const fallback = playbackProgress(progress);
  const fingerprint = request?.fingerprint ?? createHash("sha256").update(JSON.stringify({ ...fallback, lastActiveAt: undefined })).digest("hex");
  const requestId = request?.requestId ?? `legacy-${fingerprint}`;
  const receiptKey = `ai-progress:${courseId}:${studentId}:${requestId}`;
  // These allowlists belong to the immutable request context. Prepare them
  // before joining the course write queue; merge only against locked data.
  const validIds = allowedScenes && new Set(allowedScenes.map(scene => scene.id));
  const validOutlines = allowedScenes && new Set(allowedScenes.map(scene => scene.outlineId?.trim() || scene.id));
  const result = await runMutationTransaction(async (tx) => {
    await lockProjectedCourse(tx, courseId);
    // Read the current learner and classroom in one round trip while holding
    // the same course lock used by grading, autosave and classroom closure.
    const [participation] = await tx.$queryRaw<Array<{
      id: string; offeringId: string; researchKey: string; projectState: unknown;
      userStatus: string; userRole: string; sessionVersion: number; enrollmentStatus: string; receipt: unknown;
      stageProgress: unknown; runtimeVersion: unknown; classroomStatus: string; offeringStatus: string; archivedAt: Date | null;
    }>>`SELECT p.id, e."offeringId", e."researchKey", w."projectState", p."stageProgress",
      u.status AS "userStatus", u.role AS "userRole", u."sessionVersion", e.status AS "enrollmentStatus",
      (SELECT payload FROM "DomainEvent" WHERE "idempotencyKey" = ${receiptKey}) AS receipt,
      ci."runtimeConfig"->'version' AS "runtimeVersion", ci.status AS "classroomStatus", o.status AS "offeringStatus", a."archivedAt"
      FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId" JOIN "User" u ON u.id = e."userId"
      JOIN "ClassroomInstance" ci ON ci.id = p."instanceId"
      JOIN "Activity" a ON a.id = ci."activityId" JOIN "Chapter" c ON c.id = a."chapterId"
      JOIN "CourseOffering" o ON o.id = c."offeringId" AND o.id = e."offeringId"
      LEFT JOIN "StudentProjectWorkspace" w ON w."participationId" = p.id
      WHERE p."instanceId" = ${courseId} AND e."userId" = ${studentId}`;
    if (!participation) throw new PlatformError("STUDENT_NOT_FOUND", "未加入当前课堂", 403);
    if (participation.userStatus.toUpperCase() !== "ACTIVE" || participation.userRole.toUpperCase() !== "STUDENT"
      || (request?.sessionVersion !== undefined && participation.sessionVersion !== request.sessionVersion)
      || !["ACTIVE", "COMPLETED"].includes(participation.enrollmentStatus.toUpperCase())) {
      throw new PlatformError("FORBIDDEN", "账户或选课权限已变化", 403);
    }
    if (participation.receipt) {
      const receipt = participation.receipt as { fingerprint: string; response: StudentAiProgress };
      if (receipt.fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他进度", 409);
      return { progress: receipt.response };
    }
    if (participation.enrollmentStatus.toUpperCase() !== "ACTIVE" || participation.classroomStatus !== "TEACHING" || participation.offeringStatus !== "OPEN" || participation.archivedAt) throw new PlatformError("CLASSROOM_READ_ONLY", "课堂已结束，无法更新进度", 409);
    const projectState = (participation.projectState ?? {}) as Record<string, unknown>;
    const previous = projectState.aiLearningProgress as StudentAiProgress | undefined;
    const matchingPrevious = previous?.classroomId === progress.classroomId ? previous : undefined;
    const completedScenes = Array.from(new Set([
      ...(matchingPrevious?.completedScenes ?? []),
      ...progress.completedScenes,
    ])).filter(id => !validIds || validIds.has(id));
    const completedOutlineIds = Array.from(new Set([
      ...(matchingPrevious?.completedOutlineIds ?? []),
      ...(progress.completedOutlineIds ?? []),
    ])).filter(id => !validOutlines || validOutlines.has(id));
    const mergedProgress: StudentAiProgress = {
      ...matchingPrevious,
      ...progress,
      completedScenes,
      completedOutlineIds,
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
    const response = playbackProgress(mergedProgress);
    const stageProgress = Math.min(100, Math.round(completedScenes.length / Math.max(1, progress.totalScenes) * 100));
    const stageState = (participation.stageProgress ?? {}) as Record<string, unknown>;
    const values = (stageState.progress ?? {}) as Record<string, number>;
    const version = Number(participation.runtimeVersion ?? 1) + 1;
    const now = new Date();
    // Keep lock acquisition and its fresh read in separate statements above.
    // Only the already validated writes share a statement: every receipt is
    // committed atomically with the workspace, percentage and course version.
    const rows = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>`WITH course AS (
      UPDATE "ClassroomInstance" SET "runtimeConfig" = jsonb_set(
        CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END,
        '{version}', ${JSON.stringify(version)}::jsonb), "updatedAt" = ${now}
      WHERE id = ${courseId} RETURNING id
    ), workspace AS (
      INSERT INTO "StudentProjectWorkspace" (id, "participationId", "projectState", "updatedAt")
      SELECT ${randomUUID()}, ${participation.id}, ${JSON.stringify({ ...projectState, aiLearningProgress: mergedProgress })}::jsonb, ${now} FROM course
      ON CONFLICT ("participationId") DO UPDATE SET "projectState" = EXCLUDED."projectState",
        version = "StudentProjectWorkspace".version + 1, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "participationId"
    ), stage AS (
      UPDATE "ClassroomParticipation" p SET "stageProgress" = ${JSON.stringify({ ...stageState, progress: { ...values, "ai-learning": stageProgress } })}::jsonb
      FROM workspace WHERE p.id = workspace."participationId" AND ${values["ai-learning"] !== stageProgress} RETURNING p.id
    ) INSERT INTO "DomainEvent" (id, "idempotencyKey", "createdAt", "actorId", "offeringId", "classroomInstanceId", "participationId", "researchKey", "eventType", payload)
      SELECT ${randomUUID()}, ${receiptKey}, ${now}, ${studentId}, ${participation.offeringId}, ${courseId}, workspace."participationId", ${participation.researchKey ?? null},
        'UPDATE_STUDENT_PROGRESS', ${JSON.stringify({ studentId, stageKey: "ai-learning", progress: stageProgress, scope: "student", courseVersion: version, requestId, fingerprint, response })}::jsonb
      FROM workspace RETURNING id, "createdAt"`;
    if (rows.length !== 1) throw new Error("PROGRESS_COMMIT_INCOMPLETE");
    const row = rows[0];
    return { event: { courseVersion: version, cursor: `${row.createdAt.toISOString()}~${row.id}` }, progress: response };
  }, {
    lowPriorityCourseId: courseId,
    admissionTimeoutError: () => new PlatformError("COURSE_BUSY", "课堂保存繁忙，请稍后重试", 503),
  });

  if (!result.event) return result.progress;
  try {
    await publishCourseEvent(courseId, {
      type: "course-updated",
      courseId,
      at: new Date().toISOString(),
      payload: {
        actionType: "UPDATE_STUDENT_PROGRESS",
        scope: "student",
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
