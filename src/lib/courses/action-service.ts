import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { isActionAllowed, isStudentActionForSelf } from "@/lib/auth/action-permissions";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { loadCourse, lockProjectedCourse, mutateProjectedCourse } from "@/lib/db/session-repository";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { assertStudentActionScope, StudentActionScopeError } from "./v2-action-scope";
import { PlatformError } from "@/lib/platform/repository";
import { ClassroomProjectionError, json } from "@/lib/db/v2-course-projection";
import type { ActionAck, ActionEnvelope } from "./contracts";
import { publishCourseEvent, type RealtimeEvent } from "@/lib/realtime/event-bus";
import {
  normalizeProjectionPatch,
  projectionPatchFromAction,
  projectionSnapshotFromUiState,
  type ProjectionStateSnapshot,
} from "@/lib/realtime/projection-state";
import type { ClassroomSubmission, Course, CourseUiState } from "@/lib/session/types";
import { createPblTemplateCourse, decodePblTemplate } from "@/lib/platform/pbl-template";
import { CourseReflectionValidationError } from "@/lib/course-reflection";
import { CourseRubricValidationError } from "@/lib/evaluation/course-rubric";

export class CourseActionError extends Error { constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) { super(message); } }

export function checkedSubmissionVersion(expected: number | undefined, current?: ClassroomSubmission): number {
  const currentVersion = current ? current.version ?? 1 : 0;
  if (expected !== currentVersion) {
    throw new CourseActionError("DRAFT_VERSION_CONFLICT", "草稿已在其他窗口更新，请保留本地内容并检查最新版本", 409, { currentVersion, currentSubmission: current ?? null });
  }
  return currentVersion + 1;
}

/** The frequent personal autosave path only loads the author's submission. */
async function savePersonalSubmission(
  tx: Prisma.TransactionClient, courseId: string, envelope: ActionEnvelope, claims: AuthClaims,
  key: string, fingerprint: string,
) {
  if (envelope.action.type !== "UPSERT_SUBMISSION") throw new Error("INVALID_SUBMISSION_ACTION");
  const participation = await tx.classroomParticipation.findFirst({
    where: { instanceId: courseId, enrollment: { userId: claims.sub } },
    include: { enrollment: true, instance: { include: { activity: { include: { chapter: { include: { offering: true } } } } } } },
  });
  if (!participation) throw new CourseActionError("FORBIDDEN_ACTION_SCOPE", "学生未加入课堂", 403);
  const instance = participation.instance;
  if (instance.status !== "TEACHING" || participation.enrollment.status !== "ACTIVE" || instance.activity.chapter.offering.status !== "OPEN") {
    throw new CourseActionError("CLASSROOM_READ_ONLY", "课堂或选课状态已改变，当前仅可查看记录", 409);
  }
  const submitted = envelope.action.payload.submission;
  // Reject reusing another record's logical ID, including group records.
  const sameId = await tx.classroomSubmission.findFirst({ where: {
    participation: { instanceId: courseId }, payload: { path: ["view", "id"], equals: submitted.id },
  } });
  if (sameId && (sameId.participationId !== participation.id || sameId.stageKey !== `${submitted.stageKey}:${submitted.type}`)) {
    throw new CourseActionError("FORBIDDEN_ACTION_SCOPE", "不能覆盖其他课堂记录", 403);
  }
  const where = { participationId_stageKey: { participationId: participation.id, stageKey: `${submitted.stageKey}:${submitted.type}` } };
  const previous = await tx.classroomSubmission.findUnique({ where });
  const previousPayload = asRecord(previous?.payload);
  const current = previous ? asRecord(previousPayload.view ?? previousPayload) as ClassroomSubmission : undefined;
  const submissionVersion = checkedSubmissionVersion(envelope.action.payload.expectedSubmissionVersion, current);
  const now = new Date();
  const submission = { ...submitted, ...(current ? { id: current.id, createdAt: current.createdAt } : {}), version: submissionVersion, updatedAt: now.toISOString() };
  const data = { status: (submission.status ?? "submitted").toUpperCase(), submittedAt: submission.status === "draft" ? null : new Date(submission.submittedAt ?? submission.updatedAt), payload: json({ instanceId: courseId, collection: "submissions", provenance: { actorId: claims.sub, actorRole: "student" }, view: submission }) };
  await tx.classroomSubmission.upsert({ where, create: { participationId: participation.id, stageKey: `${submission.stageKey}:${submission.type}`, ...data }, update: data });
  const runtime = asRecord(instance.runtimeConfig);
  const courseVersion = Number(runtime.version ?? 1) + 1;
  await tx.classroomInstance.update({ where: { id: courseId }, data: { runtimeConfig: json({ ...runtime, version: courseVersion }) } });
  const id = crypto.randomUUID();
  const ack: ActionAck = { requestId: envelope.requestId, courseVersion, submissionVersion, eventCursor: `${now.toISOString()}~${id}` };
  await tx.domainEvent.create({ data: { id, createdAt: now, idempotencyKey: key, actorId: claims.sub, offeringId: participation.enrollment.offeringId, classroomInstanceId: courseId, participationId: participation.id, researchKey: participation.enrollment.researchKey, eventType: "COURSE_ACTION", payload: json({ fingerprint, ack, action: { ...envelope.action, payload: { ...envelope.action.payload, submission } }, scope: "student", studentId: claims.sub }) } });
  return { ack, event: realtimeEventForAction(courseId, envelope, ack, claims) };
}
export async function executeCourseAction(courseId: string, envelope: ActionEnvelope, claims: AuthClaims): Promise<ActionAck> {
  if (!claims.sub || !isActionAllowed(claims.role, envelope.action.type)) throw new CourseActionError("FORBIDDEN_ACTION", "无权执行此操作", 403);
  if (envelope.action.type !== "CREATE_COURSE" && !await canAccessLegacyCourse(claims, courseId, claims.role === "student" ? "write" : "read")) throw new CourseActionError("FORBIDDEN", "课程无权访问或已关闭", 403);
  if (claims.role === "student" && !isStudentActionForSelf(envelope.action, claims.sub, courseId)) throw new CourseActionError("FORBIDDEN", "不能代替其他学生提交", 403);
  if (envelope.action.type === "SET_UI_STATE") {
    const keys = Object.keys(envelope.action.payload.patch);
    if (keys.includes("projectionController")) throw new CourseActionError("FORBIDDEN_ACTION", "投屏控制权由服务器管理", 403);
    if (keys.some(key => key === "resourceProjection" || key === "teacherResourceProjection") && !projectionPatchFromAction(envelope.action)) throw new CourseActionError("INVALID_PROJECTION_PATCH", "投屏控制必须单独提交", 400);
  }
  const projectionPatch = projectionPatchFromAction(envelope.action);
  if (projectionPatch) {
    if (claims.role !== "teacher") throw new CourseActionError("FORBIDDEN_ACTION", "只有教师可以控制课堂投屏", 403);
    return executeProjectionAction(courseId, envelope, claims, projectionPatch);
  }

  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, courseId);
    const key = `course-action:${claims.sub}:${envelope.requestId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify([courseId, envelope.action])).digest("hex");
    const previous = await tx.domainEvent.findUnique({ where: { idempotencyKey: key } });
    if (previous) {
      const payload = previous.payload as { fingerprint: string; ack: ActionAck };
      if (payload.fingerprint !== fingerprint) throw new CourseActionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409);
      return { ack: payload.ack, event: realtimeEventForAction(courseId, envelope, payload.ack, claims) };
    }
    if (claims.role === "student" && envelope.action.type === "UPSERT_SUBMISSION" && envelope.action.payload.submission.studentId === claims.sub && !envelope.action.payload.submission.groupId) {
      return savePersonalSubmission(tx, courseId, envelope, claims, key, fingerprint);
    }
    const before = await loadCourse(courseId, tx);
    if (claims.role === "student") {
      if (!before) throw new CourseActionError("NOT_FOUND", "课堂不存在", 404);
      try { assertStudentActionScope(before, envelope.action, claims.sub!); }
      catch (error) { if (error instanceof StudentActionScopeError) throw new CourseActionError(error.code, error.message, error.status); throw error; }
    }
    if (before && claims.role === "teacher" && envelope.expectedVersion !== undefined && before.version !== envelope.expectedVersion) throw new CourseActionError("VERSION_CONFLICT", "课程已被其他操作更新", 409, { currentVersion: before.version });
    if (before && ["PUBLISH_COURSE", "START_TEACHING", "RESTART_TEACHING"].includes(envelope.action.type)) {
      const { assertCourseTeacherReview, CourseReviewError } = await import("@/lib/course-quality-review/review-service");
      const version = before.platformContext
        ? await tx.classroomTemplateVersion.findUnique({
            where: { id: before.platformContext.templateVersionId },
            select: { snapshot: true },
          })
        : null;
      const reviewCourse = version
        ? courseForTeacherReviewSnapshot(before, version.snapshot)
        : before;
      try { await assertCourseTeacherReview(reviewCourse, claims.sub); }
      catch (error) { if (error instanceof CourseReviewError) throw new CourseActionError(error.code, error.message, error.status); throw error; }
    }
    if (claims.role === "student" && before && envelope.action.type === "UPSERT_SUBMISSION") {
      const submission = envelope.action.payload.submission;
      const current = before.submissions?.find(row => row.id === submission.id || (row.studentId === submission.studentId && row.groupId === submission.groupId && row.stageKey === submission.stageKey && row.type === submission.type));
      const version = checkedSubmissionVersion(envelope.action.payload.expectedSubmissionVersion, current);
      envelope = { ...envelope, action: { ...envelope.action, payload: { ...envelope.action.payload, submission: { ...submission, version } } } };
    }
    let after;
    try { after = await mutateProjectedCourse(tx, envelope.action, claims.role === "teacher" ? claims.sub : undefined, { id: claims.sub!, role: claims.role }, before); }
    catch (error) {
      if (error instanceof ClassroomProjectionError || error instanceof PlatformError) throw new CourseActionError(error.code, error.message, error.status);
      if (error instanceof CourseReflectionValidationError) throw new CourseActionError("INVALID_COURSE_REFLECTION", error.message, 422);
      if (error instanceof CourseRubricValidationError) throw new CourseActionError("INVALID_COURSE_RUBRIC", error.message, 422);
      throw error;
    }
    const instance = await tx.classroomInstance.findUnique({ where: { id: courseId }, include: { activity: { include: { chapter: true } } } });
    const participation = instance && claims.role === "student" ? await tx.classroomParticipation.findFirst({ where: { instanceId: instance.id, enrollment: { userId: claims.sub } }, include: { enrollment: true } }) : null;
    const now = new Date(); const id = crypto.randomUUID();
    const ack = { requestId: envelope.requestId, courseVersion: after?.version ?? (before?.version ?? 0) + 1, eventCursor: `${now.toISOString()}~${id}`, ...(envelope.action.type === "UPSERT_SUBMISSION" ? { submissionVersion: envelope.action.payload.submission.version } : {}) };
    await tx.domainEvent.create({ data: { id, createdAt: now, idempotencyKey: key, actorId: claims.sub, offeringId: instance?.activity.chapter.offeringId, classroomInstanceId: instance?.id, participationId: participation?.id, researchKey: participation?.enrollment.researchKey, eventType: "COURSE_ACTION", payload: JSON.parse(JSON.stringify({ fingerprint, ack, action: envelope.action, ...(!instance ? { templateId: courseId } : {}), scope: claims.role === "student" ? "student" : "course", studentId: participation?.enrollment.userId })) } });
    return { ack, event: realtimeEventForAction(courseId, envelope, ack, claims) };
  });
  await publishRealtimeEvent(result.event);
  return result.ack;
}

/**
 * A classroom projection also contains offering/activity resources added after
 * publication. Teacher review belongs to the immutable template version, so
 * revalidate that exact snapshot instead of the enriched classroom projection.
 */
export function courseForTeacherReviewSnapshot(
  course: Course,
  snapshot: unknown,
): Course {
  const design = decodePblTemplate(snapshot);
  if (!design) return course;
  const reviewedCourseId = design.content.teacherReview?.courseId
    ?? course.content.teacherReview?.courseId
    ?? course.platformContext?.templateId
    ?? course.id;
  return createPblTemplateCourse(reviewedCourseId, design);
}

async function executeProjectionAction(
  courseId: string,
  envelope: ActionEnvelope,
  claims: AuthClaims,
  requestedPatch: NonNullable<ReturnType<typeof projectionPatchFromAction>>,
): Promise<ActionAck> {
  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, courseId);
    const key = `course-action:${claims.sub}:${envelope.requestId}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([courseId, envelope.action]))
      .digest("hex");
    const previous = await tx.domainEvent.findUnique({ where: { idempotencyKey: key } });
    if (previous) {
      const payload = asRecord(previous.payload) as {
        fingerprint?: string;
        ack?: ActionAck;
        projection?: ProjectionStateSnapshot;
      };
      if (payload.fingerprint !== fingerprint || !payload.ack || !payload.projection) {
        throw new CourseActionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409);
      }
      return {
        ack: payload.ack,
        event: projectionRealtimeEvent(payload.projection, payload.ack.eventCursor),
      };
    }

    const instance = await tx.classroomInstance.findUnique({
      where: { id: courseId },
      select: {
        runtimeConfig: true,
        activity: { select: { chapter: { select: { offeringId: true } } } },
      },
    });
    if (!instance) throw new CourseActionError("NOT_FOUND", "课堂不存在", 404);

    const runtime = asRecord(instance.runtimeConfig);
    const currentUiState = asRecord(runtime.uiState) as CourseUiState;
    const control = envelope.action.type === "SET_UI_STATE" ? envelope.action.payload.projectionControl : undefined;
    if (!control?.clientId) throw new CourseActionError("PROJECTION_CLIENT_REQUIRED", "投屏请求缺少控制端标识", 400);
    const owner = currentUiState.projectionController;
    if (owner && (owner.teacherId !== claims.sub || owner.clientId !== control.clientId) && !control.takeover) {
      throw new CourseActionError("PROJECTION_CONTROL_CONFLICT", "另一位教师或窗口正在控制投屏，请显式接管", 409, { controller: owner });
    }
    const currentProjectionVersion = Number(currentUiState.projectionVersion ?? 0);
    const projectionVersion = Number.isSafeInteger(currentProjectionVersion)
      && currentProjectionVersion >= 0
      ? currentProjectionVersion + 1
      : 1;
    const currentCourseVersion = Number(runtime.version ?? 1);
    const courseVersion = Number.isSafeInteger(currentCourseVersion)
      && currentCourseVersion >= 0
      ? currentCourseVersion + 1
      : 2;
    const now = new Date();
    const serverTime = now.toISOString();
    const patch = normalizeProjectionPatch(
      requestedPatch,
      projectionVersion,
      serverTime,
    );
    const uiState: CourseUiState = {
      ...currentUiState,
      ...patch,
      projectionController: { teacherId: claims.sub!, clientId: control.clientId },
      projectionVersion,
      projectionUpdatedAt: serverTime,
    };
    const projection = projectionSnapshotFromUiState({
      courseId,
      courseVersion,
      uiState,
      serverTime,
    });
    const eventId = crypto.randomUUID();
    const eventCursor = `${serverTime}~${eventId}`;
    const ack: ActionAck = {
      requestId: envelope.requestId,
      courseVersion,
      eventCursor,
      projection,
    };

    await tx.classroomInstance.update({
      where: { id: courseId },
      data: {
        runtimeConfig: json({ ...runtime, version: courseVersion, uiState }),
      },
    });
    await tx.domainEvent.create({
      data: {
        id: eventId,
        createdAt: now,
        idempotencyKey: key,
        actorId: claims.sub,
        offeringId: instance.activity.chapter.offeringId,
        classroomInstanceId: courseId,
        eventType: "projection-changed",
        payload: json({
          fingerprint,
          ack,
          projection,
          actionType: "SET_UI_STATE",
          scope: "course",
          courseVersion,
        }),
      },
    });
    return { ack, event: projectionRealtimeEvent(projection, eventCursor) };
  });
  await publishRealtimeEvent(result.event);
  return result.ack;
}

function realtimeEventForAction(
  courseId: string,
  envelope: ActionEnvelope,
  ack: ActionAck,
  claims: AuthClaims,
): RealtimeEvent {
  return {
    type: "course-updated",
    courseId,
    at: new Date().toISOString(),
    payload: {
      actionType: envelope.action.type,
      courseVersion: ack.courseVersion,
      eventCursor: ack.eventCursor,
      scope: claims.role === "student" ? "student" : "course",
      ...(claims.role === "student" && claims.sub ? { studentId: claims.sub } : {}),
    },
  };
}

function projectionRealtimeEvent(
  projection: ProjectionStateSnapshot,
  eventCursor: string,
): RealtimeEvent {
  return {
    type: "projection-changed",
    courseId: projection.courseId,
    at: projection.projectionUpdatedAt,
    payload: {
      actionType: "SET_UI_STATE",
      scope: "course",
      eventCursor,
      ...projection,
    },
  };
}

async function publishRealtimeEvent(event: RealtimeEvent): Promise<void> {
  try {
    await publishCourseEvent(event.courseId, event);
  } catch (error) {
    console.error("[course-actions] realtime publish failed; projection polling will reconcile", {
      courseId: event.courseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
