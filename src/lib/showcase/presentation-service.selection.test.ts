// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ course: {} as Record<string, unknown>, rows: [] as Array<Record<string, unknown>>, store: {
  loadCourse: vi.fn(), listStudents: vi.fn(), listMembers: vi.fn(), listDocuments: vi.fn(), listFiles: vi.fn(), listPresentations: vi.fn(),
  findPresentation: vi.fn(), findGroup: vi.fn(), findMember: vi.fn(), findDocument: vi.fn(), findFile: vi.fn(), findParticipation: vi.fn(),
  createPresentation: vi.fn(), updatePresentation: vi.fn(), updatePresentations: vi.fn(), lock: vi.fn(), updateCourse: vi.fn(), transaction: vi.fn(),
} }));
vi.mock("server-only", () => ({}));
vi.mock("./persistence", () => ({ showcaseStore: mocks.store }));
vi.mock("./state", () => ({ rowToSnapshot: (row: unknown) => row, loadShowcaseState: vi.fn() }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: async () => true }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn(async () => undefined) }));

import { executeShowcaseAction, getShowcaseData } from "./presentation-service";
const teacher = { sub: "teacher", role: "teacher" } as AuthClaims;
const student = { sub: "s2", role: "student" } as AuthClaims;
const action = { action: "save-queue" as const, selectionMode: "teacher-selected" as const, selectedStudentIds: ["s1"], orderedStudentIds: ["s1"], minutesPerStudent: 2, presentationSec: 80, discussionSec: 30, transitionSec: 10 };

describe("selected showcase lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.course = { id: "course", status: "teaching", currentStageIndex: 3, stages: ["launch", "ai-learning", "make", "showcase", "reflection"].map((key) => ({ key })),
      presentingStudentId: null, presentingGroupId: null, uiState: {}, content: { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 3 }] } } };
    mocks.rows = [];
    mocks.store.loadCourse.mockImplementation(async () => mocks.course);
    mocks.store.listStudents.mockResolvedValue([{ id: "s1", name: "甲" }, { id: "s2", name: "乙" }]);
    mocks.store.listMembers.mockResolvedValue([{ groupId: "g1", studentId: "s1", studentName: "甲" }, { groupId: "g2", studentId: "s2", studentName: "乙" }]);
    mocks.store.listDocuments.mockResolvedValue([]); mocks.store.listFiles.mockResolvedValue([]);
    mocks.store.listPresentations.mockImplementation(async () => mocks.rows);
    mocks.store.findPresentation.mockResolvedValue(null);
    mocks.store.transaction.mockImplementation(async (fn) => fn(mocks.store));
    mocks.store.updateCourse.mockImplementation(async ({ data }) => { mocks.course = { ...mocks.course, ...data }; });
    mocks.store.findGroup.mockResolvedValue({ id: "g2" });
    mocks.store.findMember.mockResolvedValue({ studentId: "s2", studentName: "乙", groupId: "g2" });
    mocks.store.findParticipation.mockResolvedValue({ id: "participation-s2" });
    mocks.store.updatePresentations.mockResolvedValue({ count: 0 });
    mocks.store.createPresentation.mockImplementation(async ({ data }) => ({ ...data, revision: 1, requestedAt: new Date(), updatedAt: new Date(), rejectionReason: null, endedAt: null, evaluatedAt: null, evaluatedBy: null, evaluationNote: null }));
  });
  it("starts with an empty shortlist, keeps the complete roster and persists selected seconds", async () => {
    expect((await getShowcaseData("course", teacher)).queue).toEqual([]);
    const result = await executeShowcaseAction("course", action, teacher);
    expect(result).toMatchObject({ students: [{ studentId: "s1" }, { studentId: "s2" }], queue: [{ studentId: "s1" }], budget: { plannedRemainingSec: 120, stageRemainingSec: 180, overrunSec: 0 } });
    expect((await getShowcaseData("course", teacher)).queue.map((item) => item.studentId)).toEqual(["s1"]);
  });
  it("uses the confirmed resource-package presenter count and timings before the teacher saves a queue", async () => {
    mocks.course.content = { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 10, requirements: "每位学生汇报90秒，点评30秒，衔接5秒", teacherActions: "选取5名学生现场汇报", aiActions: "", outputs: "" }] } };
    const result = await getShowcaseData("course", teacher);
    expect(result.queueConfig).toMatchObject({ presenterCount: 5, presentationSec: 90, discussionSec: 30, transitionSec: 5, minutesPerStudent: 125 / 60 });
  });
  it("rejects a shortlist exceeding the stage budget and rejects foreign students", async () => {
    await expect(executeShowcaseAction("course", { ...action, selectedStudentIds: ["s1", "s2"] }, teacher)).rejects.toMatchObject({ code: "SHOWCASE_BUDGET_EXCEEDED" });
    await expect(executeShowcaseAction("course", { ...action, selectedStudentIds: ["foreign"] }, teacher)).rejects.toMatchObject({ code: "INVALID_QUEUE" });
    expect(mocks.store.updateCourse).not.toHaveBeenCalled();
  });
  it("checks the live remaining stage budget after refresh without resetting elapsed time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:01:00Z"));
    const clock = { schemaVersion: 1, status: "running", sessionStartedAt: "2026-09-12T10:00:00Z", lastResumedAt: "2026-09-12T10:00:00Z", activeStageKey: "showcase", updatedAt: "2026-09-12T10:00:00Z", stages: [{ stageKey: "showcase", label: "汇报", basePlannedSec: 180, adjustmentSec: 0, elapsedSec: 10, status: "active" }] };
    mocks.course.uiState = { classroomTiming: clock };
    expect((await getShowcaseData("course", teacher)).budget?.stageRemainingSec).toBe(110);
    await expect(executeShowcaseAction("course", action, teacher)).rejects.toMatchObject({ code: "SHOWCASE_BUDGET_EXCEEDED" });
    const saved = await executeShowcaseAction("course", { ...action, presentationSec: 70 }, teacher);
    expect("budget" in saved && saved.budget).toMatchObject({ stageRemainingSec: 110, plannedRemainingSec: 110 });
    expect((mocks.course.uiState as Record<string, unknown>).classroomTiming).toEqual(clock);
  });
  it("rejects assigning or starting projection for an unselected student and blocks student-side starts", async () => {
    await expect(executeShowcaseAction("course", { action: "assign", groupId: "g2", studentId: "s2" }, teacher)).rejects.toMatchObject({ code: "STUDENT_NOT_SELECTED" });
    await expect(executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, teacher)).rejects.toMatchObject({ code: "STUDENT_NOT_SELECTED" });
    await expect(executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, student)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("creates an active projection directly from the teacher-selected student's material", async () => {
    mocks.course.presentingStudentId = "s2";
    mocks.course.presentingGroupId = "g2";
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: ["s2"], orderedStudentIds: ["s2"] } };
    mocks.store.findFile.mockResolvedValue({ id: "artifact", title: "乙的汇报.pdf" });
    const result = await executeShowcaseAction("course", { action: "start", studentId: "s2", artifactKind: "pdf", artifactVersionId: "artifact", displayMode: "slides" }, teacher);
    expect(result).toMatchObject({ studentId: "s2", artifactVersionId: "artifact", status: "active", displayMode: "slides" });
    expect(mocks.store.createPresentation).toHaveBeenCalledWith({ data: expect.objectContaining({
      studentId: "s2",
      groupId: "g2",
      artifactKind: "pdf",
      artifactVersionId: "artifact",
      status: "active",
      reviewedBy: "teacher",
    }) });
  });
  it("keeps old v1 classrooms on their original roster queue and preserves started history", async () => {
    mocks.course.content = { stagePlan: { schemaVersion: 1, stages: [] } };
    expect((await getShowcaseData("course", teacher)).queue.map((item) => item.studentId).sort()).toEqual(["s1", "s2"]);
    mocks.course.content = { stagePlan: { schemaVersion: 2, stages: [{ key: "showcase", durationMin: 3 }] } };
    mocks.course.uiState = { showcaseReporting: { schemaVersion: 2, selectedStudentIds: ["s1"], orderedStudentIds: ["s1"] } };
    mocks.rows = [{ studentId: "s1", status: "ended", updatedAt: "2026-09-12T10:00:00Z" }];
    await expect(executeShowcaseAction("course", { ...action, selectedStudentIds: [], orderedStudentIds: [] }, teacher)).rejects.toMatchObject({ code: "QUEUE_LOCKED" });
  });
});
