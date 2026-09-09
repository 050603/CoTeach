import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ student: vi.fn(), instance: vi.fn(), enrollment: vi.fn(), participation: vi.fn(), upsert: vi.fn(), event: vi.fn() }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student }));
vi.mock("./learning-events", () => ({ appendValidatedLearningEvents: mocks.event }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomInstance: { findUnique: mocks.instance }, enrollment: { findUnique: mocks.enrollment }, classroomParticipation: { findUnique: mocks.participation, upsert: mocks.upsert } } }));
import { enterClassroom } from "./repository";
const claims = { sub: "s", role: "student" } as AuthClaims;
const saved = { id: "p", completedAt: new Date("2026-09-08T00:00:00Z") };
beforeEach(() => {
  vi.resetAllMocks(); mocks.student.mockResolvedValue({ id: "s" });
  mocks.instance.mockResolvedValue({ id: "i", status: "FINISHED", templateVersion: { snapshot: { schemaVersion: 2, kind: "pbl-course", design: { coverImageUrl: "/finished-cover.webp" } } }, activity: { isOpen: true, chapter: { isOpen: true, offering: { id: "o", status: "FINISHED" } } } });
  mocks.enrollment.mockResolvedValue({ id: "e", status: "COMPLETED" }); mocks.participation.mockResolvedValue(saved);
});
describe("finished classroom entry", () => {
  it("returns the existing historical participation on repeated access without changing timestamps or events", async () => {
    const first = await enterClassroom(claims, "i");
    expect(first.participation).toEqual(saved);
    expect(first.instance.coverImageUrl).toBe("/finished-cover.webp");
    expect((await enterClassroom(claims, "i")).participation).toEqual(saved);
    expect(mocks.participation).toHaveBeenCalledWith({ where: { instanceId_enrollmentId: { instanceId: "i", enrollmentId: "e" } } });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it("does not manufacture a participation in a run the student never attended", async () => {
    mocks.participation.mockResolvedValue(null);
    await expect(enterClassroom(claims, "i")).rejects.toMatchObject({ code: "PARTICIPATION_NOT_FOUND" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("still checks enrollment before revealing a historical record", async () => {
    mocks.enrollment.mockResolvedValue(null);
    await expect(enterClassroom(claims, "i")).rejects.toMatchObject({ code: "ENROLLMENT_REQUIRED" });
    expect(mocks.participation).not.toHaveBeenCalled();
  });
});
