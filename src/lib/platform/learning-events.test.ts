import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ student: vi.fn(), enrollment: vi.fn(), chapter: vi.fn(), activity: vi.fn(), instance: vi.fn(), participation: vi.fn(), insert: vi.fn() }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (tx: unknown) => unknown) => operation({ enrollment: { findUnique: mocks.enrollment }, chapter: { findUnique: mocks.chapter }, activity: { findUnique: mocks.activity }, classroomInstance: { findUnique: mocks.instance }, classroomParticipation: { findUnique: mocks.participation }, learningEvent: { createMany: mocks.insert } }) }));
import { appendValidatedLearningEvents, learningEventsSchema } from "./learning-events";
const claims = { sub: "student", role: "student" } as AuthClaims;
const event = { idempotencyKey: "open", type: "activity_opened", activityId: "activity" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.enrollment.mockResolvedValue({ id: "enrollment", userId: "student", offeringId: "offering", status: "ACTIVE", researchKey: "research" });
  mocks.activity.mockResolvedValue({ id: "activity", chapterId: "chapter" });
  mocks.chapter.mockResolvedValue({ id: "chapter", offeringId: "offering" });
  mocks.instance.mockResolvedValue({ id: "instance", activityId: "activity" });
  mocks.participation.mockResolvedValue({ id: "participation", instanceId: "instance", enrollmentId: "enrollment" });
  mocks.insert.mockResolvedValue({ count: 1 });
});
describe("validated learning event ingestion", () => {
  it("derives course, enrollment and research identity from the activity", async () => {
    await expect(appendValidatedLearningEvents(claims, [event])).resolves.toEqual(["open"]);
    expect(mocks.insert).toHaveBeenCalledWith({ skipDuplicates: true, data: [expect.objectContaining({ userId: "student", offeringId: "offering", enrollmentId: "enrollment", chapterId: "chapter", activityId: "activity", researchKey: "research", idempotencyKey: "open" })] });
  });
  it("rejects another student's explicit enrollment", async () => {
    mocks.enrollment.mockResolvedValue({ id: "other", userId: "other", offeringId: "offering", status: "ACTIVE" });
    await expect(appendValidatedLearningEvents(claims, [{ ...event, enrollmentId: "other" }])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("rejects a mismatching course even if a real activity was supplied", async () => {
    await expect(appendValidatedLearningEvents(claims, [{ ...event, offeringId: "other-course" }])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("derives the full context from participation and verifies its owner", async () => {
    await appendValidatedLearningEvents(claims, [{ idempotencyKey: "enter", type: "entered", participationId: "participation" }]);
    expect(mocks.insert.mock.calls[0][0].data[0]).toMatchObject({ participationId: "participation", classroomInstanceId: "instance", activityId: "activity", offeringId: "offering", researchKey: "research" });
  });
  it("rejects events for classroom runs the student has never entered", async () => {
    mocks.participation.mockResolvedValue(null);
    await expect(appendValidatedLearningEvents(claims, [{ ...event, classroomInstanceId: "instance" }])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
  });
  it("rejects the complete batch when any event has mismatched references", async () => {
    await expect(appendValidatedLearningEvents(claims, [event, { ...event, chapterId: "other" }])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("acknowledges already persisted duplicates for safe retries", async () => {
    mocks.insert.mockResolvedValue({ count: 0 });
    await expect(appendValidatedLearningEvents(claims, [event])).resolves.toEqual(["open"]);
  });
  it("rejects withdrawn enrollments", async () => {
    mocks.enrollment.mockResolvedValue({ id: "enrollment", userId: "student", offeringId: "offering", status: "WITHDRAWN" });
    await expect(appendValidatedLearningEvents(claims, [event])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
  });
  it("rejects missing context, invalid durations, oversized metadata and future timestamps", async () => {
    for (const invalid of [{ idempotencyKey: "x", type: "x" }, { ...event, durationMs: -1 }, { ...event, durationMs: 2 ** 31 }, { ...event, metadata: { text: "x".repeat(32769) } }]) {
      expect(learningEventsSchema.safeParse({ events: [invalid] }).success).toBe(false);
    }
    await expect(appendValidatedLearningEvents(claims, [{ ...event, occurredAt: new Date(Date.now() + 600_000).toISOString() }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
