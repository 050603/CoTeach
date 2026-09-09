import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { isActionAllowed, isStudentActionForSelf } from "@/lib/auth/action-permissions";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { loadCourse, lockProjectedCourse, mutateProjectedCourse } from "@/lib/db/session-repository";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { assertStudentActionScope, StudentActionScopeError } from "./v2-action-scope";
import { PlatformError } from "@/lib/platform/repository";
import { ClassroomProjectionError } from "@/lib/db/v2-course-projection";
import type { ActionAck, ActionEnvelope } from "./contracts";

export class CourseActionError extends Error { constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) { super(message); } }
export async function executeCourseAction(courseId: string, envelope: ActionEnvelope, claims: AuthClaims): Promise<ActionAck> {
  if (!claims.sub || !isActionAllowed(claims.role, envelope.action.type)) throw new CourseActionError("FORBIDDEN_ACTION", "无权执行此操作", 403);
  if (envelope.action.type !== "CREATE_COURSE" && !await canAccessLegacyCourse(claims, courseId, claims.role === "student" ? "write" : "read")) throw new CourseActionError("FORBIDDEN", "课程无权访问或已关闭", 403);
  if (claims.role === "student" && !isStudentActionForSelf(envelope.action, claims.sub, courseId)) throw new CourseActionError("FORBIDDEN", "不能代替其他学生提交", 403);
  return runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, courseId);
    const key = `course-action:${claims.sub}:${envelope.requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify([courseId, envelope.action])).digest("hex");
    const previous = await tx.domainEvent.findUnique({ where: { idempotencyKey: key } });
    if (previous) { const payload = previous.payload as { fingerprint: string; ack: ActionAck }; if (payload.fingerprint !== fingerprint) throw new CourseActionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409); return payload.ack; }
    const before = await loadCourse(courseId, tx);
    if (claims.role === "student") {
      if (!before) throw new CourseActionError("NOT_FOUND", "课堂不存在", 404);
      try { assertStudentActionScope(before, envelope.action, claims.sub!); }
      catch (error) { if (error instanceof StudentActionScopeError) throw new CourseActionError(error.code, error.message, error.status); throw error; }
    }
    if (before && claims.role === "teacher" && envelope.expectedVersion !== undefined && before.version !== envelope.expectedVersion) throw new CourseActionError("VERSION_CONFLICT", "课程已被其他操作更新", 409, { currentVersion: before.version });
    let after;
    try { after = await mutateProjectedCourse(tx, envelope.action, claims.role === "teacher" ? claims.sub : undefined, { id: claims.sub!, role: claims.role }); }
    catch (error) { if ((error instanceof ClassroomProjectionError || error instanceof PlatformError)) throw new CourseActionError(error.code, error.message, error.status); throw error; }
    const instance = await tx.classroomInstance.findUnique({ where: { id: courseId }, include: { activity: { include: { chapter: true } } } });
    const participation = instance && claims.role === "student" ? await tx.classroomParticipation.findFirst({ where: { instanceId: instance.id, enrollment: { userId: claims.sub } }, include: { enrollment: true } }) : null;
    const now = new Date(); const id = crypto.randomUUID();
    const ack = { requestId: envelope.requestId, courseVersion: after?.version ?? (before?.version ?? 0) + 1, eventCursor: `${now.toISOString()}~${id}` };
    await tx.domainEvent.create({ data: { id, createdAt: now, idempotencyKey: key, actorId: claims.sub, offeringId: instance?.activity.chapter.offeringId, classroomInstanceId: instance?.id, participationId: participation?.id, researchKey: participation?.enrollment.researchKey, eventType: "COURSE_ACTION", payload: JSON.parse(JSON.stringify({ fingerprint, ack, action: envelope.action, ...(!instance ? { templateId: courseId } : {}), scope: claims.role === "student" ? "student" : "course", studentId: participation?.enrollment.userId })) } });
    return ack;
  });
}
export function applyLearningEvidenceReview(
  value: unknown,
  review: {
    evidenceId: string;
    status: "teacher-confirmed" | "needs-revision";
    feedback?: string;
    reviewedAt: string;
  },
): Prisma.JsonValue[] | null {
  if (!Array.isArray(value)) return null;
  let found = false;
  const feedback = review.feedback?.trim();
  const records = value.map((item) => {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || (item as { id?: unknown }).id !== review.evidenceId
    ) {
      return item as Prisma.JsonValue;
    }
    found = true;
    const updated = {
      ...(item as Prisma.JsonObject),
      status: review.status,
      updatedAt: review.reviewedAt,
    } as Prisma.JsonObject;
    if (feedback) updated.teacherFeedback = feedback;
    else delete updated.teacherFeedback;
    if (review.status === "teacher-confirmed") {
      updated.confirmedAt = review.reviewedAt;
    } else {
      delete updated.confirmedAt;
    }
    return updated;
  });
  return found ? records : null;
}
