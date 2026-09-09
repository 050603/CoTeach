import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import type { SessionAction } from "@/lib/session/actions";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { assertStudentActionScope, StudentActionScopeError } from "./v2-action-scope";
const studentId = "self";
const at = "2026-09-01T00:00:00Z";
function fixture(): Course {
  const course = createPblTemplateCourse("course");
  Object.assign(course, {
    students: [{ id: "self", name: "我", joinedAt: at, stageProgress: {} }, { id: "other", name: "同学", joinedAt: at, stageProgress: {} }],
    groups: ["self", "other"].map((id) => ({ id: `${id}-group`, name: id, topic: "", keywords: [], selectedForms: [], members: [{ studentId: id, name: id }], createdAt: at, updatedAt: at })),
    whiteboard: [{ id: "self-node", groupId: "self-group" }, { id: "other-node", groupId: "other-group" }],
    workPlan: [{ id: "self-item", groupId: "self-group" }, { id: "other-item", groupId: "other-group" }],
    groupAnnouncements: [{ id: "other-announcement", groupId: "other-group" }],
    submissions: [{ id: "other-submission", studentId: "other", courseId: "course" }],
    reflections: [{ id: "other-reflection", studentId: "other", courseId: "course" }],
    uploads: [{ id: "self-upload", studentId: "self", courseId: "course" }, { id: "other-upload", studentId: "other", courseId: "course" }],
    companionTasks: [{ id: "self-task", studentId: "self", courseId: "course" }, { id: "other-task", studentId: "other", courseId: "course" }],
    companionConfirmations: [{ id: "self-confirmation", studentId: "self", courseId: "course", taskId: "self-task", status: "pending", action: "save" }, { id: "other-confirmation", studentId: "other", courseId: "course", status: "pending", action: "save" }],
    learningEvidence: [{ id: "self-evidence", studentId: "self", courseId: "course" }, { id: "other-evidence", studentId: "other", courseId: "course" }],
    artifactSnapshots: [{ id: "other-snapshot", studentId: "other", courseId: "course" }],
    aiContributions: [{ id: "self-contribution", studentId: "self", courseId: "course" }, { id: "other-contribution", studentId: "other", courseId: "course" }],
    aiSupports: [{ id: "other-support", targetType: "student", targetId: "other", studentId: "other", courseId: "course" }],
    announcements: [{ id: "class-announcement", replies: [{ id: "other-reply", studentId: "other" }] }],
    todos: [{ id: "class-todo" }], resources: [{ id: "class-resource" }],
  });
  return course;
}
function action(type: SessionAction["type"], payload: Record<string, unknown>): SessionAction { return { type, payload: { courseId: "course", ...payload } } as SessionAction; }
function check(type: SessionAction["type"], payload: Record<string, unknown>, course = fixture()) { return () => assertStudentActionScope(course, action(type, payload), studentId); }

describe("authoritative V2 student action scopes", () => {
  it("allows editing the student's group board, but rejects another group's board", () => {
    expect(check("UPSERT_GROUP_BOARD", { board: { groupId: "self-group", snapshot: {} } })).not.toThrow();
    expect(check("UPSERT_GROUP_BOARD", { board: { groupId: "other-group", snapshot: {} } })).toThrow(StudentActionScopeError);
  });
  it.each([
    ["UPSERT_WHITEBOARD_NODE", { node: { id: "other-node", groupId: "self-group" } }],
    ["UPSERT_WHITEBOARD_NODE", { node: { id: "new-node", groupId: "self-group", parentId: "other-node" } }],
    ["DELETE_WHITEBOARD_NODE", { nodeId: "other-node" }],
    ["UPSERT_WORK_PLAN_ITEM", { studentId, item: { id: "other-item", groupId: "self-group" } }],
    ["DELETE_WORK_PLAN_ITEM", { studentId, itemId: "other-item" }],
    ["UPSERT_GROUP_ANNOUNCEMENT", { studentId, announcement: { id: "other-announcement", groupId: "self-group" } }],
  ] as const)("rejects cross-group entity replacement/deletion in %s", (type, payload) => {
    expect(check(type, payload)).toThrow(StudentActionScopeError);
  });
  it("allows group task deletion only after resolving the stored item's group", () => {
    expect(check("DELETE_WORK_PLAN_ITEM", { studentId, itemId: "self-item" })).not.toThrow();
    expect(check("DELETE_WORK_PLAN_ITEM", { studentId, itemId: "unknown" })).toThrow(StudentActionScopeError);
  });
  it.each(["members", "teacherApproval", "id"])("prevents a group topic patch from changing %s", (field) => {
    expect(check("SET_GROUP_TOPIC", { studentId, groupId: "self-group", patch: { [field]: "forged" } })).toThrow(StudentActionScopeError);
    expect(check("SET_GROUP_TOPIC", { studentId, groupId: "self-group", patch: { topic: "真实问题" } })).not.toThrow();
  });
  it("does not let students join another private project by guessing its group ID", () => {
    expect(check("JOIN_GROUP", { studentId, groupId: "other-group", studentName: "我" })).toThrow(StudentActionScopeError);
    const course = fixture(); course.classConfig = { groupMode: "free", totalStudents: 2 };
    expect(check("JOIN_GROUP", { studentId, groupId: "other-group", studentName: "我" }, course)).not.toThrow();
  });
  it.each([
    ["UPSERT_SUBMISSION", "submission", "other-submission"],
    ["UPSERT_REFLECTION", "reflection", "other-reflection"],
    ["UPSERT_UPLOAD", "upload", "other-upload"],
    ["UPSERT_COMPANION_TASK", "task", "other-task"],
    ["UPSERT_ARTIFACT_SNAPSHOT", "snapshot", "other-snapshot"],
  ] as const)("rejects borrowing an existing learner record ID in %s", (type, key, id) => {
    expect(check(type, { [key]: { id, studentId, courseId: "course" } })).toThrow(StudentActionScopeError);
  });
  it("rejects a nested record's different course even when the outer route scope matches", () => {
    expect(check("UPSERT_REFLECTION", { reflection: { id: "new", studentId, courseId: "other-course" } })).toThrow(StudentActionScopeError);
  });
  it("resolves only the persisted student's pending confirmation", () => {
    expect(check("RESOLVE_COMPANION_CONFIRMATION", { studentId, confirmationId: "other-confirmation", status: "confirmed", resolvedAt: at })).toThrow(StudentActionScopeError);
    expect(check("RESOLVE_COMPANION_CONFIRMATION", { studentId, confirmationId: "missing", status: "confirmed", resolvedAt: at })).toThrow(StudentActionScopeError);
    expect(check("RESOLVE_COMPANION_CONFIRMATION", { studentId, confirmationId: "self-confirmation", status: "confirmed", resolvedAt: at })).not.toThrow();
  });
  it("prevents creating pre-approved confirmations and borrowing another student's task", () => {
    expect(check("UPSERT_COMPANION_CONFIRMATION", { confirmation: { id: "new", studentId, courseId: "course", status: "confirmed" } })).toThrow(StudentActionScopeError);
    expect(check("UPSERT_COMPANION_CONFIRMATION", { confirmation: { id: "new", studentId, courseId: "course", status: "pending", taskId: "other-task" } })).toThrow(StudentActionScopeError);
  });
  it("does not accept a confirmation payload that borrows another learner's AI proposal", () => {
    expect(check("UPSERT_COMPANION_CONFIRMATION", { confirmation: { id: "new", studentId, courseId: "course", status: "pending", payload: { contributionId: "other-contribution" } } })).toThrow(StudentActionScopeError);
  });
  it("prevents reversing a completed confirmation", () => {
    const course = fixture(); course.companionConfirmations![0].status = "confirmed";
    expect(check("RESOLVE_COMPANION_CONFIRMATION", { studentId, confirmationId: "self-confirmation", status: "rejected", resolvedAt: at }, course)).toThrow(StudentActionScopeError);
  });
  it("rejects task and process record references to other learners' records", () => {
    expect(check("UPSERT_COMPANION_TASK", { task: { id: "new", studentId, courseId: "course", confirmationId: "other-confirmation" } })).toThrow(StudentActionScopeError);
    expect(check("ADD_COMPANION_PROCESS_RECORD", { record: { id: "new", studentId, courseId: "course", taskId: "other-task" } })).toThrow(StudentActionScopeError);
  });
  it("prevents rewriting other learners' replies or selecting their uploads", () => {
    expect(check("ADD_ANNOUNCEMENT_REPLY", { announcementId: "class-announcement", reply: { id: "other-reply", studentId } })).toThrow(StudentActionScopeError);
    expect(check("SET_PREVIEW_UPLOAD", { studentId, uploadId: "other-upload" })).toThrow(StudentActionScopeError);
    expect(check("SET_PREVIEW_UPLOAD", { studentId, uploadId: "self-upload" })).not.toThrow();
  });
  it("checks the support target as well as the claimed student ID", () => {
    expect(check("UPSERT_AI_SUPPORT", { support: { id: "new", courseId: "course", studentId, targetType: "student", targetId: "other" } })).toThrow(StudentActionScopeError);
    expect(check("UPSERT_AI_SUPPORT", { support: { id: "new", courseId: "course", studentId, targetType: "course", targetId: "course" } })).toThrow(StudentActionScopeError);
  });
  it("prevents self-confirming evidence or linking another student's evidence", () => {
    const evidence = { id: "new", studentId, courseId: "course", source: "student", status: "submitted", evidenceRefs: [], artifactSnapshotIds: [] };
    expect(check("UPSERT_LEARNING_EVIDENCE", { evidence })).not.toThrow();
    expect(check("UPSERT_LEARNING_EVIDENCE", { evidence: { ...evidence, status: "teacher-confirmed" } })).toThrow(StudentActionScopeError);
    expect(check("UPSERT_LEARNING_EVIDENCE", { evidence: { ...evidence, evidenceRefs: ["other-evidence"] } })).toThrow(StudentActionScopeError);
  });
  it("allows decisions only for the student's existing AI contribution", () => {
    const decision = { id: "decision", courseId: "course", studentId, contributionId: "self-contribution", resultingEvidenceIds: [] };
    expect(check("RECORD_STUDENT_AI_DECISION", { decision })).not.toThrow();
    expect(check("RECORD_STUDENT_AI_DECISION", { decision: { ...decision, contributionId: "other-contribution" } })).toThrow(StudentActionScopeError);
  });
  it("requires referenced class resources and todos to exist", () => {
    expect(check("MARK_RESOURCE_DOWNLOADED", { studentId, resourceId: "missing" })).toThrow(StudentActionScopeError);
    expect(check("SET_STUDENT_TODO_COMPLETION", { studentId, todoId: "missing", completed: true })).toThrow(StudentActionScopeError);
    expect(check("SET_STUDENT_TODO_COMPLETION", { studentId, todoId: "class-todo", completed: true })).not.toThrow();
  });
  it("fails closed for teacher actions", () => {
    expect(check("PUBLISH_COURSE", { id: "course" })).toThrow(StudentActionScopeError);
  });
});
