import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionEnvelope } from "./contracts";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), lock: vi.fn(), publish: vi.fn(), access: vi.fn(async () => true),
  tx: {
    $queryRaw: vi.fn(),
    classroomParticipation: { findFirst: vi.fn() },
    groupMember: { findFirst: vi.fn() },
    classroomSubmission: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    classroomInstance: { update: vi.fn() },
    domainEvent: { findUnique: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock, loadCourse: mocks.load, mutateProjectedCourse: vi.fn() }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { executeCourseAction } from "./action-service";
const claims: AuthClaims = { role: "student", sub: "student", studentName: "学生", sv: 1 };
const submission = { id: "draft", courseId: "course", studentId: "student", stageKey: "make", type: "document" as const, title: "项目", content: "新内容", status: "draft" as const, version: 500, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
function envelope(version = 0, requestId = "b48d94c0-c98d-4f18-9fe5-32c81b10ac38"): ActionEnvelope { return { requestId, action: { type: "UPSERT_SUBMISSION", payload: { courseId: "course", submission, expectedSubmissionVersion: version } } }; }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tx.classroomParticipation.findFirst.mockResolvedValue({ id: "participation", enrollment: { status: "ACTIVE", offeringId: "offering", researchKey: "research" }, instance: { status: "TEACHING", runtimeConfig: { version: 4 }, activity: { chapter: { offering: { status: "OPEN" } } } } });
  mocks.tx.$queryRaw.mockImplementation(async (sql?: TemplateStringsArray, ...values: unknown[]) => {
    if (sql?.join("").includes("WITH course AS")) {
      await mocks.tx.domainEvent.create({ data: { payload: JSON.parse(values[19] as string) } });
      await mocks.tx.classroomSubmission.upsert({ create: { participationId: values[4], submittedAt: values[7], payload: JSON.parse(values[8] as string) } });
      return [{ id: values[11] }];
    }
    const row = await mocks.tx.classroomParticipation.findFirst();
    const previous = await mocks.tx.classroomSubmission.findUnique();
    const sameId = await mocks.tx.classroomSubmission.findFirst();
    return row ? [{ userStatus: "ACTIVE", userRole: "STUDENT", sessionVersion: 1, receipt: (await mocks.tx.domainEvent.findUnique())?.payload ?? null, id: row.id, offeringId: row.enrollment.offeringId, researchKey: row.enrollment.researchKey, enrollmentStatus: row.enrollment.status, instanceStatus: row.instance.status, runtimeVersion: row.instance.runtimeConfig?.version, offeringStatus: row.instance.activity.chapter.offering.status, archivedAt: null, groupAllowed: true, identityConflict: sameId && sameId.participationId !== row.id, currentPayload: previous ? Object.fromEntries(Object.entries(previous.payload.view ?? previous.payload).filter(([name]) => ["id", "studentId", "groupId", "version", "createdAt"].includes(name))) : null }] : [];
  });
  mocks.tx.classroomSubmission.findUnique.mockResolvedValue(null);
});
describe("student draft receipts and versions", () => {
  it("assigns the server version and loads only the student's submission", async () => {
    const ack = await executeCourseAction("course", envelope(), claims);
    expect(ack).toMatchObject({ submissionVersion: 1, courseVersion: 5 });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.tx.classroomSubmission.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ participationId: "participation", submittedAt: null, payload: expect.objectContaining({ view: expect.objectContaining({ version: 1, content: "新内容" }) }) }) }));
  });
  it("preserves immutable draft metadata without loading the previous document on successful CAS", async () => {
    const previous = { ...submission, id: "original", createdAt: "2025-01-01T00:00:00.000Z", content: "old".repeat(10000), version: 2 };
    mocks.tx.classroomSubmission.findUnique.mockResolvedValue({ payload: { view: previous } });
    expect(await executeCourseAction("course", envelope(2), claims)).toMatchObject({ submissionVersion: 3 });
    // One call belongs to the joined-read mock; no conflict-only follow-up read.
    expect(mocks.tx.classroomSubmission.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.tx.classroomSubmission.upsert.mock.calls[0][0].create.payload.view).toMatchObject({ id: "original", createdAt: previous.createdAt, content: "新内容" });
    const read = mocks.tx.$queryRaw.mock.calls[0][0].join("");
    expect(read).not.toContain('own.payload AS "currentPayload"');
    expect(read).toContain("jsonb_build_object('fingerprint'");
    expect(mocks.tx.$queryRaw.mock.calls[1][0].join("")).toContain("jsonb_set(");
  });
  it("retains JSON version semantics beyond the PostgreSQL int32 range", async () => {
    const row = await mocks.tx.classroomParticipation.findFirst();
    row.instance.runtimeConfig.version = 2 ** 31;
    expect(await executeCourseAction("course", envelope(), claims)).toMatchObject({ courseVersion: 2 ** 31 + 1 });
    expect(mocks.tx.$queryRaw.mock.calls[1][1]).toBe(JSON.stringify(2 ** 31 + 1));
  });
  it.each([0, 3])("preserves normalized JSON and matching receipt content at draft version %s", async (version) => {
    const request = envelope(version);
    const metadata = {
      omitted: undefined, nullable: null, date: new Date("2026-02-03T04:05:06.000Z"),
      invalidDate: new Date(NaN), nan: NaN, positive: Infinity, negative: -Infinity, zero: -0,
      items: [undefined, , null, NaN],
      custom: { toJSON: (key: string) => ({ key, omitted: undefined, value: "保留" }) },
    };
    if (request.action.type !== "UPSERT_SUBMISSION") throw new Error("fixture action");
    request.action.payload.submission = { ...submission, content: '完整正文\n"引号"及\\路径😀', ...{ metadata } };
    if (version) mocks.tx.classroomSubmission.findUnique.mockResolvedValue({ payload: { view: { ...submission, id: "original", createdAt: "2025-01-01T00:00:00.000Z", version } } });
    const ack = await executeCourseAction("course", request, claims);
    const stored = mocks.tx.classroomSubmission.upsert.mock.calls[0][0].create.payload;
    const receipt = mocks.tx.domainEvent.create.mock.calls[0][0].data.payload;
    expect(stored.view.metadata).toEqual({ nullable: null, date: "2026-02-03T04:05:06.000Z", invalidDate: null, nan: null, positive: null, negative: null, zero: 0, items: [null, null, null, null], custom: { key: "custom", value: "保留" } });
    expect(stored.view.content).toBe(request.action.payload.submission.content);
    expect(receipt.action.payload.submission).toEqual(stored.view);
    expect(receipt.ack).toEqual(ack);
    const originalPayload = { instanceId: "course", collection: "submissions", provenance: { actorId: "student", actorRole: "student" }, view: { ...request.action.payload.submission, ...(version ? { id: "original", createdAt: "2025-01-01T00:00:00.000Z" } : {}), version: version + 1, updatedAt: stored.view.updatedAt } };
    // Compare the actual SQL parameter with the former JSON-normalize + encode contract.
    expect(mocks.tx.$queryRaw.mock.calls[1][9]).toBe(JSON.stringify(JSON.parse(JSON.stringify(originalPayload))));
    expect(request.action.payload.submission.version).toBe(500);
    expect(metadata.date).toBeInstanceOf(Date);
    expect(Number.isNaN(metadata.nan)).toBe(true);
  });
  it("keeps personal group drafts on the narrow path and verifies active scoped membership", async () => {
    mocks.tx.groupMember.findFirst.mockResolvedValue({ id: "membership" });
    const grouped = envelope();
    if (grouped.action.type === "UPSERT_SUBMISSION") grouped.action.payload.submission = { ...submission, groupId: "grp-student" };
    const ack = await executeCourseAction("course", grouped, claims);
    expect(ack.submissionVersion).toBe(1); expect(mocks.load).not.toHaveBeenCalled();
    const sql = mocks.tx.$queryRaw.mock.calls[0][0].join("");
    expect(sql).toContain('"GroupMember"'); expect(sql).toContain('gm."leftAt" IS NULL'); expect(sql).toContain('g."offeringId" = o.id');
  });
  it("rejects a group outside the student's active offering membership", async () => {
    const row = (await mocks.tx.$queryRaw())[0];
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, groupAllowed: false }]);
    const grouped = envelope();
    if (grouped.action.type === "UPSERT_SUBMISSION") grouped.action.payload.submission = { ...submission, groupId: "foreign-group" };
    await expect(executeCourseAction("course", grouped, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE", status: 403 });
    expect(mocks.tx.classroomSubmission.upsert).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it("retains existing group ownership and rejects changing it even to another owned group", async () => {
    mocks.tx.groupMember.findFirst.mockResolvedValue({ id: "membership" });
    mocks.tx.classroomSubmission.findUnique.mockResolvedValue({ payload: { view: { ...submission, groupId: "existing-group", version: 1 } } });
    const grouped = envelope(1);
    if (grouped.action.type === "UPSERT_SUBMISSION") grouped.action.payload.submission = { ...submission, groupId: "other-group" };
    await expect(executeCourseAction("course", grouped, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
    expect(mocks.tx.classroomSubmission.upsert).not.toHaveBeenCalled();
  });
  it("replays a lost acknowledgement without applying the draft again", async () => {
    const first = await executeCourseAction("course", envelope(), claims);
    const receipt = mocks.tx.domainEvent.create.mock.calls[0][0].data;
    mocks.tx.domainEvent.findUnique.mockResolvedValue(receipt);
    expect(await executeCourseAction("course", envelope(), claims)).toEqual(first);
    expect(mocks.tx.classroomSubmission.upsert).toHaveBeenCalledTimes(1);
  });
  it("rejects changed content using the same request id", async () => {
    await executeCourseAction("course", envelope(), claims);
    mocks.tx.domainEvent.findUnique.mockResolvedValue(mocks.tx.domainEvent.create.mock.calls[0][0].data);
    const changed = envelope();
    if (changed.action.type === "UPSERT_SUBMISSION") changed.action.payload.submission = { ...submission, content: "其他内容" };
    await expect(executeCourseAction("course", changed, claims)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
  it("rejects a delayed autosave after a newer edit or finalize", async () => {
    mocks.tx.classroomSubmission.findUnique.mockResolvedValue({ payload: { view: { ...submission, version: 3, status: "submitted" } } });
    await expect(executeCourseAction("course", envelope(2), claims)).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT", details: { currentVersion: 3, currentSubmission: { ...submission, version: 3, status: "submitted" } } });
    expect(mocks.tx.classroomSubmission.upsert).not.toHaveBeenCalled();
  });
  it("does not save a queued draft after classroom closure", async () => {
    const participation = await mocks.tx.classroomParticipation.findFirst();
    participation.instance.status = "FINISHED";
    await expect(executeCourseAction("course", envelope(), claims)).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    expect(mocks.tx.classroomSubmission.upsert).not.toHaveBeenCalled();
  });
  it.each([{ userStatus: "DISABLED" }, { userRole: "TEACHER" }, { sessionVersion: 2 }, { enrollmentStatus: "WITHDRAWN" }])("rejects revoked identity or enrollment even for a committed receipt", async (revocation) => {
    await executeCourseAction("course", envelope(), claims);
    mocks.tx.domainEvent.findUnique.mockResolvedValue(mocks.tx.domainEvent.create.mock.calls[0][0].data);
    const row = (await mocks.tx.$queryRaw())[0];
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, ...revocation }]);
    await expect(executeCourseAction("course", envelope(), claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.tx.classroomSubmission.upsert).toHaveBeenCalledTimes(1);
  });
  it("replays completed enrollment receipts after closure but rejects new writes", async () => {
    const first = await executeCourseAction("course", envelope(), claims);
    mocks.tx.domainEvent.findUnique.mockResolvedValue(mocks.tx.domainEvent.create.mock.calls[0][0].data);
    const row = (await mocks.tx.$queryRaw())[0];
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, enrollmentStatus: "COMPLETED", instanceStatus: "FINISHED" }]);
    expect(await executeCourseAction("course", envelope(), claims)).toEqual(first);
    mocks.tx.$queryRaw.mockResolvedValue([{ ...row, receipt: null, enrollmentStatus: "COMPLETED", instanceStatus: "FINISHED" }]);
    await expect(executeCourseAction("course", envelope(), claims)).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
  });
  it("rejects an incomplete SQL commit without publishing", async () => {
    const row = (await mocks.tx.$queryRaw())[0];
    mocks.tx.$queryRaw.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(executeCourseAction("course", envelope(), claims)).rejects.toThrow("DRAFT_COMMIT_INCOMPLETE");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects reusing another student's submission identity", async () => {
    mocks.tx.classroomSubmission.findFirst.mockResolvedValue({ participationId: "other", stageKey: "make:document" });
    await expect(executeCourseAction("course", envelope(), claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION_SCOPE" });
    expect(mocks.tx.classroomSubmission.upsert).not.toHaveBeenCalled();
  });
});
