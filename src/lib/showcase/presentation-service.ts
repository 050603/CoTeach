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
  CourseContent,
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
  normalizeMinutesPerStudent,
  normalizeShowcaseQueueOrder,
  preserveShowcaseQueueLockedPositions,
  showcaseSlotSeconds,
  showcaseRemainingSeconds,
} from "./queue";
import { deriveClassroomTimingSnapshot, type ClassroomTimingState } from "@/lib/classroom/timing";
import { inferResourcePackageShowcasePlan } from "@/lib/resource-package/types";

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
  content?: CourseContent;
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
      content: true,
    },
  });
}

function parseShowcaseQueueConfig(value: unknown, content?: CourseContent): Partial<ShowcaseQueueConfig> | undefined {
  const raw = asRecord(asRecord(value).showcaseReporting);
  const packagePlan = content?.stagePlan?.showcasePlan
    ?? inferResourcePackageShowcasePlan(content?.stagePlan?.stages.find((stage) => stage.key === "showcase"));
  if (raw.schemaVersion === 2 || (!raw.schemaVersion && Number(content?.stagePlan?.schemaVersion ?? 0) >= 2)) {
    const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
    const seconds = (value: unknown, fallback: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
    const hasPackageTiming = packagePlan && [packagePlan.presentationSec, packagePlan.discussionSec, packagePlan.transitionSec].some((item) => item !== undefined);
    const presentationFallback = packagePlan?.presentationSec ?? 180;
    const discussionFallback = packagePlan?.discussionSec ?? (hasPackageTiming ? 0 : 60);
    const transitionFallback = packagePlan?.transitionSec ?? (hasPackageTiming ? 0 : 20);
    const presentationSec = seconds(raw.presentationSec, presentationFallback);
    const discussionSec = seconds(raw.discussionSec, discussionFallback);
    const transitionSec = seconds(raw.transitionSec, transitionFallback);
    const presenterCount = typeof raw.presenterCount === "number" && Number.isInteger(raw.presenterCount) && raw.presenterCount > 0
      ? raw.presenterCount : packagePlan?.presenterCount;
    return { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ids(raw.selectedStudentIds), orderedStudentIds: ids(raw.orderedStudentIds),
      presentationSec, discussionSec, transitionSec, minutesPerStudent: (presentationSec + discussionSec + transitionSec) / 60,
      ...(presenterCount ? { presenterCount } : {}),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
  }
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

function showcaseBudget(course: CourseGate, queue: ReturnType<typeof buildShowcaseQueue>, config?: Partial<ShowcaseQueueConfig>) {
  const clock = asRecord(course.uiState).classroomTiming as ClassroomTimingState | undefined;
  const snapshot = clock?.schemaVersion === 1 && Array.isArray(clock.stages)
    ? deriveClassroomTimingSnapshot(clock, new Date().toISOString()).stages.find((stage) => stage.stageKey === "showcase") : undefined;
  const stageRemainingSec = snapshot?.remainingSec ?? (course.content?.stagePlan?.stages.find((stage) => stage.key === "showcase")?.durationMin ?? 0) * 60;
  const now = Date.now();
  const plannedRemainingSec = queue.items.reduce((sum, item) => sum + showcaseRemainingSeconds(item, config, now), 0);
  return { stageRemainingSec, plannedRemainingSec: Math.ceil(plannedRemainingSec), overrunSec: Math.max(0, Math.ceil(plannedRemainingSec - stageRemainingSec)) };
}

function assertSelectedPresenter(course: CourseGate, studentId: string): void {
  const config = parseShowcaseQueueConfig(course.uiState, course.content);
  if (config?.selectionMode === "teacher-selected" && !config.selectedStudentIds?.includes(studentId)) {
    throw new ShowcasePresentationError("STUDENT_NOT_SELECTED", "该学生尚未被教师选入现场汇报名单。", 409);
  }
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
      .filter((presentation) => presentation.studentId === claims.sub!)
      .map((presentation) => ({ ...presentation, evaluationNote: undefined, evaluatedBy: undefined }));
  const activePresentation = claims.role === "teacher"
    ? presentations.find((presentation) => presentation.status === "active")
    : undefined;
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
    parseShowcaseQueueConfig(course.uiState, course.content),
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
    queueConfig: parseShowcaseQueueConfig(course.uiState, course.content) as ShowcaseQueueConfig | undefined,
    ...(parseShowcaseQueueConfig(course.uiState, course.content)?.schemaVersion === 2 ? { budget: showcaseBudget(course, queueResult, parseShowcaseQueueConfig(course.uiState, course.content)) } : {}),
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
      select: { status: true, currentStageIndex: true, stages: true, uiState: true, content: true },
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
      if (presentingStudent) assertSelectedPresenter(course, presentingStudent.studentId);
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
  const selectedMode = action.selectionMode === "teacher-selected" || parseShowcaseQueueConfig(course.uiState, course.content)?.schemaVersion === 2;
  const selectedIds = selectedMode ? (action.selectedStudentIds ?? parseShowcaseQueueConfig(course.uiState, course.content)?.selectedStudentIds ?? []) : undefined;
  const knownIds = new Set(students.map((student) => student.id));
  if ([...action.orderedStudentIds, ...(selectedIds ?? [])].some((id) => !knownIds.has(id))
    || action.orderedStudentIds.length !== new Set(action.orderedStudentIds).size || (selectedIds && selectedIds.length !== new Set(selectedIds).size)) {
    throw new ShowcasePresentationError("INVALID_QUEUE", "汇报名单包含重复或不属于当前课堂的学生。", 400);
  }
  const mergedOrder = normalizeShowcaseQueueOrder(queueStudents, action.orderedStudentIds, selectedIds);
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const locked = await tx.loadCourse({ where: { id: courseId } });
    if (!locked) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage({ ...locked, id: courseId, uiState: locked.uiState });
    const previousConfig = parseShowcaseQueueConfig(locked.uiState, locked.content);
    const previousOrder = normalizeShowcaseQueueOrder(queueStudents, previousConfig?.orderedStudentIds, previousConfig?.selectionMode === "teacher-selected" ? previousConfig.selectedStudentIds : undefined);
    const activeRows = await tx.listPresentations({ where: { courseId, status: { in: ["pending", "active", "rejected", "evaluating", "ended"] } } });
    const lockedStudentIds = new Set(activeRows.map((row) => row.studentId));
    const assignedStudentId = locked.presentingStudentId ?? queueStudents.find((student) => student.groupId === locked.presentingGroupId)?.studentId;
    if (assignedStudentId) lockedStudentIds.add(assignedStudentId);
    if (selectedMode && [...lockedStudentIds].some((id) => !selectedIds?.includes(id))) {
      throw new ShowcasePresentationError("QUEUE_LOCKED", "已点名、开始或完成汇报的学生须保留在本场次名单中。", 409);
    }
    const nextOrder = !selectedMode && action.orderedStudentIds.length === 0
      ? preserveShowcaseQueueLockedPositions(previousOrder, mergedOrder, lockedStudentIds) : mergedOrder;
    const oldLockedOrder = previousOrder.filter((id) => lockedStudentIds.has(id));
    const nextLockedOrder = nextOrder.filter((id) => lockedStudentIds.has(id));
    if (selectedMode ? oldLockedOrder.some((id, i) => id !== nextLockedOrder[i]) : [...lockedStudentIds].some((id) => previousOrder.indexOf(id) !== nextOrder.indexOf(id))) {
      throw new ShowcasePresentationError("QUEUE_LOCKED", "已开始或完成的汇报顺序不能改变。", 409);
    }
    const presenterCount = action.presenterCount ?? previousConfig?.presenterCount;
    const nextConfig: ShowcaseQueueConfig = selectedMode ? {
      schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: selectedIds!, orderedStudentIds: nextOrder,
      presentationSec: action.presentationSec ?? previousConfig?.presentationSec ?? 180,
      discussionSec: action.discussionSec ?? previousConfig?.discussionSec ?? 60,
      transitionSec: action.transitionSec ?? previousConfig?.transitionSec ?? 20,
      ...(presenterCount ? { presenterCount } : {}),
      minutesPerStudent: 0, updatedAt: new Date().toISOString(),
    } : { schemaVersion: 1, orderedStudentIds: nextOrder, minutesPerStudent: normalizeMinutesPerStudent(action.minutesPerStudent), updatedAt: new Date().toISOString() };
    if (selectedMode) {
      nextConfig.minutesPerStudent = showcaseSlotSeconds(nextConfig) / 60;
      const planned = buildShowcaseQueue(queueStudents, activeRows.map((row) => rowToSnapshot(row)), locked.presentingStudentId, nextConfig);
      const budget = showcaseBudget(locked, planned, nextConfig);
      if (budget.overrunSec > 0) throw new ShowcasePresentationError("SHOWCASE_BUDGET_EXCEEDED", `已选学生含汇报、点评和衔接共需 ${budget.plannedRemainingSec} 秒，阶段剩余 ${Math.floor(budget.stageRemainingSec)} 秒；请减少人数、调整单人安排或先调整阶段时间。`, 409);
    }
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

async function startPresentation(courseId: string, action: Extract<ShowcaseAction, { action: "start" }>, claims: AuthClaims) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以发起汇报投屏。", 403);
  const course = await loadCourseGate(courseId);
  assertCourseExists(course);
  assertShowcaseStage(course);
  assertSelectedPresenter(course, action.studentId);
  const { groupId, studentName } = await assertAssignedStudent(course, courseId, action.studentId);
  if (action.artifactKind === "document" && action.displayMode !== "continuous") {
    throw new ShowcasePresentationError("INVALID_DISPLAY_MODE", "富文档只支持连续阅读。", 400);
  }
  const artifact = await findLatestArtifact(courseId, action.studentId, action.artifactKind, action.artifactVersionId);
  if (!artifact) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能投屏该学生最新的已提交成果。", 409);
  let snapshot: ShowcasePresentationSnapshot | undefined;
  await store.transaction(async (tx) => {
    await tx.lock(courseId);
    const lockedCourse = await tx.loadCourse({
      where: { id: courseId },
      select: { id: true, status: true, currentStageIndex: true, stages: true, presentingGroupId: true, presentingStudentId: true, uiState: true, content: true },
    });
    if (!lockedCourse) throw new ShowcasePresentationError("COURSE_NOT_FOUND", "课程不存在。", 404);
    assertShowcaseStage(lockedCourse);
    assertSelectedPresenter(lockedCourse, action.studentId);
    const lockedAssignedStudentId = lockedCourse.presentingStudentId
      ?? (lockedCourse.presentingGroupId
        ? (await tx.findMember({
            where: { courseId, groupId: lockedCourse.presentingGroupId },
            orderBy: { joinedAt: "asc" },
            select: { studentId: true },
          }))?.studentId
        : undefined);
    if (lockedCourse.presentingGroupId !== groupId || lockedAssignedStudentId !== action.studentId) {
      throw new ShowcasePresentationError("PRESENTER_CHANGED", "当前汇报学生已发生变化，请刷新后重试。", 409);
    }
    const lockedMember = await tx.findMember({
      where: { courseId, groupId, studentId: action.studentId },
      select: { id: true },
    });
    if (!lockedMember) throw new ShowcasePresentationError("PRESENTER_NOT_ASSIGNED", "当前学生不是教师指定的汇报学生。", 409);
    const latestLocked = action.artifactKind === "pdf"
      ? await tx.findFile({ where: { id: action.artifactVersionId, courseId, studentId: action.studentId, stageKey: "make", status: "submitted", kind: "pdf" }, select: { id: true } })
      : await tx.findDocument({ where: { id: action.artifactVersionId, courseId, studentId: action.studentId, stageKey: "make", status: "submitted" }, select: { id: true } });
    if (!latestLocked) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能投屏该学生最新的已提交成果。", 409);
    const latestForStudent = action.artifactKind === "pdf"
      ? latestLocked
      : await tx.findDocument({ where: { courseId, studentId: action.studentId, stageKey: "make", status: "submitted" }, orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }, { sequence: "desc" }], select: { id: true } });
    if (latestForStudent?.id !== action.artifactVersionId) throw new ShowcasePresentationError("ARTIFACT_NOT_LATEST", "只能投屏该学生最新的已提交成果。", 409);
    const inProgress = await tx.findPresentation({ where: { courseId, status: { in: ["active", "evaluating"] } }, select: { id: true, status: true } });
    if (inProgress) {
      throw new ShowcasePresentationError(
        inProgress.status === "evaluating" ? "EVALUATION_IN_PROGRESS" : "PRESENTATION_ACTIVE",
        inProgress.status === "evaluating" ? "请先结束当前教师点评。" : "当前已有学生正在汇报。",
        409,
      );
    }
    const now = new Date();
    await tx.updatePresentations({
      where: { courseId, status: "pending" },
      data: { status: "cancelled", endedAt: now, revision: { increment: 1 } },
    });
    const uiState = asRecord(lockedCourse.uiState);
    await tx.updateCourse({
      where: { id: courseId },
      data: {
        uiState: { ...uiState, resourceProjection: null, teacherResourceProjection: null } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    const row = await tx.createPresentation({
      data: {
        id: randomUUID(),
        courseId,
        groupId,
        studentId: action.studentId,
        artifactKind: artifact.kind,
        artifactVersionId: action.artifactVersionId,
        artifactTitle: artifact.title,
        displayMode: action.displayMode,
        status: "active",
        viewState: { scrollRatio: 0, page: 1, updatedAt: now.toISOString() },
        reviewedAt: now,
        reviewedBy: claims.sub!,
        startedAt: now,
        participationId: (await tx.findParticipation(courseId, action.studentId))?.id,
      },
    });
    snapshot = rowToSnapshot(row, studentName);
  });
  await publishShowcaseEvent(courseId, {
    scope: "course",
    presentingGroupId: groupId,
    presentingStudentId: action.studentId,
    presentingStudentName: studentName,
    snapshot,
  });
  await publishCourseEvent(courseId, {
    type: "course-updated",
    courseId,
    at: new Date().toISOString(),
    payload: { actionType: "SET_UI_STATE" },
  }).catch(() => undefined);
  if (!snapshot) throw new ShowcasePresentationError("PRESENTATION_FAILED", "教师未能发起汇报投屏。", 500);
  return snapshot;
}

async function endPresentation(courseId: string, action: Extract<ShowcaseAction, { action: "end" }>, claims: AuthClaims) {
  if (claims.role !== "teacher") throw new ShowcasePresentationError("FORBIDDEN", "只有教师可以结束汇报投屏。", 403);
  const row = await latestSnapshot(courseId, action.presentationId);
  if (!row) throw new ShowcasePresentationError("PRESENTATION_NOT_FOUND", "汇报投屏不存在。", 404);
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
    const queue = buildShowcaseQueue(queueStudents, rowSnapshots, lockedCourse.presentingStudentId, parseShowcaseQueueConfig(lockedCourse.uiState, lockedCourse.content));
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
    case "start":
      return startPresentation(courseId, action, claims);
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
