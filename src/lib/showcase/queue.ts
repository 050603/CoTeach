import type { FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import type { ShowcaseQueueConfig, ShowcaseQueueItem, ShowcaseQueueItemStatus, ShowcaseStudentSummary } from "./types";

export const DEFAULT_MINUTES_PER_STUDENT = 5;

type QueueStudent = Pick<ShowcaseStudentSummary, "studentId" | "name" | "groupId" | "artifacts" | "firstPresentableSubmissionAt">;

function isPresentable(artifact: FinalArtifactSummary): boolean {
  return artifact.kind === "document" || artifact.kind === "pdf";
}

export function earliestPresentableSubmission(artifacts: FinalArtifactSummary[]): string | undefined {
  return artifacts
    .filter(isPresentable)
    .map((artifact) => artifact.submittedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function defaultShowcaseQueueOrder(students: QueueStudent[]): string[] {
  return [...students]
    .sort((left, right) => {
      const leftReadyAt = left.firstPresentableSubmissionAt ?? earliestPresentableSubmission(left.artifacts);
      const rightReadyAt = right.firstPresentableSubmissionAt ?? earliestPresentableSubmission(right.artifacts);
      if (leftReadyAt && rightReadyAt) {
        const byDate = Date.parse(leftReadyAt) - Date.parse(rightReadyAt);
        if (byDate !== 0) return byDate;
      } else if (leftReadyAt) {
        return -1;
      } else if (rightReadyAt) {
        return 1;
      }
      return left.name.localeCompare(right.name, "zh-CN") || left.studentId.localeCompare(right.studentId);
    })
    .map((student) => student.studentId);
}

export function normalizeShowcaseQueueOrder(
  students: QueueStudent[],
  configuredOrder?: string[],
  selectedStudentIds?: string[],
): string[] {
  const knownIds = new Set(students.map((student) => student.studentId));
  const selected = selectedStudentIds ? new Set(selectedStudentIds) : knownIds;
  const configured = (configuredOrder ?? []).filter((studentId, index, list) => knownIds.has(studentId) && selected.has(studentId) && list.indexOf(studentId) === index);
  const remaining = defaultShowcaseQueueOrder(students.filter((student) => selected.has(student.studentId) && !configured.includes(student.studentId)));
  return [...configured, ...remaining];
}

export function showcaseSlotSeconds(config?: Partial<ShowcaseQueueConfig>): number {
  return config?.schemaVersion === 2
    ? (config.presentationSec ?? 180) + (config.discussionSec ?? 60) + (config.transitionSec ?? 20)
    : normalizeMinutesPerStudent(config?.minutesPerStudent) * 60;
}

/** Rebuild a desired order without moving students whose classroom slot is locked. */
export function preserveShowcaseQueueLockedPositions(
  currentOrder: string[],
  desiredOrder: string[],
  lockedStudentIds: ReadonlySet<string>,
): string[] {
  const result = [...currentOrder];
  const movable = desiredOrder.filter((studentId) => !lockedStudentIds.has(studentId));
  let movableIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (lockedStudentIds.has(result[index]!)) continue;
    const replacement = movable[movableIndex++];
    if (replacement) result[index] = replacement;
  }
  return result;
}

export function normalizeMinutesPerStudent(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MINUTES_PER_STUDENT;
  return Math.min(60, Math.max(1, Math.round(value ?? DEFAULT_MINUTES_PER_STUDENT)));
}

function latestPresentation(
  presentations: ShowcasePresentationSnapshot[],
  studentId: string,
): ShowcasePresentationSnapshot | undefined {
  return presentations
    .filter((presentation) => presentation.studentId === studentId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function statusForStudent(
  student: QueueStudent,
  presentation: ShowcasePresentationSnapshot | undefined,
  presentingStudentId: string | null | undefined,
): ShowcaseQueueItemStatus {
  if (presentation?.status === "evaluating") return "evaluating";
  if (presentation?.status === "active") return "presenting";
  if (presentation?.status === "pending") return "pending-approval";
  if (presentation?.status === "rejected" && presentingStudentId === student.studentId) return "rejected";
  if (presentation?.status === "ended") return "completed";
  if (!student.artifacts.some(isPresentable)) return "not-ready";
  if (presentingStudentId === student.studentId) return "called";
  return "waiting";
}

function isWaiting(status: ShowcaseQueueItemStatus): boolean {
  return status === "waiting" || status === "called" || status === "pending-approval" || status === "rejected";
}

export function showcaseRemainingSeconds(item: ShowcaseQueueItem, config?: Partial<ShowcaseQueueConfig>, now = Date.now()): number {
  if (item.status === "completed") return 0;
  const elapsedSince = (timestamp?: string) => timestamp && Number.isFinite(Date.parse(timestamp)) ? Math.max(0, (now - Date.parse(timestamp)) / 1000) : 0;
  if (config?.schemaVersion === 2) {
    const discussion = config.discussionSec ?? 60;
    const transition = config.transitionSec ?? 20;
    if (item.status === "evaluating") return Math.max(0, discussion - elapsedSince(item.endedAt)) + transition;
    if (item.status === "presenting") return Math.max(0, (config.presentationSec ?? 180) - elapsedSince(item.startedAt)) + discussion + transition;
    return showcaseSlotSeconds(config);
  }
  if (item.status === "not-ready" || item.status === "evaluating") return 0;
  return Math.max(0, showcaseSlotSeconds(config) - (item.status === "presenting" ? elapsedSince(item.startedAt) : 0));
}

export function buildShowcaseQueue(
  students: QueueStudent[],
  presentations: ShowcasePresentationSnapshot[],
  presentingStudentId: string | null | undefined,
  config?: Partial<ShowcaseQueueConfig>,
  now = Date.now(),
): { items: ShowcaseQueueItem[]; minutesPerStudent: number; current: ShowcaseQueueItem | null; next: ShowcaseQueueItem | null } {
  const selected = config?.selectionMode === "teacher-selected"
    ? [...new Set([...(config.selectedStudentIds ?? []), ...presentations.filter((item) => ["active", "pending", "evaluating", "ended"].includes(item.status)).map((item) => item.studentId), ...(presentingStudentId ? [presentingStudentId] : [])])]
    : undefined;
  const order = normalizeShowcaseQueueOrder(students, config?.orderedStudentIds, selected);
  const byId = new Map(students.map((student) => [student.studentId, student]));
  const minutesPerStudent = showcaseSlotSeconds(config) / 60;
  const items: ShowcaseQueueItem[] = order.flatMap((studentId, index) => {
    const student = byId.get(studentId);
    if (!student) return [];
    const presentation = latestPresentation(presentations, student.studentId);
    const status = statusForStudent(student, presentation, presentingStudentId);
    const readyAt = student.firstPresentableSubmissionAt ?? earliestPresentableSubmission(student.artifacts);
    const primaryArtifact = student.artifacts.find(isPresentable);
    return [{
      studentId: student.studentId,
      studentName: student.name,
      groupId: student.groupId,
      position: index + 1,
      status,
      artifacts: student.artifacts,
      primaryArtifactTitle: primaryArtifact?.title,
      readyAt,
      presentationId: presentation?.id,
      startedAt: presentation?.startedAt,
      endedAt: presentation?.endedAt,
      evaluatedAt: presentation?.evaluatedAt,
      evaluationNote: presentation?.evaluationNote,
      estimatedWaitMinutes: undefined,
    }];
  });
  const current = items.find((item) => ["called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status)) ?? null;
  const currentIndex = current ? items.indexOf(current) : -1;
  const next = items.find((item, index) => index > currentIndex && isWaiting(item.status) && item.status !== "not-ready")
    ?? (currentIndex < 0 ? items.find((item) => isWaiting(item.status) && item.status !== "not-ready") : null)
    ?? null;
  for (const [targetIndex, item] of items.entries()) {
    if (item.status === "completed" || item.status === "not-ready") continue;
    if (targetIndex === currentIndex) {
      item.estimatedWaitMinutes = 0;
      continue;
    }
    let wait = items.slice(0, targetIndex).reduce((total, predecessor) => total + showcaseRemainingSeconds(predecessor, config, now) / 60, 0);
    // A manually selected current student blocks an item that appears before
    // it in the saved order until the current presentation is finished.
    if (currentIndex > targetIndex && current) wait += showcaseRemainingSeconds(current, config, now) / 60;
    item.estimatedWaitMinutes = Math.max(0, Math.round(wait));
  }
  return { items, minutesPerStudent, current, next };
}
