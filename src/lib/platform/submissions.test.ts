import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ activity: vi.fn(), enrollment: vi.fn(), save: vi.fn(), history: vi.fn(), transaction: vi.fn(), student: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { activity: { findUnique: mocks.activity }, enrollment: { findUnique: mocks.enrollment }, $transaction: mocks.transaction } }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student }));
import { submitActivity, submissionSchema } from "./submissions";
import type { AuthClaims } from "@/lib/auth/session";
const claims = { sub: "student", role: "student" } as AuthClaims;
const activity = { id: "task", title: "Project", version: 2, type: "ASSIGNMENT", isOpen: true, opensAt: null, archivedAt: null, config: {}, chapter: { offeringId: "course", isOpen: true, opensAt: null, archivedAt: null, offering: { status: "OPEN" } } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.activity.mockResolvedValue(activity);
  mocks.enrollment.mockResolvedValue({ id: "enrollment", status: "ACTIVE", researchKey: "research-key" });
  mocks.save.mockResolvedValue({ status: "COMPLETED" });
  mocks.history.mockResolvedValue({ id: "submission" });
  mocks.lock.mockResolvedValue([]);
  mocks.transaction.mockImplementation((operation) => operation({
    $queryRaw: mocks.lock,
    activity: { findUnique: mocks.activity },
    activitySubmission: { create: mocks.history },
    activityProgress: { upsert: mocks.save },
  }));
});
describe("learning task submission", () => {
  it("persists assignment answer and completion for the enrolled student", async () => {
    await submitActivity(claims, "task", { answer: "My project" });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ where: { enrollmentId_activityId: { enrollmentId: "enrollment", activityId: "task" } }, update: expect.objectContaining({ status: "COMPLETED", progressData: expect.objectContaining({ answer: "My project" }) }) }));
    expect(mocks.history).toHaveBeenCalledWith({ data: {
      enrollmentId: "enrollment",
      activityId: "task",
      researchKey: "research-key",
      activityVersion: 2,
      activitySnapshot: { type: "ASSIGNMENT", title: "Project", config: {}, version: 2 },
      payload: expect.objectContaining({ answer: "My project", answers: {} }),
      submittedAt: expect.any(Date),
    } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
  it("does not update progress when the submission history cannot be saved", async () => {
    mocks.history.mockRejectedValue(new Error("history unavailable"));
    await expect(submitActivity(claims, "task", { answer: "My project" })).rejects.toThrow("history unavailable");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects an answer validated against an older question version", async () => {
    mocks.activity.mockResolvedValueOnce(activity).mockResolvedValueOnce({ ...activity, version: 3 });
    await expect(submitActivity(claims, "task", { answer: "My project" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("appends each resubmission with its activity version while updating current progress", async () => {
    await submitActivity(claims, "task", { answer: "First draft" });
    mocks.activity.mockResolvedValue({ ...activity, title: "Revised project", version: 3, config: { instructions: "Explain your reasoning" } });
    await submitActivity(claims, "task", { answer: "Revised draft" });
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(mocks.history.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ activityVersion: 2, activitySnapshot: expect.objectContaining({ title: "Project", config: {} }), payload: expect.objectContaining({ answer: "First draft" }) }),
      expect.objectContaining({ activityVersion: 3, activitySnapshot: expect.objectContaining({ title: "Revised project", config: { instructions: "Explain your reasoning" } }), payload: expect.objectContaining({ answer: "Revised draft" }) }),
    ]);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][0].update.progressData.answer).toBe("Revised draft");
  });
  it("rejects locked chapters even when the task itself is open", async () => {
    mocks.activity.mockResolvedValue({ ...activity, chapter: { ...activity.chapter, isOpen: false } });
    await expect(submitActivity(claims, "task", { answer: "answer" })).rejects.toMatchObject({ code: "ACTIVITY_LOCKED" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("rejects unbound users and finished courses", async () => {
    mocks.enrollment.mockResolvedValue(null);
    await expect(submitActivity(claims, "task", { answer: "answer" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.enrollment.mockResolvedValue({ id: "enrollment", status: "ACTIVE" });
    mocks.activity.mockResolvedValue({ ...activity, chapter: { ...activity.chapter, offering: { status: "FINISHED" } } });
    await expect(submitActivity(claims, "task", { answer: "answer" })).rejects.toMatchObject({ code: "ACTIVITY_LOCKED" });
  });
  it("requires answers to required questions", async () => {
    mocks.activity.mockResolvedValue({ ...activity, type: "FORM", config: { schemaVersion: 1, content: "", questions: [{ id: "q1", title: "核心选择", type: "single-choice", required: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, { id: "q2", title: "补充", type: "short-text", required: false, options: [] }] } });
    await expect(submitActivity(claims, "task", { answers: {} })).rejects.toMatchObject({ code: "ANSWER_REQUIRED" });
    await expect(submitActivity(claims, "task", { answers: { q1: "unknown" } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await submitActivity(claims, "task", { answers: { q1: "a" } });
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("validates and persists multiple-choice option arrays", async () => {
    mocks.activity.mockResolvedValue({ ...activity, type: "FORM", config: { schemaVersion: 2, content: "", questions: [{ id: "q1", title: "练习过哪些能力？", type: "multiple-choice", chartType: "bar", maxSelections: 2, required: true, options: [{ id: "a", label: "调研" }, { id: "b", label: "协作" }, { id: "c", label: "表达" }] }] } });
    await expect(submitActivity(claims, "task", { answers: { q1: "a" } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitActivity(claims, "task", { answers: { q1: ["a", "a"] } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitActivity(claims, "task", { answers: { q1: ["a", "unknown"] } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitActivity(claims, "task", { answers: { q1: ["a", "b", "c"] } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await submitActivity(claims, "task", { answers: { q1: ["a", "b"] } });
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ answers: { q1: ["a", "b"] } }) }) }));
  });
  it("validates and persists supplemental text for a configured choice", async () => {
    mocks.activity.mockResolvedValue({ ...activity, type: "FORM", config: { schemaVersion: 2, content: "", questions: [{ id: "q1", title: "课堂节奏如何？", type: "single-choice", chartType: "bar", required: true, options: [{ id: "a", label: "合适" }, { id: "other", label: "其他", allowTextInput: true }] }] } });
    await expect(submitActivity(claims, "task", { answers: { q1: { selected: "other" } } })).rejects.toMatchObject({ code: "ANSWER_REQUIRED" });
    await expect(submitActivity(claims, "task", { answers: { q1: { selected: "other", optionText: { a: "无效补充" } } } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await expect(submitActivity(claims, "task", { answers: { q1: { selected: "other", optionText: { unknown: "无效补充" } } } })).rejects.toMatchObject({ code: "INVALID_ANSWER" });
    await submitActivity(claims, "task", { answers: { q1: { selected: "other", optionText: { other: "讨论环节偏快" } } } });
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ payload: expect.objectContaining({ answers: { q1: { selected: "other", optionText: { other: "讨论环节偏快" } } } }) }) }));
  });
  it("does not let clients complete classrooms using task submissions", async () => {
    mocks.activity.mockResolvedValue({ ...activity, type: "CLASSROOM" });
    await expect(submitActivity(claims, "task", {})).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
  });
  it("trims empty answers and limits payloads", () => {
    expect(submissionSchema.parse({ answer: "  " }).answer).toBe("");
    expect(submissionSchema.safeParse({ answer: "x".repeat(30001) }).success).toBe(false);
    expect(submissionSchema.safeParse({ answers: { q1: { selected: "other", optionText: { other: "x".repeat(201) } } } }).success).toBe(false);
  });
});
