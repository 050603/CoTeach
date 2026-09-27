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
  const submitted = envelope.action.payload.submission;
  const stageKey = `${submitted.stageKey}:${submitted.type}`;
  const groupId = submitted.groupId || null;
  const [participation] = await tx.$queryRaw<Array<{
    id: string; offeringId: string; researchKey: string; enrollmentStatus: string;
    instanceStatus: string; runtimeVersion: unknown; offeringStatus: string; archivedAt: Date | null;
    groupAllowed: boolean; identityConflict: boolean; currentPayload: unknown | null;
    userStatus: string; userRole: string; sessionVersion: number; receipt: unknown | null;
  }>>`SELECT p.id, e."offeringId", e."researchKey", e.status AS "enrollmentStatus",
      ci.status AS "instanceStatus", ci."runtimeConfig" -> 'version' AS "runtimeVersion", o.status AS "offeringStatus", a."archivedAt",
      CASE WHEN own.id IS NOT NULL THEN COALESCE((SELECT jsonb_object_agg(field.key, field.value)
        FROM jsonb_each(CASE WHEN jsonb_typeof(COALESCE(NULLIF(own.payload -> 'view', 'null'::jsonb), own.payload)) = 'object'
          THEN COALESCE(NULLIF(own.payload -> 'view', 'null'::jsonb), own.payload) ELSE '{}'::jsonb END) field
        WHERE field.key IN ('id', 'studentId', 'groupId', 'version', 'createdAt')), '{}'::jsonb) END AS "currentPayload", u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
      (SELECT jsonb_build_object('fingerprint', d.payload -> 'fingerprint', 'ack', d.payload -> 'ack')
        FROM "DomainEvent" d WHERE d."idempotencyKey" = ${key}) AS receipt,
      (${groupId}::text IS NULL OR EXISTS (
        SELECT 1 FROM "GroupMember" gm JOIN "ProjectGroup" g ON g.id = gm."groupId"
        WHERE gm."userId" = e."userId" AND gm."leftAt" IS NULL AND g."offeringId" = o.id
          AND (g.id = ${groupId} OR (starts_with(${groupId}::text, 'grp-') AND g.id = o.id || ':' || ${groupId}))
      )) AS "groupAllowed",
      EXISTS (SELECT 1 FROM "ClassroomSubmission" other JOIN "ClassroomParticipation" op ON op.id = other."participationId"
        WHERE op."instanceId" = ci.id AND other.payload #>> '{view,id}' = ${submitted.id}
          AND (other."participationId" <> p.id OR other."stageKey" <> ${stageKey})) AS "identityConflict"
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "User" u ON u.id = e."userId"
    JOIN "ClassroomInstance" ci ON ci.id = p."instanceId" JOIN "Activity" a ON a.id = ci."activityId"
    JOIN "Chapter" c ON c.id = a."chapterId" JOIN "CourseOffering" o ON o.id = c."offeringId"
    LEFT JOIN "ClassroomSubmission" own ON own."participationId" = p.id AND own."stageKey" = ${stageKey}
    WHERE p."instanceId" = ${courseId} AND e."userId" = ${claims.sub} AND e."offeringId" = o.id`;
  if (!participation) throw new CourseActionError("FORBIDDEN_ACTION_SCOPE", "学生未加入课堂", 403);
  // Authorize even receipt replays against current identity and owned enrollment.
  if (participation.userStatus.toUpperCase() !== "ACTIVE" || participation.userRole.toUpperCase() !== "STUDENT"
    || participation.sessionVersion !== claims.sv || !["ACTIVE", "COMPLETED"].includes(participation.enrollmentStatus.toUpperCase())) {
    throw new CourseActionError("FORBIDDEN", "账户或选课状态已变化，请重新登录或检查课堂权限", 403);
  }
  if (participation.receipt) {
    const payload = participation.receipt as { fingerprint: string; ack: ActionAck };
    if (payload.fingerprint !== fingerprint) throw new CourseActionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409);
    return { ack: payload.ack, event: realtimeEventForAction(courseId, envelope, payload.ack, claims) };
  }
  if (participation.instanceStatus.toUpperCase() !== "TEACHING" || participation.enrollmentStatus.toUpperCase() !== "ACTIVE" || participation.offeringStatus.toUpperCase() !== "OPEN" || participation.archivedAt) {
    throw new CourseActionError("CLASSROOM_READ_ONLY", "课堂或选课状态已改变，当前仅可查看记录", 409);
  }
  if (!participation.groupAllowed || participation.identityConflict) throw new CourseActionError("FORBIDDEN_ACTION_SCOPE", "草稿小组或记录不属于当前学生", 403);
  const previousPayload = asRecord(participation.currentPayload);
  const current = participation.currentPayload ? asRecord(previousPayload.view ?? previousPayload) as ClassroomSubmission : undefined;
  if (current && (current.studentId !== submitted.studentId || current.groupId !== submitted.groupId)) throw new CourseActionError("FORBIDDEN_ACTION_SCOPE", "不能变更草稿归属", 403);
  if (envelope.action.payload.expectedSubmissionVersion !== (current ? current.version ?? 1 : 0)) {
    // Full document bodies cross the database boundary only for conflict recovery.
    // Both locks are still held, so this is the same revision as the metadata read.
    const latest = await tx.classroomSubmission.findUnique({
      where: { participationId_stageKey: { participationId: participation.id, stageKey } }, select: { payload: true },
    });
    const payload = asRecord(latest?.payload);
    checkedSubmissionVersion(envelope.action.payload.expectedSubmissionVersion, latest ? asRecord(payload.view ?? payload) as ClassroomSubmission : undefined);
  }
  const submissionVersion = checkedSubmissionVersion(envelope.action.payload.expectedSubmissionVersion, current);
  const now = new Date();
  const submission = { ...submitted, ...(current ? { id: current.id, createdAt: current.createdAt } : {}), version: submissionVersion, updatedAt: now.toISOString() };
  // Raw SQL consumes JSON text directly. Avoid normalizing the complete document
  // through stringify/parse only to stringify it again for the same parameter.
  const data = { status: (submission.status ?? "submitted").toUpperCase(), submittedAt: submission.status === "draft" ? null : new Date(submission.submittedAt ?? submission.updatedAt), payload: JSON.stringify({ instanceId: courseId, collection: "submissions", provenance: { actorId: claims.sub, actorRole: "student" }, view: submission }) };
  const courseVersion = Number(participation.runtimeVersion ?? 1) + 1;
  const id = crypto.randomUUID();
  const ack: ActionAck = { requestId: envelope.requestId, courseVersion, submissionVersion, eventCursor: `${now.toISOString()}~${id}` };
  const receiptPayload = { fingerprint, ack, action: { ...envelope.action, payload: { ...envelope.action.payload, submission } }, scope: "student", studentId: claims.sub };
  // Keep the lock and fresh reads separate; only the three durable writes share a statement.
  const committed = await tx.$queryRaw<Array<{ id: string }>>`WITH course AS (
    UPDATE "ClassroomInstance" SET "runtimeConfig" = jsonb_set(
      CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END,
      '{version}', ${JSON.stringify(courseVersion)}::jsonb, true),
      "updatedAt" = ${now} WHERE id = ${courseId} RETURNING id
  ), submission AS (
    INSERT INTO "ClassroomSubmission" (id, "participationId", "stageKey", status, "submittedAt", payload, "createdAt", "updatedAt")
    SELECT ${crypto.randomUUID()}, ${participation.id}, ${stageKey}, ${data.status}, ${data.submittedAt}, ${data.payload}::jsonb, ${now}, ${now} FROM course
    ON CONFLICT ("participationId", "stageKey") DO UPDATE SET status = EXCLUDED.status,
      "submittedAt" = EXCLUDED."submittedAt", payload = EXCLUDED.payload, "updatedAt" = EXCLUDED."updatedAt"
    RETURNING id
  ), receipt AS (
    INSERT INTO "DomainEvent" (id, "createdAt", "idempotencyKey", "actorId", "offeringId", "classroomInstanceId", "participationId", "researchKey", "eventType", payload)
    SELECT ${id}, ${now}, ${key}, ${claims.sub}, ${participation.offeringId}, ${courseId}, ${participation.id}, ${participation.researchKey}, 'COURSE_ACTION', ${JSON.stringify(receiptPayload)}::jsonb FROM submission
    RETURNING id
  ) SELECT id FROM receipt`;
  if (committed.length !== 1) throw new Error("DRAFT_COMMIT_INCOMPLETE");
  return { ack, event: realtimeEventForAction(courseId, envelope, ack, claims) };
}
export async function executeCourseAction(courseId: string, envelope: ActionEnvelope, claims: AuthClaims, mark?: (phase: string) => void): Promise<ActionAck> {
  if (!claims.sub || !isActionAllowed(claims.role, envelope.action.type)) throw new CourseActionError("FORBIDDEN_ACTION", "无权执行此操作", 403);
  const personalSubmission = claims.role === "student" && envelope.action.type === "UPSERT_SUBMISSION"
    && envelope.action.payload.submission.studentId === claims.sub;
  if (claims.role === "student" && !isStudentActionForSelf(envelope.action, claims.sub, courseId)) throw new CourseActionError("FORBIDDEN", "不能代替其他学生提交", 403);
  if (envelope.action.type === "SET_UI_STATE") {
    const keys = Object.keys(envelope.action.payload.patch);
    if (keys.includes("projectionController")) throw new CourseActionError("FORBIDDEN_ACTION", "投屏控制权由服务器管理", 403);
    if (keys.some(key => key === "resourceProjection" || key === "teacherResourceProjection") && !projectionPatchFromAction(envelope.action)) throw new CourseActionError("INVALID_PROJECTION_PATCH", "投屏控制必须单独提交", 400);
  }
  const projectionPatch = projectionPatchFromAction(envelope.action);
  if (projectionPatch) {
    if (claims.role !== "teacher") throw new CourseActionError("FORBIDDEN_ACTION", "只有教师可以控制课堂投屏", 403);
    return executeProjectionAction(courseId, envelope, claims, projectionPatch, mark);
  }
  // Personal drafts and projection controls authorize in their fresh locked scope read.
  if (!personalSubmission && envelope.action.type !== "CREATE_COURSE" && !await canAccessLegacyCourse(claims, courseId, "read")) throw new CourseActionError("FORBIDDEN", "课程无权访问或已关闭", 403);

  const key = `course-action:${claims.sub}:${envelope.requestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify([courseId, envelope.action])).digest("hex");
  const result = await runMutationTransaction(async tx => {
    await lockProjectedCourse(tx, courseId);
    if (personalSubmission) return savePersonalSubmission(tx, courseId, envelope, claims, key, fingerprint);
    const previous = await tx.domainEvent.findUnique({ where: { idempotencyKey: key } });
    if (previous) {
      const payload = previous.payload as { fingerprint: string; ack: ActionAck };
      if (payload.fingerprint !== fingerprint) throw new CourseActionError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他内容", 409);
      return { ack: payload.ack, event: realtimeEventForAction(courseId, envelope, payload.ack, claims) };
    }
    const before = await loadCourse(courseId, tx);
    if (before && envelope.action.type === "UPDATE_COURSE" && envelope.action.payload.patch.uiState) {
      const patch = envelope.action.payload.patch;
      const transition = (patch.currentStageIndex !== undefined && patch.currentStageIndex !== before.currentStageIndex) || (patch.status !== undefined && patch.status !== before.status);
      for (const field of ["resourceProjection", "teacherResourceProjection", "projectionController", "projectionVersion", "projectionUpdatedAt"] as const) {
        if (!transition && Object.hasOwn(patch.uiState!, field) && JSON.stringify(patch.uiState?.[field] ?? null) !== JSON.stringify(before.uiState?.[field] ?? null)) throw new CourseActionError("INVALID_PROJECTION_PATCH", "请通过投屏控制通道更新投屏", 400);
      }
      if (!transition) envelope = { ...envelope, action: { ...envelope.action, payload: { ...envelope.action.payload, patch: { ...patch, uiState: { ...before.uiState, ...patch.uiState } } } } };
    }
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
    try { after = await mutateProjectedCourse(tx, envelope.action, claims.role === "teacher" ? claims.sub : undefined, { id: claims.sub!, role: claims.role }, before, { skipStageReadback: envelope.action.type === "SET_STAGE" }); }
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
  }, personalSubmission ? {
    lowPriorityCourseId: courseId,
    admissionTimeoutError: () => new CourseActionError("COURSE_BUSY", "课堂保存繁忙，请稍后重试", 503),
  } : undefined);
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
  mark?: (phase: string) => void,
): Promise<ActionAck> {
  const result = await runMutationTransaction(async tx => {
    mark?.("transaction");
    await lockProjectedCourse(tx, courseId);
    mark?.("locks");
    const key = `course-action:${claims.sub}:${envelope.requestId}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([courseId, envelope.action]))
      .digest("hex");
    // A separate statement after both locks observes the latest runtime and authorization.
    // Receipt replay must also honor revoked membership, account and session state.
    const [instance] = await tx.$queryRaw<Array<{
      runtimeConfig: unknown; offeringId: string; userStatus: string; userRole: string;
      sessionVersion: number; isTeacher: boolean; receipt: unknown | null;
    }>>`SELECT ci."runtimeConfig", c."offeringId", u.status AS "userStatus",
        u.role AS "userRole", u."sessionVersion",
        EXISTS (SELECT 1 FROM "CourseTeacher" ct WHERE ct."offeringId" = c."offeringId"
          AND ct."userId" = u.id) AS "isTeacher",
        (SELECT d.payload FROM "DomainEvent" d WHERE d."idempotencyKey" = ${key}) AS receipt
      FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
      JOIN "Chapter" c ON c.id = a."chapterId" CROSS JOIN "User" u
      WHERE ci.id = ${courseId} AND u.id = ${claims.sub}`;
    mark?.("scope");
    if (!instance || instance.userStatus.toUpperCase() !== "ACTIVE"
      || instance.userRole.toUpperCase() !== "TEACHER" || instance.sessionVersion !== claims.sv
      || !instance.isTeacher) throw new CourseActionError("FORBIDDEN", "账户或授课权限已变化，请重新登录或检查课堂权限", 403);
    if (instance.receipt) {
      const payload = asRecord(instance.receipt) as {
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
    if (!uiState.resourceProjection && !uiState.teacherResourceProjection) uiState.projectionController = null;
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

    // Keep the runtime change and its replay receipt in one dependent statement.
    // The existing advisory/row locks and fresh authorization above remain unchanged.
    const written = await tx.$executeRaw`WITH updated AS (
      UPDATE "ClassroomInstance" SET "runtimeConfig" = ${JSON.stringify({ ...runtime, version: courseVersion, uiState })}::jsonb,
        "updatedAt" = ${now} WHERE id = ${courseId} RETURNING id
    ) INSERT INTO "DomainEvent" (id, "createdAt", "idempotencyKey", "actorId", "offeringId", "classroomInstanceId", "eventType", payload)
      SELECT ${eventId}, ${now}, ${key}, ${claims.sub}, ${instance.offeringId}, updated.id,
        'projection-changed', ${JSON.stringify({ fingerprint, ack, projection, actionType: "SET_UI_STATE", scope: "course", courseVersion })}::jsonb
      FROM updated`;
    mark?.("write");
    if (written !== 1) throw new CourseActionError("COURSE_NOT_FOUND", "课堂不存在", 404);
    return { ack, event: projectionRealtimeEvent(projection, eventCursor) };
  });
  mark?.("commit");
  await publishRealtimeEvent(result.event);
  mark?.("notification");
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
