import type { Course } from "@/lib/session/types";
import type { SessionAction } from "@/lib/session/actions";
import { isActionAllowed, isStudentActionForSelf } from "@/lib/auth/action-permissions";

export class StudentActionScopeError extends Error {
  readonly code = "FORBIDDEN_ACTION_SCOPE";
  readonly status = 403;
  constructor(message = "只能操作本人或所在小组的课堂记录") { super(message); this.name = "StudentActionScopeError"; }
}
function forbid(): never { throw new StudentActionScopeError(); }
type Owned = { id: string; studentId?: string; groupId?: string; courseId?: string };

/**
 * Run against the authoritative Course projection inside the mutation transaction.
 * This checks existing entity ownership, not just the student's claim in a payload.
 * Persistence must additionally namespace IDs or check cross-course database rows;
 * entities from another course are deliberately absent from this projection.
 */
export function assertStudentActionScope(course: Course, action: SessionAction, studentId: string): void {
  if (!isActionAllowed("student", action.type) || !isStudentActionForSelf(action, studentId, course.id)) forbid();
  const ownGroup = (id: string) => {
    const group = course.groups?.find((group) => group.id === id);
    if (!group?.members.some((member) => member.studentId === studentId)) forbid();
    return group;
  };
  const own = (row: Owned, groupAllowed = false) => {
    if (row.courseId !== undefined && row.courseId !== course.id) forbid();
    if (row.studentId !== undefined) { if (row.studentId !== studentId) forbid(); }
    else if (!groupAllowed || !row.groupId) forbid();
    if (row.groupId) ownGroup(row.groupId);
  };
  const writeOwned = <T extends Owned>(rows: readonly T[] | undefined, row: T, groupAllowed = false) => {
    own(row, groupAllowed);
    const existing = rows?.find((item) => item.id === row.id);
    if (existing) {
      own(existing, groupAllowed);
      if (existing.groupId !== row.groupId || existing.studentId !== row.studentId) forbid();
    }
  };
  const ownedReference = <T extends Owned>(rows: readonly T[] | undefined, id: string) => {
    const existing = rows?.find((item) => item.id === id); if (!existing) forbid(); own(existing); return existing;
  };
  const groupEntity = <T extends { id: string; groupId: string }>(rows: readonly T[] | undefined, row: T) => {
    ownGroup(row.groupId);
    const existing = rows?.find((item) => item.id === row.id);
    if (existing && existing.groupId !== row.groupId) forbid();
  };
  const deleteGroupEntity = <T extends { id: string; groupId: string }>(rows: readonly T[] | undefined, id: string) => {
    const existing = rows?.find((item) => item.id === id); if (!existing) forbid(); ownGroup(existing.groupId);
  };
  switch (action.type) {
    case "JOIN_CLASS":
      if (action.payload.student.id !== studentId) forbid();
      return;
    case "LEAVE_CLASS": case "HEARTBEAT": case "UPDATE_STUDENT_PROGRESS":
      if (action.payload.studentId !== studentId || !course.students.some((student) => student.id === studentId)) forbid();
      return;
    case "JOIN_GROUP": {
      const group = course.groups?.find((item) => item.id === action.payload.groupId);
      if (!group || action.payload.studentId !== studentId) forbid();
      // Personal/assigned spaces are not public groups a student may join by ID.
      if (!group.members.some((member) => member.studentId === studentId) && course.classConfig?.groupMode !== "free") forbid();
      return;
    }
    case "LEAVE_GROUP": ownGroup(action.payload.groupId); return;
    case "SET_GROUP_TOPIC": {
      ownGroup(action.payload.groupId);
      const allowed = new Set(["name", "topic", "goal", "keywords", "selectedForms", "proposal"]);
      if (Object.keys(action.payload.patch).some((key) => !allowed.has(key))) forbid();
      return;
    }
    case "UPSERT_GROUP_BOARD": ownGroup(action.payload.board.groupId); return;
    case "UPSERT_WHITEBOARD_NODE": {
      const node = action.payload.node; groupEntity(course.whiteboard, node);
      if (node.parentId) {
        const parent = course.whiteboard?.find((item) => item.id === node.parentId);
        if (!parent || parent.groupId !== node.groupId) forbid();
      }
      return;
    }
    case "DELETE_WHITEBOARD_NODE": deleteGroupEntity(course.whiteboard, action.payload.nodeId); return;
    case "UPSERT_WORK_PLAN_ITEM": groupEntity(course.workPlan, action.payload.item); return;
    case "DELETE_WORK_PLAN_ITEM": deleteGroupEntity(course.workPlan, action.payload.itemId); return;
    case "UPSERT_GROUP_ANNOUNCEMENT": groupEntity(course.groupAnnouncements, action.payload.announcement); return;
    case "UPSERT_SUBMISSION": writeOwned(course.submissions, action.payload.submission, true); return;
    case "UPSERT_REFLECTION": writeOwned(course.reflections, action.payload.reflection); return;
    case "UPSERT_UPLOAD": writeOwned(course.uploads, action.payload.upload, true); return;
    case "SET_PREVIEW_UPLOAD": {
      if (!action.payload.uploadId) return;
      const upload = course.uploads?.find((item) => item.id === action.payload.uploadId);
      if (!upload) forbid(); own(upload, true); return;
    }
    case "ADD_ANNOUNCEMENT_REPLY": {
      const announcement = course.announcements?.find((item) => item.id === action.payload.announcementId);
      if (!announcement || action.payload.reply.studentId !== studentId) forbid();
      for (const item of course.announcements ?? []) {
        const reply = item.replies.find((row) => row.id === action.payload.reply.id);
        if (reply && (item.id !== announcement.id || reply.studentId !== studentId)) forbid();
      }
      return;
    }
    case "SET_STUDENT_TODO_COMPLETION":
      if (!course.todos?.some((todo) => todo.id === action.payload.todoId)) forbid();
      return;
    case "MARK_RESOURCE_DOWNLOADED":
      if (!course.resources?.some((resource) => resource.id === action.payload.resourceId)) forbid();
      return;
    case "UPSERT_AI_SUPPORT": {
      const support = action.payload.support;
      const checkSupport = (row: typeof support) => {
        if (row.courseId !== course.id || (row.studentId && row.studentId !== studentId)) forbid();
        if (row.targetType === "student") { if (row.targetId !== studentId) forbid(); }
        else if (row.targetType === "group") ownGroup(row.targetId);
        else forbid();
        if (row.groupId) ownGroup(row.groupId);
      };
      checkSupport(support);
      const existing = course.aiSupports?.find((item) => item.id === support.id);
      if (existing) { checkSupport(existing); if (existing.targetId !== support.targetId || existing.targetType !== support.targetType) forbid(); }
      return;
    }
    case "UPSERT_COMPANION_TASK": {
      const task = action.payload.task; writeOwned(course.companionTasks, task);
      if (task.confirmationId) {
        const confirmation = ownedReference(course.companionConfirmations, task.confirmationId);
        if (confirmation.taskId && confirmation.taskId !== task.id) forbid();
      }
      return;
    }
    case "UPSERT_COMPANION_CONFIRMATION": {
      const confirmation = action.payload.confirmation; writeOwned(course.companionConfirmations, confirmation);
      if (confirmation.taskId) ownedReference(course.companionTasks, confirmation.taskId);
      if (typeof confirmation.payload?.contributionId === "string") ownedReference(course.aiContributions, confirmation.payload.contributionId);
      const previous = course.companionConfirmations?.find((item) => item.id === confirmation.id);
      // Approval is a separate operation against the persisted pending request.
      if (confirmation.status !== "pending" || confirmation.resolvedAt || (previous && previous.status !== "pending")) forbid();
      if (previous && (previous.taskId !== confirmation.taskId || previous.action !== confirmation.action)) forbid();
      return;
    }
    case "RESOLVE_COMPANION_CONFIRMATION": {
      const confirmation = ownedReference(course.companionConfirmations, action.payload.confirmationId);
      if (!["confirmed", "rejected"].includes(action.payload.status)) forbid();
      if (confirmation.status !== "pending" && (confirmation.status !== action.payload.status || confirmation.resolvedAt !== action.payload.resolvedAt)) forbid();
      if (confirmation.taskId) ownedReference(course.companionTasks, confirmation.taskId);
      if (typeof confirmation.payload?.contributionId === "string") ownedReference(course.aiContributions, confirmation.payload.contributionId);
      return;
    }
    case "ADD_COMPANION_PROCESS_RECORD": {
      const record = action.payload.record; writeOwned(course.companionProcessRecords, record);
      if (record.taskId) ownedReference(course.companionTasks, record.taskId);
      for (const id of record.evidenceIds ?? []) ownedReference(course.learningEvidence, id);
      return;
    }
    case "REQUEST_TEACHER_HELP": writeOwned(course.learningSignals, action.payload.signal); return;
    case "UPSERT_LEARNING_EVIDENCE": {
      const evidence = action.payload.evidence; writeOwned(course.learningEvidence, evidence);
      const previous = course.learningEvidence?.find((item) => item.id === evidence.id);
      if (evidence.source === "teacher" || evidence.status === "teacher-confirmed" || evidence.confirmedAt) forbid();
      if (evidence.teacherFeedback !== previous?.teacherFeedback || (evidence.status === "needs-revision" && previous?.status !== "needs-revision")) forbid();
      if (evidence.revisionOf) ownedReference(course.learningEvidence, evidence.revisionOf);
      for (const id of evidence.evidenceRefs) ownedReference(course.learningEvidence, id);
      for (const id of evidence.artifactSnapshotIds) ownedReference(course.artifactSnapshots, id);
      return;
    }
    case "UPSERT_ARTIFACT_SNAPSHOT": {
      const snapshot = action.payload.snapshot; writeOwned(course.artifactSnapshots, snapshot);
      if (snapshot.artifactVersionEvidenceId) ownedReference(course.learningEvidence, snapshot.artifactVersionEvidenceId);
      return;
    }
    case "UPSERT_AI_CONTRIBUTION": {
      const contribution = action.payload.contribution; writeOwned(course.aiContributions, contribution);
      for (const id of contribution.sourceEvidenceIds) ownedReference(course.learningEvidence, id);
      return;
    }
    case "RECORD_STUDENT_AI_DECISION": {
      const decision = action.payload.decision; writeOwned(course.studentAiDecisions, decision);
      ownedReference(course.aiContributions, decision.contributionId);
      for (const id of decision.resultingEvidenceIds) ownedReference(course.learningEvidence, id);
      return;
    }
    default: forbid();
  }
}
