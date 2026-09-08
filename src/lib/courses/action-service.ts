import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthClaims } from "@/lib/auth/session";
import { isActionAllowed, isStudentActionForSelf } from "@/lib/auth/action-permissions";
import type { SessionAction } from "@/lib/session/actions";
import { dispatchAction as dispatchLegacyAction } from "@/lib/db/session-repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { lockCourseMutation } from "@/lib/db/course-mutation-lock";
import { reconcileUploadReferences } from "@/lib/uploads/reference-tracker";
import { inferStageCollectionMode } from "@/lib/system-mode";
import { canAccessLegacyCourse, findLegacyParticipation } from "@/lib/platform/access";
import type { ActionAck, ActionEnvelope } from "./contracts";

const DIRECT_ACTIONS = new Set<SessionAction["type"]>([
  "UPSERT_SUBMISSION",
  "UPDATE_STUDENT_PROGRESS",
  "SET_STUDENT_TODO_COMPLETION",
  "MARK_RESOURCE_DOWNLOADED",
  "ADD_ANNOUNCEMENT_REPLY",
  "JOIN_GROUP",
  "LEAVE_GROUP",
  "REVIEW_LEARNING_EVIDENCE",
  "SET_UI_STATE",
]);

export class CourseActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function executeCourseAction(
  courseId: string,
  envelope: ActionEnvelope,
  claims: AuthClaims,
): Promise<ActionAck> {
  let currentEnvelope = envelope;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await executeCourseActionOnce(courseId, currentEnvelope, claims);
    } catch (error) {
      const currentVersion = versionConflictCurrentVersion(error);
      if (claims.role !== "student" || currentVersion === undefined || attempt >= 3) {
        throw error;
      }
      // Student companion turns persist several adjacent records and may race
      // with realtime/presence writes. The action is identity-scoped and the
      // requestId remains unchanged, so rebasing it on the latest version is
      // safe and preserves idempotency without exposing a transient 409.
      currentEnvelope = { ...currentEnvelope, expectedVersion: currentVersion };
    }
  }
}

async function executeCourseActionOnce(
  courseId: string,
  envelope: ActionEnvelope,
  claims: AuthClaims,
): Promise<ActionAck> {
  const action = envelope.action;
  if (!isActionAllowed(claims.role, action.type)) {
    throw new CourseActionError("FORBIDDEN_ACTION", "Action is not allowed for this role.", 403);
  }
  if (!(await canAccessLegacyCourse(claims, courseId, claims.role === "student" ? "write" : "read"))) {
    throw new CourseActionError("FORBIDDEN", "课程不属于当前会话，或当前课程已锁定。", 403);
  }
  if (
    claims.role === "student" &&
    (!isStudentActionForSelf(action, claims.studentId, claims.courseId) ||
      claims.courseId !== courseId)
  ) {
    throw new CourseActionError("FORBIDDEN", "Action is outside the signed-in course or student.", 403);
  }
  const existing = await prisma.courseMutationReceipt.findUnique({
    where: { requestId: envelope.requestId },
  });
  if (existing) return receiptToAck(existing);

  if (DIRECT_ACTIONS.has(action.type)) {
    const ack = await executeDirect(courseId, envelope, claims);
    await publishAckEvent(courseId, action, ack);
    return ack;
  }
  const ack = await executeLegacyWithReservation(courseId, envelope, claims);
  await publishAckEvent(courseId, action, ack);
  return ack;
}

function versionConflictCurrentVersion(error: unknown): number | undefined {
  if (
    !(error instanceof CourseActionError)
    || error.code !== "VERSION_CONFLICT"
    || error.status !== 409
    || !error.details
    || typeof error.details !== "object"
    || !("currentVersion" in error.details)
  ) {
    return undefined;
  }
  const currentVersion = error.details.currentVersion;
  return Number.isSafeInteger(currentVersion) && Number(currentVersion) > 0
    ? Number(currentVersion)
    : undefined;
}

async function executeDirect(
  courseId: string,
  envelope: ActionEnvelope,
  claims: AuthClaims,
): Promise<ActionAck> {
  try {
    return await runMutationTransaction(
      async (tx) => {
        // Serialize only this course's short mutation transaction. This keeps
        // unrelated courses concurrent and prevents avoidable 40001 retries on
        // the shared Course.version row.
        await lockCourseMutation(tx, courseId);
        await tx.courseMutationReceipt.create({
          data: {
            requestId: envelope.requestId,
            courseId,
            actorId: claims.sub!,
          },
        });
        const course = await tx.course.findUnique({
          where: { id: courseId },
          select: { version: true },
        });
        if (!course) throw new CourseActionError("COURSE_NOT_FOUND", "Course not found.", 404);
        if (
          envelope.expectedVersion !== undefined &&
          course.version !== envelope.expectedVersion
        ) {
          throw new CourseActionError(
            "VERSION_CONFLICT",
            "Course was updated by another request.",
            409,
            { currentVersion: course.version },
          );
        }

        await applyDirectMutation(tx, courseId, envelope.action);
        await attachLegacyRecordsToParticipation(tx, courseId, claims);
        const updated = await tx.course.update({
          where: { id: courseId },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        const event = await tx.courseEvent.create({
          data: {
            courseId,
            requestId: envelope.requestId,
            type: envelope.action.type,
            actorId: claims.sub!,
            actorRole: claims.role,
            courseVersion: updated.version,
            ...(durableEventPayload(envelope.action)
              ? { payload: toJson(durableEventPayload(envelope.action)) }
              : {}),
          },
          select: { cursor: true },
        });
        await tx.courseMutationReceipt.update({
          where: { requestId: envelope.requestId },
          data: {
            status: "completed",
            courseVersion: updated.version,
            eventCursor: event.cursor,
            completedAt: new Date(),
          },
        });
        return {
          requestId: envelope.requestId,
          courseVersion: updated.version,
          eventCursor: event.cursor.toString(),
        };
      },
    );
  } catch (error) {
    return resolveDuplicateOrThrow(envelope.requestId, error);
  }
}

async function applyDirectMutation(
  tx: Prisma.TransactionClient,
  courseId: string,
  action: SessionAction,
): Promise<void> {
  if (action.type === "SET_UI_STATE") {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: {
        uiState: true,
        status: true,
        currentStageIndex: true,
        stages: true,
      },
    });
    if (!course) {
      throw new CourseActionError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const currentUiState = course.uiState
      && typeof course.uiState === "object"
      && !Array.isArray(course.uiState)
      ? course.uiState as Record<string, unknown>
      : {};
    await tx.course.update({
      where: { id: courseId },
      data: {
        uiState: toJson({ ...currentUiState, ...action.payload.patch }),
      },
    });

    // Resource projection and student showcase share the classroom viewport.
    // Preserve the legacy lifecycle while keeping high-frequency media state
    // updates on this small, single-row mutation path.
    const startsProjection = Boolean(
      action.payload.patch.resourceProjection
      || action.payload.patch.teacherResourceProjection,
    );
    const stages = Array.isArray(course.stages)
      ? course.stages.filter((stage): stage is { key: string } => Boolean(
          stage
          && typeof stage === "object"
          && !Array.isArray(stage)
          && typeof (stage as { key?: unknown }).key === "string",
        ))
      : [];
    if (
      startsProjection
      && course.status === "teaching"
      && stages[course.currentStageIndex]?.key === "showcase"
      && inferStageCollectionMode(stages) === "new"
    ) {
      const endedAt = new Date();
      await tx.showcasePresentation.updateMany({
        where: { courseId, status: "pending" },
        data: { status: "cancelled", endedAt, revision: { increment: 1 } },
      });
      await tx.showcasePresentation.updateMany({
        where: { courseId, status: { in: ["active", "evaluating"] } },
        data: { status: "ended", endedAt, revision: { increment: 1 } },
      });
    }
    return;
  }
  if (action.type === "REVIEW_LEARNING_EVIDENCE") {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: { learningEvidence: true },
    });
    if (!course) {
      throw new CourseActionError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const learningEvidence = applyLearningEvidenceReview(
      course.learningEvidence,
      action.payload,
    );
    if (!learningEvidence) {
      throw new CourseActionError(
        "EVIDENCE_NOT_FOUND",
        "Learning evidence not found.",
        404,
      );
    }
    await tx.course.update({
      where: { id: courseId },
      data: { learningEvidence: toJson(learningEvidence) },
    });
    return;
  }
  if (action.type === "UPSERT_SUBMISSION") {
    const submission = action.payload.submission;
    const previous = await tx.classroomSubmission.findUnique({
      where: { courseId_id: { courseId, id: submission.id } },
      select: { payload: true },
    });
    await tx.classroomSubmission.upsert({
      where: { courseId_id: { courseId, id: submission.id } },
      create: {
        id: submission.id,
        courseId,
        studentId: submission.studentId ?? "",
        studentName: submission.studentName ?? "",
        stageKey: submission.stageKey,
        groupId: submission.groupId ?? null,
        status: "draft",
        payload: toJson({
          type: submission.type,
          title: submission.title,
          content: submission.content,
          files: submission.files,
        }),
      },
      update: {
        studentName: submission.studentName ?? "",
        stageKey: submission.stageKey,
        groupId: submission.groupId ?? null,
        payload: toJson({
          type: submission.type,
          title: submission.title,
          content: submission.content,
          files: submission.files,
        }),
        status: "draft",
        version: { increment: 1 },
      },
    });
    if (submission.type === "document") {
      const previousContent = typeof (previous?.payload as { content?: unknown } | null)?.content === "string"
        ? String((previous?.payload as { content: string }).content)
        : "";
      await reconcileUploadReferences(tx, {
        courseId,
        refBy: `submission:${submission.id}`,
        previousHtml: previousContent,
        nextHtml: submission.content,
      });
    }
    return;
  }
  if (action.type === "UPDATE_STUDENT_PROGRESS") {
    const { studentId, stageKey, value } = action.payload;
    const changed = await tx.$executeRaw`
      UPDATE "Student"
      SET "progress" = jsonb_set(
            COALESCE("progress", '{}'::jsonb),
            ARRAY[${stageKey}]::text[],
            to_jsonb(${value}::double precision),
            true
          ),
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "courseId" = ${courseId} AND "id" = ${studentId}
    `;
    if (changed !== 1) {
      throw new CourseActionError("STUDENT_NOT_FOUND", "Student not found.", 404);
    }
    return;
  }
  if (action.type === "SET_STUDENT_TODO_COMPLETION") {
    const { todoId, studentId, completed } = action.payload;
    const todo = await tx.courseTodo.findFirst({
      where: { courseId, id: todoId },
      select: { id: true },
    });
    if (!todo) {
      throw new CourseActionError("TODO_NOT_FOUND", "Todo not found.", 404);
    }
    if (completed) {
      await tx.todoCompletion.upsert({
        where: {
          courseId_todoId_studentId: { courseId, todoId, studentId },
        },
        create: { courseId, todoId, studentId },
        update: { completedAt: new Date() },
      });
    } else {
      await tx.todoCompletion.deleteMany({
        where: { courseId, todoId, studentId },
      });
    }
    const todoCompletions = await tx.todoCompletion.findMany({
      where: { courseId, todoId },
      select: { studentId: true },
    });
    await tx.courseTodo.update({
      where: { id: todoId },
      data: {
        completedBy: toJson(todoCompletions.map((item) => item.studentId)),
      },
    });
    const launchTodos = await tx.courseTodo.findMany({
      where: {
        courseId,
        OR: [
          { stageKey: null },
          {
            stageKey: {
              in: ["launch", "project-launch", "project-start", "start", "introduction"],
            },
          },
        ],
      },
      select: { id: true },
    });
    const completedCount = launchTodos.length
      ? await tx.todoCompletion.count({
          where: {
            courseId,
            studentId,
            todoId: { in: launchTodos.map((item) => item.id) },
          },
        })
      : 0;
    const launchProgress = launchTodos.length
      ? Math.round((completedCount / launchTodos.length) * 100)
      : 100;
    const changed = await tx.$executeRaw`
      UPDATE "Student"
      SET "progress" = jsonb_set(
            jsonb_set(
              COALESCE("progress", '{}'::jsonb),
              ARRAY['launch']::text[],
              to_jsonb(${launchProgress}::double precision),
              true
            ),
            ARRAY['project-launch']::text[],
            to_jsonb(${launchProgress}::double precision),
            true
          ),
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "courseId" = ${courseId} AND "id" = ${studentId}
    `;
    if (changed !== 1) {
      throw new CourseActionError("STUDENT_NOT_FOUND", "Student not found.", 404);
    }
    return;
  }
  if (action.type === "MARK_RESOURCE_DOWNLOADED") {
    const { resourceId, studentId, studentName } = action.payload;
    const resource = await tx.courseResource.findFirst({
      where: { courseId, id: resourceId },
      select: { id: true },
    });
    if (!resource) {
      throw new CourseActionError("RESOURCE_NOT_FOUND", "Resource not found.", 404);
    }
    await tx.resourceDownload.upsert({
      where: {
        courseId_resourceId_studentId: { courseId, resourceId, studentId },
      },
      create: { courseId, resourceId, studentId, studentName },
      update: { studentName, downloadedAt: new Date() },
    });
    return;
  }
  if (action.type === "ADD_ANNOUNCEMENT_REPLY") {
    const { announcementId, reply } = action.payload;
    const announcement = await tx.courseAnnouncement.findFirst({
      where: { courseId, id: announcementId },
      select: { id: true },
    });
    if (!announcement) {
      throw new CourseActionError(
        "ANNOUNCEMENT_NOT_FOUND",
        "Announcement not found.",
        404,
      );
    }
    await tx.announcementReply.upsert({
      where: {
        courseId_announcementId_id: {
          courseId,
          announcementId,
          id: reply.id,
        },
      },
      create: {
        id: reply.id,
        courseId,
        announcementId,
        authorId: reply.studentId ?? "teacher",
        authorName: reply.studentName,
        content: reply.content,
        createdAt: new Date(reply.createdAt),
      },
      update: {
        authorName: reply.studentName,
        content: reply.content,
      },
    });
    return;
  }
  if (action.type === "JOIN_GROUP") {
    const { groupId, studentId, studentName, role } = action.payload;
    const group = await tx.projectGroup.findFirst({
      where: { courseId, id: groupId },
      select: { id: true },
    });
    if (!group) {
      throw new CourseActionError("GROUP_NOT_FOUND", "Group not found.", 404);
    }
    await tx.groupMember.deleteMany({ where: { courseId, studentId } });
    await tx.groupMember.create({
      data: { courseId, groupId, studentId, studentName, role },
    });
    const groups = await tx.projectGroup.findMany({
      where: { courseId },
      select: { id: true, members: true },
    });
    for (const currentGroup of groups) {
      const members = parseGroupMembers(currentGroup.members).filter(
        (member) => member.studentId !== studentId,
      );
      if (currentGroup.id === groupId) {
        members.push({ studentId, name: studentName, role });
      }
      await tx.projectGroup.update({
        where: { id: currentGroup.id },
        data: { members: toJson(members) },
      });
    }
    return;
  }
  if (action.type === "LEAVE_GROUP") {
    const { groupId, studentId } = action.payload;
    await tx.groupMember.deleteMany({ where: { courseId, groupId, studentId } });
    const group = await tx.projectGroup.findFirst({
      where: { courseId, id: groupId },
      select: { id: true, members: true },
    });
    if (!group) {
      throw new CourseActionError("GROUP_NOT_FOUND", "Group not found.", 404);
    }
    await tx.projectGroup.update({
      where: { id: group.id },
      data: {
        members: toJson(
          parseGroupMembers(group.members).filter(
            (member) => member.studentId !== studentId,
          ),
        ),
      },
    });
    return;
  }
  throw new CourseActionError("UNSUPPORTED_ACTION", "Action is not implemented.", 400);
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

function parseGroupMembers(value: Prisma.JsonValue): Array<{
  studentId: string;
  name: string;
  role?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (member): member is { studentId: string; name: string; role?: string } =>
      Boolean(
        member &&
          typeof member === "object" &&
          !Array.isArray(member) &&
          typeof member.studentId === "string" &&
          typeof member.name === "string",
      ),
  );
}

/** Attach records written by compatibility classroom services to the platform
 * participation that owns this runtime course. */
async function attachLegacyRecordsToParticipation(
  tx: Prisma.TransactionClient,
  courseId: string,
  claims: AuthClaims,
): Promise<void> {
  if (claims.role !== "student") return;
  const userId = claims.userId ?? claims.studentId;
  const participation = await findLegacyParticipation(tx, courseId, claims.studentId);
  if (!participation) return;
  const studentIds = [...new Set([claims.studentId, userId])];
  const where = { courseId, studentId: { in: studentIds }, participationId: null };
  await Promise.all([
    tx.classroomSubmission.updateMany({ where, data: { participationId: participation.id } }),
    tx.projectDocumentVersion.updateMany({ where, data: { participationId: participation.id } }),
    tx.projectPdfVersion.updateMany({ where, data: { participationId: participation.id } }),
    tx.reflectionRecord.updateMany({ where, data: { participationId: participation.id } }),
    tx.courseUpload.updateMany({ where, data: { participationId: participation.id } }),
    tx.aiSupportRecord.updateMany({ where, data: { participationId: participation.id } }),
    tx.companionThread.updateMany({ where, data: { participationId: participation.id } }),
    tx.companionTask.updateMany({ where, data: { participationId: participation.id } }),
    tx.companionConfirmation.updateMany({ where, data: { participationId: participation.id } }),
    tx.companionProcessRecord.updateMany({ where, data: { participationId: participation.id } }),
    tx.aiInteractionEvent.updateMany({ where, data: { participationId: participation.id } }),
    tx.learningEvent.updateMany({ where, data: { participationId: participation.id } }),
    tx.showcasePresentation.updateMany({ where, data: { participationId: participation.id } }),
  ]);
}

async function executeLegacyWithReservation(
  courseId: string,
  envelope: ActionEnvelope,
  claims: AuthClaims,
): Promise<ActionAck> {
  if (
    claims.role === "teacher" &&
    envelope.action.type !== "CREATE_COURSE" &&
    envelope.expectedVersion === undefined
  ) {
    const current = await prisma.course.findUnique({
      where: { id: courseId },
      select: { version: true },
    });
    throw new CourseActionError(
      "EXPECTED_VERSION_REQUIRED",
      "Teacher mutations require expectedVersion.",
      428,
      { currentVersion: current?.version },
    );
  }
  try {
    await runMutationTransaction(async (tx) => {
      await lockCourseMutation(tx, courseId);
      if (claims.role === "student" && envelope.action.type === "UPSERT_REFLECTION") {
        // Check the status after taking the course lock so a teacher ending
        // the course cannot race a final student edit between a preliminary
        // read and the legacy aggregate save.
        const course = await tx.course.findUnique({
          where: { id: courseId },
          select: { status: true, stages: true, pblConfig: true },
        });
        if (!course) {
          throw new CourseActionError("COURSE_NOT_FOUND", "Course not found.", 404);
        }
        const stages = Array.isArray(course.stages)
          ? course.stages.filter((stage): stage is { key: string } => Boolean(
              stage
              && typeof stage === "object"
              && !Array.isArray(stage)
              && typeof (stage as { key?: unknown }).key === "string",
            ))
          : [];
        const pblConfig = course.pblConfig;
        const configuredNewSystem = Boolean(
          pblConfig
          && typeof pblConfig === "object"
          && !Array.isArray(pblConfig)
          && (pblConfig as { generationTemplate?: unknown }).generationTemplate === "new-ai-learning-only",
        );
        // The legacy six-stage reflection page retains its existing behavior;
        // only the new five-stage survey is locked once the course ends.
        if (
          course.status === "finished"
          && (
            Boolean(envelope.action.payload.reflection.survey)
            || inferStageCollectionMode(stages) === "new"
            || (!stages.length && configuredNewSystem)
          )
        ) {
          throw new CourseActionError("REFLECTION_LOCKED", "课程已结束，反思不能再修改。", 409);
        }
      }
      await tx.courseMutationReceipt.create({
        data: {
          requestId: envelope.requestId,
          courseId,
          actorId: claims.sub!,
        },
      });
      if (envelope.expectedVersion !== undefined) {
        const reserved = await tx.course.updateMany({
          where: { id: courseId, version: envelope.expectedVersion },
          data: { version: { increment: 1 } },
        });
        if (reserved.count !== 1) {
          const current = await tx.course.findUnique({
            where: { id: courseId },
            select: { version: true },
          });
          throw new CourseActionError(
            "VERSION_CONFLICT",
            "Course was updated by another request.",
            409,
            { currentVersion: current?.version },
          );
        }
      }
    });
  } catch (error) {
    return resolveDuplicateOrThrow(envelope.requestId, error);
  }

  try {
    await dispatchLegacyAction(envelope.action);
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { version: true },
    });
    const resultingVersion =
      course?.version ??
      (envelope.action.type === "DELETE_COURSE"
        ? (envelope.expectedVersion ?? 0) + 1
        : null);
    if (resultingVersion === null) {
      throw new CourseActionError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const completed = await prisma.$transaction(async (tx) => {
      const event = await tx.courseEvent.create({
        data: {
          courseId,
          requestId: envelope.requestId,
          type: envelope.action.type,
          actorId: claims.sub!,
          actorRole: claims.role,
          courseVersion: resultingVersion,
          ...(durableEventPayload(envelope.action)
            ? { payload: toJson(durableEventPayload(envelope.action)) }
            : {}),
        },
        select: { cursor: true },
      });
      await attachLegacyRecordsToParticipation(tx, courseId, claims);
      await tx.courseMutationReceipt.update({
        where: { requestId: envelope.requestId },
        data: {
          status: "completed",
          courseVersion: resultingVersion,
          eventCursor: event.cursor,
          completedAt: new Date(),
        },
      });
      return event.cursor;
    });
    return {
      requestId: envelope.requestId,
      courseVersion: resultingVersion,
      eventCursor: completed.toString(),
    };
  } catch (error) {
    await prisma.courseMutationReceipt.delete({
      where: { requestId: envelope.requestId },
    }).catch(() => undefined);
    throw error;
  }
}

async function resolveDuplicateOrThrow(
  requestId: string,
  error: unknown,
): Promise<ActionAck> {
  if (error instanceof CourseActionError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const existing = await prisma.courseMutationReceipt.findUnique({ where: { requestId } });
    if (existing) return receiptToAck(existing);
  }
  throw error;
}

function receiptToAck(receipt: {
  requestId: string;
  status: string;
  courseVersion: number | null;
  eventCursor: bigint | null;
}): ActionAck {
  if (
    receipt.status !== "completed" ||
    receipt.courseVersion === null ||
    receipt.eventCursor === null
  ) {
    throw new CourseActionError("REQUEST_IN_PROGRESS", "The original request is still processing.", 409);
  }
  return {
    requestId: receipt.requestId,
    courseVersion: receipt.courseVersion,
    eventCursor: receipt.eventCursor.toString(),
  };
}

async function publishAckEvent(
  courseId: string,
  action: SessionAction,
  ack: ActionAck,
): Promise<void> {
  const eventPayload = durableEventPayload(action);
  try {
    await publishCourseEvent(courseId, {
      type: action.type === "ADVANCE_STAGE" || action.type === "SET_STAGE"
        ? "stage-changed"
        : action.type === "SET_UI_STATE" && eventPayload
          ? "projection-changed"
          : "course-updated",
      courseId,
      at: new Date().toISOString(),
      payload: {
        actionType: action.type,
        courseVersion: ack.courseVersion,
        eventCursor: ack.eventCursor,
        ...eventPayload,
      },
    });
    if (
      action.type === "SET_UI_STATE"
      && (action.payload.patch.resourceProjection || action.payload.patch.teacherResourceProjection)
    ) {
      await publishCourseEvent(courseId, {
        type: "showcase-presentation",
        courseId,
        at: new Date().toISOString(),
        payload: { scope: "course" },
      });
    }
  } catch (error) {
    // The database event cursor is the durable source of truth. A Redis or
    // WebSocket publish failure must not turn an already-committed classroom
    // mutation into a client-visible write failure.
    console.error("[course-actions] realtime invalidation failed; clients will reconcile by cursor", {
      courseId,
      actionType: action.type,
      eventCursor: ack.eventCursor,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function durableEventPayload(action: SessionAction): Record<string, unknown> | undefined {
  if (action.type === "UPDATE_STUDENT_PROGRESS") {
    return { studentId: action.payload.studentId };
  }
  if (action.type !== "SET_UI_STATE") return undefined;
  const patch = action.payload.patch;
  const payload: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, "resourceProjection")) {
    payload.resourceProjection = patch.resourceProjection ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "teacherResourceProjection")) {
    payload.teacherResourceProjection = patch.teacherResourceProjection ?? null;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
