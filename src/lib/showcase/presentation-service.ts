import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { showcaseStore as store } from "./persistence";
import { rowToSnapshot } from "./state";
export { loadShowcaseState } from "./state";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import type {
  FinalArtifactKind,
  FinalArtifactSummary,
  ProjectDocumentVersion,
  ProjectPdfVersion,
  ShowcasePresentationSnapshot,
} from "@/lib/session/types";
import type {
  ShowcaseAction,
  ShowcaseData,
  ShowcaseEventPayload,
  ShowcaseQueueConfig,
  ShowcaseStudentSummary,
} from "./types";
import {
  buildShowcaseQueue,
  defaultShowcaseQueueOrder,
  normalizeMinutesPerStudent,
  normalizeShowcaseQueueOrder,
  preserveShowcaseQueueLockedPositions,
} from "./queue";

export class ShowcasePresentationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ShowcasePresentationError";
  }
}

type CourseGate = {
  id: string;
  status: string;
  currentStageIndex: number;
  stages: unknown;
  presentingGroupId: string | null;
  presentingStudentId: string | null;
  uiState: unknown;
};

type StudentRow = { id: string; name: string };
type GroupMemberRow = { groupId: string; studentId: string; studentName: string; joinedAt: Date };

function parseStages(value: unknown): Array<{ key?: string; view?: string }> {
  return Array.isArray(value)
    ? value.filter((stage): stage is { key?: unknown; view?: unknown } => Boolean(stage && typeof stage === "object"))
      .map((stage) => ({
        key: typeof stage.key === "string" ? stage.key : undefined,
        view: typeof stage.view === "string" ? stage.view : undefined,
      }))
    : [];
}

function currentStageKey(course: CourseGate): string {
  return parseStages(course.stages)[course.currentStageIndex]?.key ?? "";
}

function assertCourseExists(course: CourseGate | null): asserts course is CourseGate {
  if (!course) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
}

function assertStudentCourse(claims: AuthClaims, courseId: string): asserts claims is Extract<AuthClaims, { role: "student" }> {
  void courseId;
  if (claims.role !== "student" || !claims.sub!) {
    throw new ShowcasePresentationError("FORBIDDEN", "学生身份与课程不匹配。", 403);
  }
}

function assertShowcaseStage(course: CourseGate): void {
  const stages = parseStages(course.stages);
  const isNewFiveStageCourse = stages.length === 5
    && ["launch", "ai-learning", "make", "showcase", "reflection"].every((key, index) => stages[index]?.key === key);
  if (course.status !== "teaching" || currentStageKey(course) !== "showcase" || !isNewFiveStageCourse) {
    throw new ShowcasePresentationError("SHOWCASE_INACTIVE", "只有授课中的第四阶段可以进行成果汇报。", 409);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function documentSummary(version: ProjectDocumentVersion): FinalArtifactSummary {
  return {
    kind: "document",
    versionId: version.id,
    title: version.title,
    sequence: version.sequence,
    submittedAt: version.submittedAt ?? version.createdAt,
    displayModes: ["continuous"],
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: version.docxSize,
    downloadUrl: version.docxUploadId ? `/api/uploads/${version.docxUploadId}?download=1` : undefined,
  };
}

function pdfSummary(version: ProjectPdfVersion): FinalArtifactSummary {
  const kind = version.kind === "file" ? "file" : "pdf";
  return {
    kind,
    versionId: version.id,
    title: version.title,
    sequence: version.sequence,
    submittedAt: version.submittedAt,
    displayModes: kind === "pdf" ? ["continuous", "slides"] : [],
    mimeType: version.mimeType,
    size: version.size,
    downloadUrl: `/api/courses/${encodeURIComponent(version.courseId)}/showcase/artifacts/${encodeURIComponent(version.id)}?download=1`,
  };
}

function latestByStudent(
  documents: ProjectDocumentVersion[],
  pdfs: ProjectPdfVersion[],
): Map<string, FinalArtifactSummary[]> {
  const byStudent = new Map<string, FinalArtifactSummary[]>();
  const latestDocument = new Map<string, ProjectDocumentVersion>();
  for (const version of documents) {
    if (version.status !== "submitted") continue;
    const previous = latestDocument.get(version.studentId);
    if (!previous || isNewerVersion(version.submittedAt ?? version.createdAt, previous.submittedAt ?? previous.createdAt, version.sequence, previous.sequence)) latestDocument.set(version.studentId, version);
  }
  for (const [studentId, version] of latestDocument) byStudent.set(studentId, [documentSummary(version)]);
  for (const version of pdfs) {
    if (version.status !== "submitted") continue;
    byStudent.set(version.studentId, [...(byStudent.get(version.studentId) ?? []), pdfSummary(version)]);
  }
  for (const artifacts of byStudent.values()) artifacts.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  return byStudent;
}

function firstPresentableSubmissionByStudent(
  documents: ProjectDocumentVersion[],
  pdfs: ProjectPdfVersion[],
): Map<string, string> {
  const first = new Map<string, string>();
  const record = (studentId: string, submittedAt: string) => {
    const previous = first.get(studentId);
    if (!previous || Date.parse(submittedAt) < Date.parse(previous)) first.set(studentId, submittedAt);
  };
  for (const version of documents) {
    if (version.status === "submitted") record(version.studentId, version.submittedAt ?? version.createdAt);
  }
  for (const version of pdfs) {
    if (version.status === "submitted" && version.kind === "pdf") record(version.studentId, version.submittedAt);
  }
  return first;
}

function isNewerVersion(leftDate: string, rightDate: string, leftSequence: number, rightSequence: number): boolean {
  const left = Date.parse(leftDate);
  const right = Date.parse(rightDate);
  return left > right || (left === right && leftSequence > rightSequence);
}

async function loadCourseGate(courseId: string): Promise<CourseGate | null> {
  return store.loadCourse({
    where: { id: courseId },
    select: {
      id: true,
      status: true,
      currentStageIndex: true,
      stages: true,
      presentingGroupId: true,
      presentingStudentId: true,
      uiState: true,
    },
  });
}

function parseShowcaseQueueConfig(value: unknown): Partial<ShowcaseQueueConfig> | undefined {
  const raw = asRecord(asRecord(value).showcaseReporting);
  const orderedStudentIds = Array.isArray(raw.orderedStudentIds)
    ? raw.orderedStudentIds.filter((studentId): studentId is string => typeof studentId === "string")
    : undefined;
  const minutesPerStudent = typeof raw.minutesPerStudent === "number"
    ? normalizeMinutesPerStudent(raw.minutesPerStudent)
    : undefined;
  if (!orderedStudentIds && minutesPerStudent === undefined) return undefined;
  return {
    schemaVersion: 1,
    ...(orderedStudentIds ? { orderedStudentIds } : {}),
    ...(minutesPerStudent === undefined ? {} : { minutesPerStudent }),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  };
}

async function loadStudentAndGroupRows(courseId: string) {
  const [students, members] = await Promise.all([
    store.listStudents({ where: { courseId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    store.listMembers({ where: { courseId }, orderBy: { joinedAt: "asc" }, select: { groupId: true, studentId: true, studentName: true, joinedAt: true } }),
  ]);
  return { students: students as StudentRow[], members: members as GroupMemberRow[] };
}

async function loadFinalVersions(courseId: string, studentId?: string) {
  const where = studentId ? { courseId, studentId } : { courseId };
  const [documents, pdfs] = await Promise.all([
    store.listDocuments({ where: { ...where, stageKey: "make" }, orderBy: { sequence: "desc" } }),
    store.listFiles({ where: { ...where, stageKey: "make" }, orderBy: { sequence: "desc" } }),
  ]);
  return {
    documents: documents.map((version) => ({
      id: version.id,
      courseId: version.courseId,
      submissionId: version.submissionId,
      studentId: version.studentId,
      stageKey: version.stageKey,
      sequence: version.sequence,
      sourceVersion: version.sourceVersion,
      title: version.title,
      sourceHtml: version.sourceHtml,
      docxUploadId: version.docxUploadId ?? undefined,
      docxSha256: version.docxSha256 ?? undefined,
      docxSize: version.docxSize ?? undefined,
      status: version.status as ProjectDocumentVersion["status"],
      error: version.error ?? undefined,
      requestId: version.requestId ?? undefined,
      submittedAt: version.submittedAt?.toISOString(),
      createdAt: version.createdAt.toISOString(),
    } satisfies ProjectDocumentVersion)),
    pdfs: pdfs.map((version) => ({
      id: version.id,
      courseId: version.courseId,
      studentId: version.studentId,
      groupId: version.groupId ?? undefined,
      stageKey: version.stageKey,
      sequence: version.sequence,
      title: version.title,
      uploadId: version.uploadId,
      kind: version.kind === "file" ? "file" : "pdf",
      mimeType: version.mimeType,
      sha256: version.sha256 ?? undefined,
      size: version.size ?? undefined,
      status: version.status as ProjectPdfVersion["status"],
      requestId: version.requestId ?? undefined,
      submittedAt: version.submittedAt.toISOString(),
      createdAt: version.createdAt.toISOString(),
    } satisfies ProjectPdfVersion)),
  };
}

async function publishShowcaseEvent(
  courseId: string,
  payload: ShowcaseEventPayload,
): Promise<void> {
  try {
    await publishCourseEvent(courseId, {
      type: "showcase-presentation",
      courseId,
      at: new Date().toISOString(),
      payload: payload as Record<string, unknown>,
    });
  } catch (error) {
    console.error("[showcase] realtime publish failed; clients will poll", error);
  }
}

async function latestSnapshot(courseId: string, id: string) {
  return store.findPresentation({ where: { courseId, id } });
}

async function assertAssignedStudent(
  course: CourseGate,
  courseId: string,
  studentId: string,
): Promise<{ groupId: string; studentName: string }> {
  if (!course.presentingGroupId) {
    throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "教师尚未设置汇报学生。", 409);
  }
  const effectivePresentingStudentId = course.presentingStudentId
    ?? (await store.findMember({
      where: { courseId, groupId: course.presentingGroupId },
      orderBy: { joinedAt: "asc" },
      select: { studentId: true },
    }))?.studentId;
  if (effectivePresentingStudentId && effectivePresentingStudentId !== studentId) {
    throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "当前学生不是教师指定的汇报学生。", 403);
  }
  const member = await store.findMember({
    where: { courseId, groupId: course.presentingGroupId, studentId },
    select: { groupId: true, studentName: true },
  });
  if (!member) {
    throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "当前学生不是教师指定的汇报学生。", 403);
  }
  return { groupId: member.groupId, studentName: member.studentName };
}

async function findLatestArtifact(
  courseId: string,
  studentId: string,
  artifactKind: FinalArtifactKind,
  artifactVersionId: string,
) {
  if (artifactKind === "file") return null;
  if (artifactKind === "document") {
    const version = await store.findDocument({
      where: { id: artifactVersionId, courseId, studentId, stageKey: "make", status: "submitted" },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { sequence: "desc" }],
    });
    if (!version) return null;
    const latest = await store.findDocument({
      where: { courseId, studentId, stageKey: "make", status: "submitted" },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { sequence: "desc" }],
      select: { id: true },
    });
    return latest?.id === version.id ? { kind: "document" as const, version, title: version.title } : null;
  }
  const version = await store.findFile({
    where: { id: artifactVersionId, courseId, studentId, stageKey: "make", status: "submitted", kind: "pdf" },
  });
  return version ? { kind: "pdf" as const, version, title: version.title } : null;
}

export async function getShowcaseData(
  courseId: string,
  claims: AuthClaims,
): Promise<ShowcaseData> {
  if (!(await canAccessLegacyCourse(claims, courseId, "read"))) throw new ShowcasePresentationError("FORBIDDEN", "无权访问该课堂。", 403);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  if (claims.role === "student") assertStudentCourse(claims, courseId);
  assertShowcaseStage(course);

  const { students, members } = await loadStudentAndGroupRows(courseId);
  if (claims.role === "student" && !students.some((student) => student.id === claims.sub!)) {
    throw new ShowcasePresentationError("FORBIDDEN", "学生尚未加入该课程。", 403);
  }
  const memberByStudent = new Map<string, GroupMemberRow>();
  for (const member of members) memberByStudent.set(member.studentId, member);
  const effectivePresentingStudentId = course.presentingStudentId
    ?? members.find((member) => member.groupId === course.presentingGroupId)?.studentId;
  // Load the full roster's readiness timestamps to derive one shared queue.
  // Student-facing responses redact other students' artifact metadata below.
  const finalVersions = await loadFinalVersions(courseId);
  const artifactsByStudent = latestByStudent(finalVersions.documents, finalVersions.pdfs);
  const firstPresentableByStudent = firstPresentableSubmissionByStudent(finalVersions.documents, finalVersions.pdfs);

  const studentSummaries: ShowcaseStudentSummary[] = students.map((student) => {
    const member = memberByStudent.get(student.id);
    return {
      studentId: student.id,
      name: student.name,
      groupId: member?.groupId,
      isAssigned: Boolean(effectivePresentingStudentId
        && student.id === effectivePresentingStudentId
        && member?.groupId === course.presentingGroupId),
      artifacts: artifactsByStudent.get(student.id) ?? [],
      firstPresentableSubmissionAt: firstPresentableByStudent.get(student.id),
    };
  });
  const presentingStudent = studentSummaries.find((student) => student.isAssigned);
  const allPresentationRows = await store.listPresentations({
    where: {
      courseId,
      status: { in: ["pending", "active", "rejected", "evaluating", "ended"] },
    },
  orderBy: { updatedAt: "desc" },
  });
  const names = new Map(students.map((student) => [student.id, student.name]));
  const allPresentations = allPresentationRows.map((row) => rowToSnapshot(row, names.get(row.studentId)));
  const presentations = claims.role === "teacher"
    ? allPresentations
    : allPresentations
      .filter((presentation) => presentation.studentId === claims.sub! || ["active", "evaluating"].includes(presentation.status))
      .map((presentation) => ({ ...presentation, evaluationNote: undefined, evaluatedBy: undefined }));
  const activePresentation = presentations.find((presentation) => presentation.status === "active");
  const ownArtifacts = claims.role === "student"
    ? artifactsByStudent.get(claims.sub!) ?? []
    : [];
  const queueStudents = studentSummaries.length > 0
    ? studentSummaries
    : students.map((student) => {
        const member = memberByStudent.get(student.id);
        return {
          studentId: student.id,
          name: student.name,
          groupId: member?.groupId,
          isAssigned: Boolean(effectivePresentingStudentId && student.id === effectivePresentingStudentId && member?.groupId === course.presentingGroupId),
          artifacts: artifactsByStudent.get(student.id) ?? [],
          firstPresentableSubmissionAt: firstPresentableByStudent.get(student.id),
        } satisfies ShowcaseStudentSummary;
      });
  const queueResult = buildShowcaseQueue(
    queueStudents,
    allPresentations.map((presentation) => claims.role === "teacher"
      ? presentation
      : { ...presentation, evaluationNote: undefined, evaluatedBy: undefined }),
    effectivePresentingStudentId,
    parseShowcaseQueueConfig(course.uiState),
  );
  const queue = claims.role === "teacher"
    ? queueResult.items
    : queueResult.items.map((item) => {
        if (item.studentId === claims.sub!) return { ...item, evaluationNote: undefined };
        return {
          ...item,
          artifacts: [],
          primaryArtifactTitle: undefined,
          readyAt: undefined,
          evaluationNote: undefined,
        };
      });
  const currentQueueItem = queue.find((item) => item.studentId === queueResult.current?.studentId) ?? null;
  const nextQueueItem = queue.find((item) => item.studentId === queueResult.next?.studentId) ?? null;

  return {
    courseId,
    stageKey: currentStageKey(course),
    presentingGroupId: course.presentingGroupId ?? undefined,
    presentingStudentId: effectivePresentingStudentId,
    presentingStudentName: presentingStudent?.name,
    students: claims.role === "teacher" ? studentSummaries : [],
    ownArtifacts,
    activePresentation: activePresentation ?? null,
    presentations,
    queue,
    minutesPerStudent: queueResult.minutesPerStudent,
    currentQueueItem,
    nextQueueItem,
  };
}

async function assignPresenter(courseId: string, groupId: string | null, requestedStudentId: string | null | undefined, claims: AuthClaims) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以设置汇报学生。", 403);
  if (!groupId && requestedStudentId) {
    throw new ShowcasePresentationError("INVALID_ASSIGNMENT", "取消汇报学生设置时不能同时指定学生。", 400);
  }
  let payload: ShowcaseEventPayload;
  let cancelledSnapshots: ShowcasePresentationSnapshot[] = [];
  let cancelledActiveIds = new Set<string>();
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const course = await tx.loadCourse({
      where: { id: courseId },
      select: { status: true, currentStageIndex: true, stages: true },
    });
    if (!course) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage({ ...course, id: courseId, presentingGroupId: null, presentingStudentId: null, uiState: null });
    const inProgress = await tx.findPresentation({
      where: { courseId, status: { in: ["active", "evaluating"] } },
      select: { id: true, status: true },
    });
    if (inProgress) {
      throw new ShowcasePresentationError(
        inProgress.status === "evaluating" ? "EVALUATION_IN_PROGRESS" : "PRESENTATION_ACTIVE",
        inProgress.status === "evaluating" ? "请先结束当前教师点评，再点名下一位学生。" : "当前已有学生正在汇报。",
        409,
      );
    }
    let presentingStudent: { studentId: string; studentName: string } | null = null;
    if (groupId) {
      const group = await tx.findGroup({ where: { courseId, id: groupId }, select: { id: true } });
      if (!group) throw new ShowcasePresentationError("GROUP_NOT_FOUND", "汇报组不存在。", 404);
      presentingStudent = await tx.findMember({
        where: { courseId, groupId, ...(requestedStudentId ? { studentId: requestedStudentId } : {}) },
        select: { studentId: true, studentName: true },
        orderBy: { joinedAt: "asc" },
      });
      if (requestedStudentId && !presentingStudent) {
        throw new ShowcasePresentationError("STUDENT_NOT_IN_GROUP", "指定学生不属于该项目组。", 409);
      }
      if (!presentingStudent) {
        throw new ShowcasePresentationError("GROUP_EMPTY", "汇报组中没有可汇报的学生。", 409);
      }
    }
    const interrupted = await tx.listPresentations({
      where: { courseId, status: { in: ["pending", "active"] } },
    });
    cancelledActiveIds = new Set(interrupted.filter((row) => row.status === "active").map((row) => row.id));
    const endedAt = new Date();
    cancelledSnapshots = interrupted.map((row) => rowToSnapshot({
      ...row,
      // A queued request is cancelled; an already approved session has
      // reached its normal terminal state even when a new presenter replaces
      // it.
      status: row.status === "active" ? "ended" : "cancelled",
      revision: row.revision + 1,
      endedAt,
      updatedAt: endedAt,
    }));
    await tx.updatePresentations({
      where: { courseId, status: "pending" },
      data: { status: "cancelled", endedAt, revision: { increment: 1 } },
    });
    await tx.updatePresentations({
      where: { courseId, status: "active" },
      data: { status: "ended", endedAt, revision: { increment: 1 } },
    });
    await tx.updateCourse({ where: { id: courseId }, data: { presentingGroupId: groupId, presentingStudentId: presentingStudent?.studentId ?? null, version: { increment: 1 } } });
    payload = {
      scope: "course",
      presentingGroupId: groupId,
      presentingStudentId: presentingStudent?.studentId ?? null,
      presentingStudentName: presentingStudent?.studentName,
    };
  });
  await publishShowcaseEvent(courseId, payload!);
  // Keep the shared Course snapshot (used by the surrounding classroom
  // chrome) aligned with the dedicated showcase state after an assignment.
  await publishCourseEvent(courseId, {
    type: "course-updated",
    courseId,
    at: new Date().toISOString(),
    payload: { actionType: "SET_PRESENTING_GROUP" },
  }).catch(() => undefined);
  for (const snapshot of cancelledSnapshots) {
    await publishShowcaseEvent(courseId, cancelledActiveIds.has(snapshot.id)
      ? { scope: "course", snapshot }
      : { scope: "student", studentId: snapshot.studentId, snapshot });
  }
  return getShowcaseData(courseId, claims);
}

async function saveShowcaseQueue(
  courseId: string,
  action: Extract<ShowcaseAction, { action: "save-queue" }>,
  claims: AuthClaims,
) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以调整汇报顺序。", 403);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  assertShowcaseStage(course);
  const { students, members } = await loadStudentAndGroupRows(courseId);
  const finalVersions = await loadFinalVersions(courseId);
  const artifactsByStudent = latestByStudent(finalVersions.documents, finalVersions.pdfs);
  const firstPresentableByStudent = firstPresentableSubmissionByStudent(finalVersions.documents, finalVersions.pdfs);
  const memberByStudent = new Map(members.map((member) => [member.studentId, member]));
  const queueStudents = students.map((student) => ({
    studentId: student.id,
    name: student.name,
    groupId: memberByStudent.get(student.id)?.groupId,
    isAssigned: false,
    artifacts: artifactsByStudent.get(student.id) ?? [],
    firstPresentableSubmissionAt: firstPresentableByStudent.get(student.id),
  } satisfies ShowcaseStudentSummary));
  const defaultOrder = defaultShowcaseQueueOrder(queueStudents);
  const requestedKnownOrder = action.orderedStudentIds.filter((studentId) => students.some((student) => student.id === studentId));
  if (requestedKnownOrder.length !== new Set(requestedKnownOrder).size) {
    throw new ShowcasePresentationError("INVALID_QUEUE", "汇报顺序中不能有重复学生。", 400);
  }
  const baseOrder = action.orderedStudentIds.length > 0 ? requestedKnownOrder : defaultOrder;
  const mergedOrder = [...baseOrder, ...students.map((student) => student.id).filter((studentId) => !baseOrder.includes(studentId))];
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const locked = await tx.loadCourse({ where: { id: courseId }, select: { status: true, currentStageIndex: true, stages: true, uiState: true, presentingGroupId: true, presentingStudentId: true } });
    if (!locked) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage({ ...locked, id: courseId, uiState: locked.uiState });
    const previousOrder = normalizeShowcaseQueueOrder(queueStudents, parseShowcaseQueueConfig(locked.uiState)?.orderedStudentIds);
    const activeRows = await tx.listPresentations({
      where: { courseId, status: { in: ["pending", "active", "rejected", "evaluating", "ended"] } },
      select: { studentId: true },
    });
    const lockedStudentIds = new Set(activeRows.map((row) => row.studentId));
    const assignedStudentId = locked.presentingStudentId
      ?? queueStudents.find((student) => student.groupId === locked.presentingGroupId)?.studentId;
    if (assignedStudentId) lockedStudentIds.add(assignedStudentId);
    const nextOrder = action.orderedStudentIds.length === 0
      ? preserveShowcaseQueueLockedPositions(previousOrder, mergedOrder, lockedStudentIds)
      : mergedOrder;
    for (const studentId of lockedStudentIds) {
      if (previousOrder.indexOf(studentId) !== nextOrder.indexOf(studentId)) {
        throw new ShowcasePresentationError("QUEUE_LOCKED", "已经开始或完成汇报的学生不能调整顺序。", 409);
      }
    }
    const nextConfig = {
      schemaVersion: 1 as const,
      orderedStudentIds: nextOrder,
      minutesPerStudent: normalizeMinutesPerStudent(action.minutesPerStudent),
      updatedAt: new Date().toISOString(),
    } satisfies ShowcaseQueueConfig;
    const uiState = asRecord(locked.uiState);
    await tx.updateCourse({
      where: { id: courseId },
      data: {
        uiState: { ...uiState, showcaseReporting: nextConfig } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
  });
  await publishCourseEvent(courseId, {
    type: "course-updated",
    courseId,
    at: new Date().toISOString(),
    payload: { actionType: "SET_UI_STATE" },
  }).catch(() => undefined);
  const result = await getShowcaseData(courseId, claims);
  await publishShowcaseEvent(courseId, {
    scope: "course",
    minutesPerStudent: result.minutesPerStudent,
    presentingGroupId: result.presentingGroupId ?? null,
    presentingStudentId: result.presentingStudentId ?? null,
    presentingStudentName: result.presentingStudentName,
  });
  return result;
}

async function requestPresentation(courseId: string, action: Extract<ShowcaseAction, { action: "request" }>, claims: AuthClaims) {
  assertStudentCourse(claims, courseId);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  assertShowcaseStage(course);
  const { groupId, studentName } = await assertAssignedStudent(course, courseId, claims.sub!);
  if (action.artifactKind === "document" && action.displayMode !== "continuous") {
    throw new ShowcasePresentationError("INVALID_DISPLAY_MODE", "富文档只支持连续阅读。", 400);
  }
  const artifact = await findLatestArtifact(courseId, claims.sub!, action.artifactKind, action.artifactVersionId);
  if (!artifact) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能展示最新的已提交成果。", 409);
  const requestId = action.requestId ?? randomUUID();
  let snapshot: ShowcasePresentationSnapshot | undefined;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const duplicate = await tx.findPresentation({ where: { courseId, requestId } });
    if (duplicate) {
      if (duplicate.studentId !== claims.sub!) throw new ShowcasePresentationError("REQUEST_ID_CONFLICT", "请求编号已被其他学生使用。", 409);
      snapshot = rowToSnapshot(duplicate, studentName);
      return;
    }
    const lockedCourse = await tx.loadCourse({
      where: { id: courseId },
      select: { id: true, status: true, currentStageIndex: true, stages: true, presentingGroupId: true, presentingStudentId: true, uiState: true },
    });
    if (!lockedCourse) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage(lockedCourse);
    const lockedAssignedStudentId = lockedCourse.presentingStudentId
      ?? (lockedCourse.presentingGroupId
        ? (await tx.findMember({
            where: { courseId, groupId: lockedCourse.presentingGroupId },
            orderBy: { joinedAt: "asc" },
            select: { studentId: true },
          }))?.studentId
        : undefined);
    if (lockedCourse.presentingGroupId !== groupId || lockedAssignedStudentId !== claims.sub!) {
      throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "当前学生不是教师指定的汇报学生。", 403);
    }
    const lockedMember = await tx.findMember({
      where: { courseId, groupId, studentId: claims.sub! },
      select: { id: true },
    });
    if (!lockedMember) throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "当前学生不是教师指定的汇报学生。", 403);
    const latestLocked = action.artifactKind === "pdf"
      ? await tx.findFile({ where: { id: action.artifactVersionId, courseId, studentId: claims.sub!, stageKey: "make", status: "submitted", kind: "pdf" }, select: { id: true } })
      : await tx.findDocument({ where: { id: action.artifactVersionId, courseId, studentId: claims.sub!, stageKey: "make", status: "submitted" }, select: { id: true } });
    if (!latestLocked) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能展示最新的已提交成果。", 409);
    const latestForStudent = action.artifactKind === "pdf"
      ? latestLocked
      : await tx.findDocument({ where: { courseId, studentId: claims.sub!, stageKey: "make", status: "submitted" }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { sequence: "desc" }], select: { id: true } });
    if (latestForStudent?.id !== action.artifactVersionId) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能展示最新的已提交成果。", 409);
    const active = await tx.findPresentation({ where: { courseId, status: "active" }, select: { id: true } });
    if (active) throw new ShowcasePresentationError("PRESENTATION_ACTIVE", "当前已有学生在汇报，请等待教师结束后再申请。", 409);
    const pending = await tx.findPresentation({ where: { courseId, status: "pending" }, select: { id: true } });
    if (pending) throw new ShowcasePresentationError("PRESENTATION_PENDING", "已有一个汇报申请等待教师处理。", 409);
    const row = await tx.createPresentation({
      data: {
        id: randomUUID(),
        courseId,
        groupId,
        studentId: claims.sub!,
        artifactKind: artifact.kind,
        artifactVersionId: action.artifactVersionId,
        artifactTitle: artifact.title,
        displayMode: action.displayMode,
        requestId,
        status: "pending",
        viewState: { scrollRatio: 0, page: 1, updatedAt: new Date().toISOString() },
        participationId: (await tx.findParticipation(courseId, claims.sub!))?.id,
      },
    });
    snapshot = rowToSnapshot(row, studentName);
  });
  await publishShowcaseEvent(courseId, {
    scope: "student",
    studentId: claims.sub!,
    snapshot,
  });
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "汇报申请未能创建。", 500);
  return snapshot;
}

async function reviewPresentation(courseId: string, action: Extract<ShowcaseAction, { action: "review" }>, claims: AuthClaims) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以审批汇报申请。", 403);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  assertShowcaseStage(course);
  let snapshot: ShowcasePresentationSnapshot | undefined;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const currentCourse = await tx.loadCourse({
      where: { id: courseId },
      select: { id: true, status: true, currentStageIndex: true, stages: true, presentingGroupId: true, presentingStudentId: true, uiState: true },
    });
    if (!currentCourse) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage(currentCourse);
    const row = await tx.findPresentation({ where: { courseId, id: action.presentationId } });
    if (!row) throw new ShowcasePresentationError("PRESENTATION_NOT_FOUND", "汇报申请不存在。", 404);
    if (row.status !== "pending") throw new ShowcasePresentationError("PRESENTATION_NOT_PENDING", "该申请已经处理过。", 409);
    const currentAssignedStudentId = currentCourse.presentingStudentId
      ?? (currentCourse.presentingGroupId
        ? (await tx.findMember({
            where: { courseId, groupId: currentCourse.presentingGroupId },
            orderBy: { joinedAt: "asc" },
            select: { studentId: true },
          }))?.studentId
        : undefined);
    if (row.groupId !== currentCourse.presentingGroupId || row.studentId !== currentAssignedStudentId) {
      throw new ShowcasePresentationError("PRESENTER_CHANGED", "汇报学生已被教师更换。", 409);
    }
    const student = await tx.findStudent({ where: { courseId, id: row.studentId }, select: { name: true } });
    if (!student) throw new ShowcasePresentationError("STUDENT_NOT_FOUND", "汇报学生不存在。", 404);
    if (action.decision === "approve") {
      const latest = row.artifactKind === "pdf"
        ? await tx.findFile({ where: { id: row.artifactVersionId, courseId, studentId: row.studentId, stageKey: "make", status: "submitted", kind: "pdf" }, select: { id: true } })
        : await tx.findDocument({ where: { courseId, studentId: row.studentId, stageKey: "make", status: "submitted" }, orderBy: { sequence: "desc" }, select: { id: true } });
      if (!latest || latest.id !== row.artifactVersionId) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "该成果已不是学生最新的提交版本，请让学生重新申请。", 409);
      const active = await tx.findPresentation({ where: { courseId, status: "active" }, select: { id: true } });
      if (active) throw new ShowcasePresentationError("PRESENTATION_ACTIVE", "当前已有活动投屏。", 409);
      const courseRow = await tx.loadCourse({ where: { id: courseId }, select: { uiState: true } });
      const uiState = asRecord(courseRow?.uiState);
      await tx.updateCourse({
        where: { id: courseId },
        data: {
          uiState: {
            ...uiState,
            resourceProjection: null,
            teacherResourceProjection: null,
          } as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
    }
    const updated = await tx.updatePresentation({
      where: { id: row.id },
      data: action.decision === "approve"
        ? { status: "active", reviewedAt: new Date(), reviewedBy: claims.sub!, startedAt: new Date(), revision: { increment: 1 } }
        : { status: "rejected", reviewedAt: new Date(), reviewedBy: claims.sub!, rejectionReason: action.reason?.trim() || null, revision: { increment: 1 } },
    });
    snapshot = rowToSnapshot(updated, student.name);
  });
  await publishShowcaseEvent(courseId, {
    scope: action.decision === "approve" ? "course" : "student",
    ...(action.decision === "reject" ? { studentId: snapshot!.studentId } : {}),
    ...(action.decision === "approve"
      ? {
          presentingGroupId: snapshot!.groupId,
          presentingStudentId: snapshot!.studentId,
          presentingStudentName: snapshot!.studentName,
        }
      : {}),
    snapshot,
  });
  if (action.decision === "approve") {
    // Approval also clears the legacy teacher-resource projection. Trigger a
    // normal course refresh so an already-open resource overlay disappears on
    // every client, while the showcase event carries the presentation snapshot.
    await publishCourseEvent(courseId, {
      type: "course-updated",
      courseId,
      at: new Date().toISOString(),
      payload: { actionType: "SET_UI_STATE" },
    }).catch(() => undefined);
  }
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "汇报申请未能处理。", 500);
  return snapshot;
}

async function updateViewState(courseId: string, action: Extract<ShowcaseAction, { action: "update" }>, claims: AuthClaims) {
  assertStudentCourse(claims, courseId);
  let snapshot: ShowcasePresentationSnapshot | undefined;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const row = await tx.findPresentation({ where: { courseId, id: action.presentationId, status: "active" } });
    if (!row) throw new ShowcasePresentationError("PRESENTATION_NOT_ACTIVE", "汇报投屏已结束。", 409);
    if (row.studentId !== claims.sub!) throw new ShowcasePresentationError("FORBIDDEN", "只有汇报学生可以同步展示位置。", 403);
    const previous = asRecord(row.viewState);
    const next: Record<string, unknown> = {
      ...previous,
      updatedAt: new Date().toISOString(),
    };
    if (row.displayMode === "slides") {
      const page = action.viewState.page;
      if (!Number.isInteger(page) || page! < 1) throw new ShowcasePresentationError("INVALID_VIEW_STATE", "页码无效。", 400);
      next.page = page;
    } else {
      const ratio = action.viewState.scrollRatio;
      if (typeof ratio !== "number" || !Number.isFinite(ratio)) throw new ShowcasePresentationError("INVALID_VIEW_STATE", "滚动位置无效。", 400);
      next.scrollRatio = Math.min(1, Math.max(0, ratio));
    }
    const updated = await tx.updatePresentation({
      where: { id: row.id },
      data: { viewState: next as Prisma.InputJsonValue, revision: { increment: 1 } },
    });
    snapshot = rowToSnapshot(updated, undefined);
  });
  await publishShowcaseEvent(courseId, { scope: "course", snapshot });
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "汇报位置未能更新。", 500);
  return snapshot;
}

async function endPresentation(courseId: string, action: Extract<ShowcaseAction, { action: "end" }>, claims: AuthClaims) {
  const row = await latestSnapshot(courseId, action.presentationId);
  if (!row) throw new ShowcasePresentationError("PRESENTATION_NOT_FOUND", "汇报投屏不存在。", 404);
  if (claims.role === "student") {
    assertStudentCourse(claims, courseId);
    if (row.studentId !== claims.sub!) throw new ShowcasePresentationError("FORBIDDEN", "不能结束其他学生的投屏。", 403);
  }
  let snapshot: ShowcasePresentationSnapshot | undefined;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const current = await tx.findPresentation({ where: { courseId, id: action.presentationId } });
    if (!current) throw new ShowcasePresentationError("PRESENTATION_NOT_FOUND", "汇报投屏不存在。", 404);
    if (!["pending", "active"].includes(current.status)) {
      snapshot = rowToSnapshot(current);
      return;
    }
    const updated = await tx.updatePresentation({
      where: { id: current.id },
      data: current.status === "pending"
        ? { status: "cancelled", endedAt: new Date(), revision: { increment: 1 } }
        : { status: "evaluating", endedAt: new Date(), revision: { increment: 1 } },
    });
    snapshot = rowToSnapshot(updated);
  });
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "汇报状态未能更新。", 500);
  await publishShowcaseEvent(courseId, {
    scope: snapshot.status === "evaluating" ? "course" : "student",
    ...(snapshot.status === "cancelled" ? { studentId: snapshot.studentId } : {}),
    snapshot: snapshot.status === "evaluating"
      ? { ...snapshot, evaluationNote: undefined, evaluatedBy: undefined }
      : snapshot,
  });
  return snapshot;
}

async function finishEvaluation(
  courseId: string,
  action: Extract<ShowcaseAction, { action: "finish-evaluation" }>,
  claims: AuthClaims,
) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以结束现场评价。", 403);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  assertShowcaseStage(course);
  let snapshot: ShowcasePresentationSnapshot | undefined;
  const nextPresenterRef: { value: { groupId: string; studentId: string; studentName: string } | null } = { value: null };
  let alreadyCompleted = false;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const lockedCourse = await tx.loadCourse({
      where: { id: courseId },
      select: { id: true, status: true, currentStageIndex: true, stages: true, presentingGroupId: true, presentingStudentId: true, uiState: true },
    });
    if (!lockedCourse) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage(lockedCourse);
    const current = await tx.findPresentation({ where: { courseId, id: action.presentationId } });
    if (!current) throw new ShowcasePresentationError("PRESENTATION_NOT_FOUND", "汇报记录不存在。", 404);
    if (current.status === "ended") {
      snapshot = rowToSnapshot(current);
      alreadyCompleted = true;
      return;
    }
    if (current.status !== "evaluating") throw new ShowcasePresentationError("EVALUATION_NOT_PENDING", "当前汇报尚未进入教师点评阶段。", 409);
    const evaluatedAt = new Date();
    const updated = await tx.updatePresentation({
      where: { id: current.id },
      data: {
        status: "ended",
        evaluationNote: action.note?.trim() || null,
        evaluatedAt,
        evaluatedBy: claims.sub!,
        revision: { increment: 1 },
      },
    });
    const [students, members, documents, pdfs, rows] = await Promise.all([
      tx.listStudents({ where: { courseId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
      tx.listMembers({ where: { courseId }, orderBy: { joinedAt: "asc" }, select: { groupId: true, studentId: true, studentName: true, joinedAt: true } }),
      tx.listDocuments({ where: { courseId, stageKey: "make", status: "submitted" }, orderBy: { sequence: "desc" }, select: { id: true, studentId: true, title: true, sequence: true, submittedAt: true, createdAt: true } }),
      tx.listFiles({ where: { courseId, stageKey: "make", status: "submitted", kind: "pdf" }, orderBy: { sequence: "desc" }, select: { id: true, studentId: true, title: true, sequence: true, submittedAt: true, createdAt: true } }),
      tx.listPresentations({ where: { courseId, status: { in: ["pending", "active", "rejected", "evaluating", "ended"] } } }),
    ]);
    const updatedIndex = rows.findIndex((row) => row.id === updated.id);
    if (updatedIndex >= 0) rows.splice(updatedIndex, 1, updated);
    const firstPresentableByStudent = new Map<string, string>();
    const recordFirstSubmission = (studentId: string, submittedAt: string) => {
      const previous = firstPresentableByStudent.get(studentId);
      if (!previous || Date.parse(submittedAt) < Date.parse(previous)) firstPresentableByStudent.set(studentId, submittedAt);
    };
    for (const version of documents) {
      if (version.submittedAt) recordFirstSubmission(version.studentId, version.submittedAt.toISOString());
      else recordFirstSubmission(version.studentId, version.createdAt.toISOString());
    }
    for (const version of pdfs) recordFirstSubmission(version.studentId, version.submittedAt.toISOString());
    const artifactsByStudent = new Map<string, FinalArtifactSummary[]>();
    for (const version of documents) {
      const previous = artifactsByStudent.get(version.studentId)?.find((artifact) => artifact.kind === "document");
      const submittedAt = version.submittedAt?.toISOString() ?? version.createdAt.toISOString();
      if (!previous || isNewerVersion(submittedAt, previous.submittedAt, version.sequence, previous.sequence)) {
        artifactsByStudent.set(version.studentId, [{
          kind: "document",
          versionId: version.id,
          title: version.title,
          sequence: version.sequence,
          submittedAt,
          displayModes: ["continuous"],
        }, ...(artifactsByStudent.get(version.studentId) ?? []).filter((artifact) => artifact.kind !== "document")]);
      }
    }
    for (const version of pdfs) {
      const list = artifactsByStudent.get(version.studentId) ?? [];
      if (!list.some((artifact) => artifact.versionId === version.id)) {
        list.push({ kind: "pdf", versionId: version.id, title: version.title, sequence: version.sequence, submittedAt: version.submittedAt.toISOString(), displayModes: ["continuous", "slides"] });
        artifactsByStudent.set(version.studentId, list);
      }
    }
    const memberByStudent = new Map(members.map((member) => [member.studentId, member]));
    const names = new Map(students.map((student) => [student.id, student.name]));
    const queueStudents = students.map((student) => ({
      studentId: student.id,
      name: student.name,
      groupId: memberByStudent.get(student.id)?.groupId,
      isAssigned: false,
      artifacts: artifactsByStudent.get(student.id) ?? [],
      firstPresentableSubmissionAt: firstPresentableByStudent.get(student.id),
    } satisfies ShowcaseStudentSummary));
    const rowSnapshots = rows.map((row) => rowToSnapshot(row, names.get(row.studentId)));
    const queue = buildShowcaseQueue(queueStudents, rowSnapshots, lockedCourse.presentingStudentId, parseShowcaseQueueConfig(lockedCourse.uiState));
    const currentIndex = queue.items.findIndex((item) => item.studentId === current.studentId);
    const candidate = queue.items.find((item, index) => index > currentIndex && item.status === "waiting" && item.groupId)
      ?? queue.items.find((item) => item.status === "waiting" && item.groupId && item.studentId !== current.studentId);
    if (candidate?.groupId) {
      nextPresenterRef.value = { groupId: candidate.groupId, studentId: candidate.studentId, studentName: candidate.studentName };
    }
    await tx.updateCourse({
      where: { id: courseId },
      data: {
        presentingGroupId: nextPresenterRef.value?.groupId ?? null,
        presentingStudentId: nextPresenterRef.value?.studentId ?? null,
        version: { increment: 1 },
      },
    });
    snapshot = rowToSnapshot(updated, names.get(updated.studentId));
  });
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "评价状态未能更新。", 500);
  if (alreadyCompleted) return getShowcaseData(courseId, claims);
  const presenterGroupId = nextPresenterRef.value?.groupId ?? null;
  const presenterStudentId = nextPresenterRef.value?.studentId ?? null;
  const presenterStudentName = nextPresenterRef.value?.studentName;
  const result = await getShowcaseData(courseId, claims);
  await publishShowcaseEvent(courseId, {
    scope: "course",
    snapshot: { ...snapshot, evaluationNote: undefined, evaluatedBy: undefined },
    presentingGroupId: presenterGroupId,
    presentingStudentId: presenterStudentId,
    presentingStudentName: presenterStudentName,
    minutesPerStudent: result.minutesPerStudent,
  });
  await publishCourseEvent(courseId, {
    type: "course-updated",
    courseId,
    at: new Date().toISOString(),
    payload: { actionType: "SET_PRESENTING_GROUP" },
  }).catch(() => undefined);
  return result;
}

export async function executeShowcaseAction(
  courseId: string,
  action: ShowcaseAction,
  claims: AuthClaims,
): Promise<ShowcaseData | ShowcasePresentationSnapshot> {
  if (!(await canAccessLegacyCourse(claims, courseId, "write"))) throw new ShowcasePresentationError("FORBIDDEN", "无权操作该课堂。", 403);
  switch (action.action) {
    case "assign":
      return assignPresenter(courseId, action.groupId, action.studentId, claims);
    case "save-queue":
      return saveShowcaseQueue(courseId, action, claims);
    case "request":
      return requestPresentation(courseId, action, claims);
    case "review":
      return reviewPresentation(courseId, action, claims);
    case "update":
      return updateViewState(courseId, action, claims);
    case "end":
      return endPresentation(courseId, action, claims);
    case "finish-evaluation":
      return finishEvaluation(courseId, action, claims);
    default:
      throw new ShowcasePresentationError("INVALID_ACTION", "汇报操作无效。", 400);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
