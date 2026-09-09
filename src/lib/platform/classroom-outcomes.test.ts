import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({
  user: vi.fn(), participation: vi.fn(), teacher: vi.fn(), receipt: vi.fn(), event: vi.fn(), lock: vi.fn(),
  stage: vi.fn(), artifact: vi.fn(), createArtifact: vi.fn(), updateArtifact: vi.fn(), latest: vi.fn(), version: vi.fn(), findVersion: vi.fn(),
  reflection: vi.fn(), evaluation: vi.fn(), showcase: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("./access", () => ({ getPlatformUser: mocks.user }));
import { classroomOutcomeSchema, saveClassroomOutcome } from "./classroom-outcomes";
const claims = { sub: "student", role: "student" } as AuthClaims;
const idempotencyKey = "ac640a7e-3113-4360-a71f-1ecfc8895a19";
const stage = { action: "submit_stage", stageKey: "explore", payload: { answer: "original" }, idempotencyKey } as const;
function participation() {
  return { id: "p", enrollmentId: "e", completedAt: null,
    enrollment: { userId: "student", offeringId: "o", status: "ACTIVE", researchKey: "research" },
    instance: { id: "i", status: "TEACHING", templateVersionId: "tv", activity: { id: "a", version: 2, isOpen: true, archivedAt: null, chapter: { offeringId: "o", isOpen: true, archivedAt: null, offering: { status: "OPEN" } } } },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "student", role: "student" });
  mocks.participation.mockResolvedValue(participation());
  mocks.stage.mockResolvedValue({ id: "s", payload: stage.payload });
  mocks.createArtifact.mockResolvedValue({ id: "artifact" });
  mocks.latest.mockResolvedValue({ _max: { sequence: 3 } });
  mocks.version.mockResolvedValue({ id: "version", sequence: 4, size: BigInt(10) });
  mocks.transaction.mockImplementation((fn) => fn({
    $executeRaw: mocks.lock, classroomParticipation: { findUnique: mocks.participation }, courseTeacher: { findFirst: mocks.teacher },
    domainEvent: { findUnique: mocks.receipt, create: mocks.event }, classroomSubmission: { upsert: mocks.stage },
    artifact: { findFirst: mocks.artifact, create: mocks.createArtifact, update: mocks.updateArtifact },
    artifactVersion: { aggregate: mocks.latest, create: mocks.version, findFirst: mocks.findVersion },
    reflection: { create: mocks.reflection }, evaluation: { create: mocks.evaluation }, showcasePresentation: { create: mocks.showcase },
  }));
});
describe("V2 classroom outcomes", () => {
  it("saves the current stage and an immutable research snapshot in one transaction", async () => {
    await saveClassroomOutcome(claims, "p", stage);
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.event).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: "student", participationId: "p", eventType: "CLASSROOM_SUBMIT_STAGE", payload: expect.objectContaining({ researchKey: "research", activityVersion: 2, templateVersionId: "tv", result: { id: "s", payload: stage.payload } }) }) });
  });
  it("returns the original receipt on retries, without new writes", async () => {
    const original = await saveClassroomOutcome(claims, "p", stage);
    mocks.receipt.mockResolvedValue(mocks.event.mock.calls[0][0].data);
    expect(await saveClassroomOutcome(claims, "p", stage)).toEqual(original);
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.event).toHaveBeenCalledOnce();
    await expect(saveClassroomOutcome(claims, "p", { ...stage, payload: { answer: "changed" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("rejects another student's participation", async () => {
    mocks.user.mockResolvedValue({ id: "other", role: "student" });
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it("rejects mismatched enrollment and classroom offerings", async () => {
    const p = participation(); p.enrollment.offeringId = "other"; mocks.participation.mockResolvedValue(p);
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
  });
  it("requires a teaching relationship, then prevents teachers authoring student answers", async () => {
    mocks.user.mockResolvedValue({ id: "teacher", role: "teacher" });
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.teacher.mockResolvedValue({ id: "teacher-link" });
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("blocks student writes after the classroom has finished", async () => {
    const p = participation(); p.instance.status = "FINISHED"; mocks.participation.mockResolvedValue(p);
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toMatchObject({ code: "CLASSROOM_LOCKED" });
  });
  it("allows the course teacher to append a post-class evaluation", async () => {
    const p = participation(); p.instance.status = "FINISHED"; mocks.participation.mockResolvedValue(p);
    mocks.user.mockResolvedValue({ id: "teacher", role: "teacher" }); mocks.teacher.mockResolvedValue({ id: "link" });
    mocks.evaluation.mockResolvedValue({ id: "eval" });
    await saveClassroomOutcome(claims, "p", { action: "evaluate", type: "FORMATIVE", content: "Feedback", score: 75, idempotencyKey });
    expect(mocks.evaluation).toHaveBeenCalledWith({ data: expect.objectContaining({ studentId: "student", evaluatorId: "teacher", evaluatorType: "TEACHER", score: 75 }) });
  });
  it("appends artifact versions and serializes BigInt without overwriting prior versions", async () => {
    expect(await saveClassroomOutcome(claims, "p", { action: "save_artifact", title: "Demo", type: "HTML", sourceHtml: "<h1>Hi</h1>", idempotencyKey })).toEqual({ id: "artifact", version: { id: "version", sequence: 4, size: "10" } });
    expect(mocks.version).toHaveBeenCalledWith({ data: expect.objectContaining({ sequence: 4, artifactId: "artifact", status: "SUBMITTED" }) });
  });
  it("rejects editing an artifact from another participation", async () => {
    await expect(saveClassroomOutcome(claims, "p", { action: "save_artifact", artifactId: "other", title: "Demo", type: "TEXT", sourceHtml: "hello", idempotencyKey })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateArtifact).not.toHaveBeenCalled();
  });
  it("requires showcases to pin a submitted artifact version from the same participation", async () => {
    await expect(saveClassroomOutcome(claims, "p", { action: "showcase", artifactId: "artifact", artifactVersionId: "foreign", idempotencyKey })).rejects.toMatchObject({ code: "INVALID_ARTIFACT_VERSION" });
    expect(mocks.findVersion).toHaveBeenCalledWith({ where: { id: "foreign", artifactId: "artifact", artifact: { participationId: "p" }, status: "SUBMITTED" } });
    expect(mocks.showcase).not.toHaveBeenCalled();
  });
  it("does not report success when the audit snapshot fails", async () => {
    mocks.event.mockRejectedValue(new Error("database failure"));
    await expect(saveClassroomOutcome(claims, "p", stage)).rejects.toThrow("database failure");
  });
  it("requires a retry key and bounds the evaluation score", () => {
    expect(classroomOutcomeSchema.safeParse({ ...stage, idempotencyKey: undefined }).success).toBe(false);
    expect(classroomOutcomeSchema.safeParse({ action: "evaluate", type: "FORMATIVE", content: "Feedback", score: 101, idempotencyKey }).success).toBe(false);
  });
});
