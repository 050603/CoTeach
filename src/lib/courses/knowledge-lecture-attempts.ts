import { prisma } from "@/lib/db/client";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { encodeEventCursor } from "@/lib/realtime/event-cursor";
import type { KnowledgeLectureAttempt, KnowledgeLectureQuestionReview, StudentAiProgress } from "@/lib/session/types";

export class QuizAlreadySubmittedError extends Error {
  constructor(readonly attempt: KnowledgeLectureAttempt) { super("QUIZ_ALREADY_SUBMITTED"); }
}
export function sameSubmittedAnswers(attempt: KnowledgeLectureAttempt, answers: Record<string, string | string[]>): boolean {
  return attempt.questions.length === Object.keys(answers).length && attempt.questions.every(question => isDeepStrictEqual(question.rawAnswer ?? question.answer, answers[question.questionId]));
}
export function withGradeSummary(attempt: KnowledgeLectureAttempt): KnowledgeLectureAttempt {
  const graded = attempt.questions.filter(question => question.gradingStatus === "graded");
  return { ...attempt, gradingStatus: attempt.questions.some(question => question.gradingStatus === "failed") ? "failed" : attempt.questions.some(question => question.gradingStatus !== "graded") ? "pending" : "graded", score: graded.reduce((sum, question) => sum + question.earned, 0), maxScore: graded.reduce((sum, question) => sum + question.points, 0) };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Input = { courseId: string; studentId: string; classroomId: string; attempt: KnowledgeLectureAttempt; sessionVersion?: number };

/** Authorized quiz/tutor reads need authored context and one learner's progress only. */
export async function loadKnowledgeLectureContext(courseId: string, studentId: string) {
  const [row] = await prisma.$queryRaw<Array<{ snapshot: unknown; studentId: string | null; progress: StudentAiProgress | null }>>`
    SELECT v.snapshot, e."userId" AS "studentId", w."projectState" -> 'aiLearningProgress' AS progress
    FROM "ClassroomInstance" ci JOIN "ClassroomTemplateVersion" v ON v.id = ci."templateVersionId"
    LEFT JOIN "ClassroomParticipation" p ON p."instanceId" = ci.id AND p."enrollmentId" IN
      (SELECT id FROM "Enrollment" WHERE "userId" = ${studentId})
    LEFT JOIN "Enrollment" e ON e.id = p."enrollmentId"
    LEFT JOIN "StudentProjectWorkspace" w ON w."participationId" = p.id WHERE ci.id = ${courseId}`;
  if (!row) return undefined;
  const design = decodePblTemplate(row.snapshot);
  return { id: courseId, aiLearningClassroomId: design?.aiLearningClassroomId,
    content: { knowledgePoints: [], ...design?.content }, students: row.studentId ? [{ id: row.studentId }] : [],
    aiLearningProgress: row.progress ? { [studentId]: row.progress } : {} as Record<string, StudentAiProgress> };
}

/** Caller authenticates the student (or a teacher retrying accepted grading). */
export async function persistKnowledgeLectureAttempt(input: Input, grades?: ReadonlyMap<string, KnowledgeLectureQuestionReview>): Promise<KnowledgeLectureAttempt> {
  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, input.courseId);
    // One current, owned snapshot under the same lock as progress and closure.
    const [row] = await tx.$queryRaw<Array<{ participationId: string; offeringId: string; researchKey: string; status: string; enrollmentStatus: string; offeringStatus: string; archivedAt: Date | null; runtimeConfig: unknown; projectState: unknown; classroomId: string | null;
      userStatus: string; userRole: string; sessionVersion: number }>>`
      SELECT p.id AS "participationId", e."offeringId", e."researchKey", ci.status, e.status AS "enrollmentStatus",
        u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
        o.status AS "offeringStatus", a."archivedAt", ci."runtimeConfig", w."projectState",
        COALESCE(NULLIF(v.snapshot #>> '{design,aiLearningClassroomId}', ''), v.snapshot #>> '{design,content,_openmaicClassroomId}') AS "classroomId"
      FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
      JOIN "User" u ON u.id = e."userId"
      JOIN "ClassroomInstance" ci ON ci.id = p."instanceId" JOIN "ClassroomTemplateVersion" v ON v.id = ci."templateVersionId"
      JOIN "Activity" a ON a.id = ci."activityId" JOIN "Chapter" c ON c.id = a."chapterId" JOIN "CourseOffering" o ON o.id = c."offeringId"
      LEFT JOIN "StudentProjectWorkspace" w ON w."participationId" = p.id
      WHERE p."instanceId" = ${input.courseId} AND e."userId" = ${input.studentId} AND e."offeringId" = o.id`;
    if (!row) throw new PlatformError("STUDENT_NOT_FOUND", "未加入该课堂", 403);
    // Recheck new submissions and their replays after waiting for the lock.
    // An already accepted grading job may still finish after classroom closure;
    // it can only update grading fields of the immutable original answer below.
    if (!grades && (row.userStatus.toUpperCase() !== "ACTIVE" || row.userRole.toUpperCase() !== "STUDENT"
      || (input.sessionVersion !== undefined && row.sessionVersion !== input.sessionVersion)
      || !["ACTIVE", "COMPLETED"].includes(row.enrollmentStatus.toUpperCase()))) {
      throw new PlatformError("FORBIDDEN", "账户、会话或选课权限已变化", 403);
    }
    if (row.classroomId !== input.classroomId) throw new PlatformError("QUIZ_SCENE_CHANGED", "课堂学习内容已变化", 409);
    const state = object(row.projectState);
    const stored = state.aiLearningProgress as StudentAiProgress | undefined;
    const progress: StudentAiProgress = stored?.classroomId === input.classroomId ? stored : { classroomId: input.classroomId, studentId: input.studentId, currentSceneIndex: 0, totalScenes: 0, completedScenes: [], lastActiveAt: input.attempt.submittedAt, masteryLevel: "not-started" };
    const attempts = progress.knowledgeLectureAttempts ?? [];
    const existing = attempts.filter(attempt => attempt.quizOutlineId === input.attempt.quizOutlineId).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0];
    const answers = Object.fromEntries(input.attempt.questions.map(question => [question.questionId, question.rawAnswer ?? question.answer]));
    if (existing && (existing.gradingSource !== "server" || !sameSubmittedAnswers(existing, answers))) throw new QuizAlreadySubmittedError(existing);
    let saved: KnowledgeLectureAttempt;
    if (grades) {
      if (!existing || existing.id !== input.attempt.id) throw new PlatformError("QUIZ_ATTEMPT_NOT_FOUND", "找不到已提交答案", 404);
      // Finishing an already accepted request remains valid after classroom closure.
      // Only grading fields can change; prompt/rubric/rawAnswer/ID stay immutable.
      saved = withGradeSummary({ ...existing, questions: existing.questions.map(question => {
        const grade = grades.get(question.questionId);
        return question.gradingStatus === "graded" || !grade ? question : { ...question, earned: grade.earned, correct: grade.correct, gradingStatus: grade.gradingStatus, feedback: grade.feedback };
      }) });
      if (isDeepStrictEqual(saved, existing)) return { attempt: existing };
    } else {
      if (existing) return { attempt: existing };
      if (row.status.toUpperCase() !== "TEACHING" || row.enrollmentStatus.toUpperCase() !== "ACTIVE" || row.offeringStatus.toUpperCase() !== "OPEN" || row.archivedAt) throw new PlatformError("CLASSROOM_READ_ONLY", "课堂当前不可提交新答案", 409);
      saved = input.attempt;
    }
    const nextProgress = { ...progress, knowledgeLectureAttempts: existing ? attempts.map(attempt => attempt.id === existing.id ? saved : attempt) : [...attempts, saved], lastActiveAt: new Date().toISOString() };
    const runtime = object(row.runtimeConfig); const courseVersion = Number(runtime.version ?? 1) + 1;
    const now = new Date();
    const eventPayload = { scope: "student", studentId: input.studentId, courseVersion, classroomId: input.classroomId, attempt: saved };
    const events = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>`WITH course AS (
      UPDATE "ClassroomInstance" SET "runtimeConfig" = ${JSON.stringify({ ...runtime, version: courseVersion })}::jsonb,
        "updatedAt" = ${now} WHERE id = ${input.courseId} RETURNING id
    ), workspace AS (
      INSERT INTO "StudentProjectWorkspace" (id, "participationId", "projectState", "createdAt", "updatedAt")
      SELECT ${randomUUID()}, ${row.participationId}, ${JSON.stringify({ ...state, aiLearningProgress: nextProgress })}::jsonb, ${now}, ${now} FROM course
      ON CONFLICT ("participationId") DO UPDATE SET "projectState" = EXCLUDED."projectState",
        version = "StudentProjectWorkspace".version + 1, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING id
    ), event AS (
      INSERT INTO "DomainEvent" (id, "createdAt", "idempotencyKey", "actorId", "offeringId", "participationId", "researchKey", "classroomInstanceId", "eventType", payload)
      SELECT ${randomUUID()}, ${now}, ${randomUUID()}, ${input.studentId}, ${row.offeringId}, ${row.participationId}, ${row.researchKey}, ${input.courseId},
        ${grades ? "KNOWLEDGE_QUIZ_GRADED" : "KNOWLEDGE_QUIZ_SUBMITTED"}, ${JSON.stringify(eventPayload)}::jsonb FROM workspace
      RETURNING id, "createdAt"
    ) SELECT id, "createdAt" FROM event`;
    if (events.length !== 1) throw new Error("QUIZ_COMMIT_INCOMPLETE");
    const event = events[0];
    return { attempt: saved, notification: { courseVersion, eventCursor: encodeEventCursor(event), at: event.createdAt.toISOString() } };
  }, {
    lowPriorityCourseId: input.courseId,
    admissionTimeoutError: () => new PlatformError("COURSE_BUSY", "课堂保存繁忙，请稍后重试", 503),
  });
  if (result.notification) {
    try { await publishCourseEvent(input.courseId, { type: "course-updated", courseId: input.courseId, at: result.notification.at, payload: { actionType: "UPDATE_COURSE", scope: "student", studentId: input.studentId, courseVersion: result.notification.courseVersion, eventCursor: result.notification.eventCursor } }); }
    catch { console.error("[knowledge-quiz] live notification failed; durable cursor retained", { courseId: input.courseId }); }
  }
  return result.attempt;
}
