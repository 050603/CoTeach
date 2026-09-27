import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { LearningEvent } from "@/lib/session/types";
const mocks = vi.hoisted(() => ({ personal: vi.fn(), admission: vi.fn(), options: vi.fn(), lock: vi.fn(), user: vi.fn(), instance: vi.fn(), participation: vi.fn(), events: vi.fn(), insert: vi.fn(), signals: vi.fn(), remove: vi.fn(), upsert: vi.fn(), version: vi.fn(), notification: vi.fn(), count: vi.fn(), query: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.query, classroomParticipation: { count: mocks.count } } }));
vi.mock("@/lib/db/transaction-retry", () => ({ tryPersonalMutationAdmission: mocks.personal, tryCourseMutationAdmission: mocks.admission, runMutationTransaction: (operation: (tx: unknown) => unknown, options: unknown) => { mocks.options(options); return operation({
  classroomInstance: { findUnique: mocks.instance, update: mocks.version }, classroomParticipation: { findFirst: mocks.participation, count: mocks.count },
  learningEvent: { findMany: mocks.events, createMany: mocks.insert }, learningSignal: { findMany: mocks.signals, deleteMany: mocks.remove, upsert: mocks.upsert },
  domainEvent: { create: mocks.notification }, $queryRaw: mocks.query,
}); } }));
import { ingestClassroomLearningEvents } from "./ingest";
const claims = { role: "student", sub: "student", sv: 1 } as AuthClaims;
const event: LearningEvent = { id: "event", idempotencyKey: "key", studentId: "student", courseId: "course", stageKey: "learn", sceneId: "scene", type: "heartbeat", durationMs: 10000, occurredAt: new Date().toISOString(), metadata: { a: 1, b: "two" } };
const input = (events = [event]) => ({ courseId: "course", studentId: "student", events });
const instance = { id: "course", status: "TEACHING", runtimeConfig: { version: 8, uiState: { keep: true } }, templateVersionId: "template", activityId: "activity", activity: { archivedAt: null, chapterId: "chapter", chapter: { offeringId: "offering", offering: { status: "OPEN" } } } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "student" }); mocks.instance.mockResolvedValue(instance);
  mocks.participation.mockResolvedValue({ id: "participation", enrollmentId: "enrollment", enrollment: { status: "ACTIVE", researchKey: "research" } });
  mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? [] : []));
  mocks.signals.mockResolvedValue([]); mocks.count.mockResolvedValue(40); mocks.query.mockImplementation(async (query, ...values) => {
    if (query.join("").includes('WITH facts AS')) {
      await mocks.insert({ data: JSON.parse(values[8]).map((row: object) => ({ ...row, userId: values[0], researchKey: values[1], offeringId: values[2], enrollmentId: values[3], chapterId: values[4], activityId: values[5], classroomInstanceId: values[6], participationId: values[7] })) });
      if (values[10].length) await mocks.remove({ where: { participationId: values[9], id: { in: values[10] } } });
      for (const row of JSON.parse(values[16])) await mocks.upsert(row);
      await mocks.version({ where: { id: values[19] }, data: { runtimeConfig: JSON.parse(values[17]) } });
      return [await mocks.notification()];
    }
    if (query.join("").includes('FROM "LearningSignal" s')) return [];
    if (query.join("").includes('FROM "User"')) {
      const current = await mocks.instance(); const participant = await mocks.participation();
      const existing = await mocks.events({ where: { idempotencyKey: true } });
      const history = await mocks.events({ where: { classroomInstanceId: "course", userId: "student", participationId: "participation" } });
      return [{ ...current, actorStatus: "ACTIVE", actorRole: "student", actorSessionVersion: 1, chapterId: current.activity.chapterId, offeringId: current.activity.chapter.offeringId, offeringStatus: current.activity.chapter.offering.status, archivedAt: current.activity.archivedAt, participationId: participant?.id, enrollmentId: participant?.enrollmentId, enrollmentStatus: participant?.enrollment.status, researchKey: participant?.enrollment.researchKey, existing, history, ownSignalRows: await mocks.signals(), content: {} }];
    }
    return [{ content: {} }];
  });
  mocks.notification.mockResolvedValue({ id: "notice", createdAt: new Date("2026-09-26T00:00:00Z") });
});
describe("narrow classroom telemetry transaction", () => {
  it("keeps personal→course admission→row lock→fresh scope reads and writes in that order", async () => {
    await ingestClassroomLearningEvents(claims, input());
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ lowPriorityCourseId: "course", deferCourseAdmission: true }));
    expect(mocks.personal).toHaveBeenCalledWith(expect.anything(), "learning-events:course:student");
    expect(mocks.personal.mock.invocationCallOrder[0]).toBeLessThan(mocks.admission.mock.invocationCallOrder[0]);
    expect(mocks.admission.mock.invocationCallOrder[0]).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls[0][0].join("")).toContain('le."userId" = u.id AND le."classroomInstanceId" = ci.id AND le."participationId" = p.id');
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0]);
  });
  it("persists owned evidence, version and durable notification and reads only personal history", async () => {
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"], duplicateCount: 0, signals: [], commonIssues: [] });
    expect(mocks.insert.mock.calls[0][0].data[0]).toMatchObject({ userId: "student", participationId: "participation", researchKey: "research", classroomInstanceId: "course", metadata: { legacy: event, requestFingerprint: expect.any(String) } });
    expect(mocks.version).toHaveBeenCalledWith({ where: { id: "course" }, data: { runtimeConfig: { version: 9, uiState: { keep: true } } } });
    expect(mocks.publish).toHaveBeenCalledWith("course", expect.objectContaining({ payload: expect.objectContaining({ courseVersion: 9, scope: "student", studentId: "student", eventCursor: expect.any(String) }) }));
  });
  it("acknowledges committed replay despite reordered JSON without writing or incrementing version", async () => {
    await ingestClassroomLearningEvents(claims, input());
    const row = mocks.insert.mock.calls[0][0].data[0];
    mocks.events.mockResolvedValue([row]); mocks.insert.mockClear(); mocks.version.mockClear(); mocks.notification.mockClear(); mocks.publish.mockClear();
    const replay = await ingestClassroomLearningEvents(claims, input([{ ...event, metadata: { b: "two", a: 1 } }]));
    expect(replay).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.version).not.toHaveBeenCalled(); expect(mocks.notification).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects reused key with altered content or event ID, including within one batch", async () => {
    for (const changed of [{ ...event, durationMs: 42 }, { ...event, id: "other-event" }]) {
      await expect(ingestClassroomLearningEvents(claims, input([event, changed]))).rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT", status: 409 });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("supports legacy rows without fingerprints only when their full enriched event matches", async () => {
    await ingestClassroomLearningEvents(claims, input());
    const row = mocks.insert.mock.calls[0][0].data[0]; delete row.metadata.requestFingerprint;
    mocks.events.mockResolvedValue([row]);
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    await expect(ingestClassroomLearningEvents(claims, input([{ ...event, durationMs: 42 }]))).rejects.toMatchObject({ code: "LEARNING_EVENT_CONFLICT" });
  });
  it("deduplicates identical items inside a batch while acknowledging its ID", async () => {
    expect(await ingestClassroomLearningEvents(claims, input([event, event]))).toMatchObject({ acceptedIds: ["event"], duplicateCount: 1 });
    expect(mocks.insert.mock.calls[0][0].data).toHaveLength(1);
  });
  it("rejects new evidence after closure but acknowledges a committed replay", async () => {
    await ingestClassroomLearningEvents(claims, input()); const row = mocks.insert.mock.calls[0][0].data[0];
    mocks.instance.mockResolvedValue({ ...instance, status: "FINISHED" });
    await expect(ingestClassroomLearningEvents(claims, input())).rejects.toMatchObject({ code: "COURSE_LOCKED", status: 409 });
    mocks.events.mockResolvedValue([row]); expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ duplicateCount: 1 });
  });
  it("removes stale scene warnings after whole-stage completion and preserves unrelated signals", async () => {
    const finish: LearningEvent = { ...event, id: "finish", idempotencyKey: "finish", sceneId: undefined, type: "stage-goal-complete" };
    const stale = { id: "stale", studentId: "student", stageKey: "learn", sceneId: "scene", kind: "dwell-overrun", aiInterventionAttempts: 0 };
    const unrelated = { ...stale, id: "keep", stageKey: "make" };
    mocks.signals.mockResolvedValue([{ id: "db-stale", payload: { view: stale } }, { id: "db-keep", payload: { view: unrelated } }]);
    mocks.events.mockImplementation(({ where }) => Promise.resolve(where.idempotencyKey ? [] : [{ metadata: { legacy: { ...event, type: "scene-enter", occurredAt: new Date(Date.now() - 300000).toISOString() } } }, { metadata: { legacy: finish } }]));
    const result = await ingestClassroomLearningEvents(claims, input([finish]));
    expect(mocks.remove).toHaveBeenCalledWith({ where: { participationId: "participation", id: { in: ["db-stale"] } } });
    expect(result.signals).toEqual([unrelated]);
  });
  it("does not publish or return success when the transaction fails", async () => {
    mocks.notification.mockRejectedValue(new Error("DB write failure"));
    await expect(ingestClassroomLearningEvents(claims, input())).rejects.toThrow("DB write failure");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("keeps committed acknowledgement when realtime transport fails", async () => {
    mocks.publish.mockRejectedValue(new Error("Redis offline")); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await ingestClassroomLearningEvents(claims, input())).toMatchObject({ acceptedIds: ["event"] }); log.mockRestore();
  });
  it("rejects foreign ownership, invalid duration and future timestamps before writing", async () => {
    await expect(ingestClassroomLearningEvents({ ...claims, sub: "other" }, input())).rejects.toMatchObject({ status: 403 });
    for (const bad of [{ ...event, durationMs: -1 }, { ...event, occurredAt: new Date(Date.now() + 600000).toISOString() }, { ...event, courseId: "foreign" }]) {
      await expect(ingestClassroomLearningEvents(claims, input([bad]))).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

it("reads runtime after admission and row lock so a preceding teacher projection is retained", async () => {
  mocks.lock.mockImplementation(async () => { mocks.instance.mockResolvedValue({ ...instance, runtimeConfig: { version: 41, uiState: { projectionController: { teacherId: 'teacher', clientId: 'tab' }, currentSlide: 3 } } }); });
  await ingestClassroomLearningEvents(claims, input());
  expect(mocks.version).toHaveBeenCalledWith({ where: { id: "course" }, data: { runtimeConfig: { version: 42, uiState: { projectionController: { teacherId: 'teacher', clientId: 'tab' }, currentSlide: 3 } } } });
});

it("rejects an already committed event when the session version has been revoked", async () => {
  await ingestClassroomLearningEvents(claims, input());
  mocks.events.mockResolvedValue([mocks.insert.mock.calls[0][0].data[0]]);
  await expect(ingestClassroomLearningEvents({ ...claims, sv: 2 }, input())).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
});
