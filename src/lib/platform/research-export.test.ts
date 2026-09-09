import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import { exportOfferingResearch } from "./research-export";

const mocks = vi.hoisted(() => ({ teacher: vi.fn(), link: vi.fn(), events: vi.fn(), submissions: vi.fn(), outcomes: vi.fn(), ai: vi.fn() }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  aiInteractionEvent: { findMany: mocks.ai }, domainEvent: { findMany: mocks.outcomes }, courseTeacher: { findFirst: mocks.link }, learningEvent: { findMany: mocks.events }, activitySubmission: { findMany: mocks.submissions },
} }));
const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const at = new Date("2026-09-01T10:00:00.000Z");
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
const event = {
  id: ids[0], researchKey: "research-key", chapterId: "chapter", activityId: "activity",
  classroomInstanceId: "classroom", eventType: "activity.view", eventVersion: 1,
  occurredAt: at, receivedAt: at, source: "student", durationMs: 100,
  userId: "real-user", enrollmentId: "real-enrollment", metadata: { answer: "private answer" },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.link.mockResolvedValue({ id: "link" });
  mocks.events.mockResolvedValue([event]);
  mocks.submissions.mockResolvedValue([{ id: ids[0], researchKey: "research-key", activityId: "activity", activityVersion: 2, submittedAt: at,
    enrollmentId: "real-enrollment", activitySnapshot: { title: "Private question" }, payload: { answer: "Private answer" } }]);
});

describe("offering research export", () => {
  it("requires teacher membership before reading any research records", async () => {
    await expect(exportOfferingResearch({ ...claims, role: "student", studentName: "Student" }, "course", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.teacher).not.toHaveBeenCalled();
    mocks.link.mockResolvedValue(null);
    await expect(exportOfferingResearch(claims, "course", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.link).toHaveBeenCalledWith({ where: { offeringId: "course", userId: "teacher" }, select: { id: true } });
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.submissions).not.toHaveBeenCalled();
  });

  it("exports only event whitelist fields and marks missing historical research keys", async () => {
    mocks.events.mockResolvedValue([{ ...event, researchKey: null }]);
    const result = await exportOfferingResearch(claims, "course", {});
    expect(result).toMatchObject({ exportVersion: 1, nextCursor: null, rows: [{ researchKey: null, quality: "missing_research_key" }] });
    expect(result.rows[0]).not.toHaveProperty("userId");
    expect(result.rows[0]).not.toHaveProperty("enrollmentId");
    expect(result.rows[0]).not.toHaveProperty("metadata");
    expect(mocks.events.mock.calls[0][0].select).not.toHaveProperty("metadata");
    const content = await exportOfferingResearch(claims, "course", { includeContent: "true" });
    expect(content.rows[0]).toHaveProperty("metadata", event.metadata);
    expect(content.rows[0]).not.toHaveProperty("userId");
  });

  it("uses time plus ID to continue across identical timestamps within the same fixed window", async () => {
    mocks.events.mockResolvedValue([event, { ...event, id: ids[1] }]);
    const first = await exportOfferingResearch(claims, "course", { take: "1", since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" });
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    mocks.events.mockResolvedValue([{ ...event, id: ids[1] }]);
    const second = await exportOfferingResearch(claims, "course", { take: "1", cursor: first.nextCursor! });
    expect(second.rows[0].id).toBe(ids[1]);
    expect(second.nextCursor).toBeNull();
    expect(second.window).toEqual(first.window);
    expect(mocks.events.mock.calls[1][0]).toMatchObject({
      where: { offeringId: "course", receivedAt: { gte: new Date(first.window.since), lte: new Date(first.window.until) },
        OR: [{ receivedAt: { gt: at } }, { receivedAt: at, id: { gt: ids[0] } }] },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: 2,
    });
    await expect(exportOfferingResearch(claims, "other-course", { cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(exportOfferingResearch(claims, "course", { type: "submissions", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(exportOfferingResearch(claims, "course", { until: "2026-09-03T00:00:00Z", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("excludes submission content unless explicitly requested and scopes both relations", async () => {
    const result = await exportOfferingResearch(claims, "course", { type: "submissions", take: "500" });
    expect(result.rows[0]).toEqual({ id: ids[0], researchKey: "research-key", quality: "complete", activityId: "activity", activityVersion: 2, submittedAt: at });
    expect(mocks.submissions.mock.calls[0][0]).toMatchObject({ where: { enrollment: { offeringId: "course" }, activity: { chapter: { offeringId: "course" } } }, take: 501 });
    expect(mocks.submissions.mock.calls[0][0].select).not.toHaveProperty("payload");
    const content = await exportOfferingResearch(claims, "course", { type: "submissions", includeContent: "true" });
    expect(content.rows[0]).toHaveProperty("payload", { answer: "Private answer" });
    expect(content.rows[0]).toHaveProperty("activitySnapshot", { title: "Private question" });
    expect(content.rows[0]).not.toHaveProperty("enrollmentId");
  });

  it("paginates submissions by their submission timestamp and ID", async () => {
    const rows = await mocks.submissions();
    mocks.submissions.mockResolvedValue([...rows, { ...rows[0], id: ids[1] }]);
    const first = await exportOfferingResearch(claims, "course", { type: "submissions", take: "1" });
    await exportOfferingResearch(claims, "course", { type: "submissions", cursor: first.nextCursor! });
    expect(mocks.submissions.mock.lastCall?.[0]).toMatchObject({
      where: { OR: [{ submittedAt: { gt: at } }, { submittedAt: at, id: { gt: ids[0] } }] },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    });
  });

  it.each<Record<string, string>>([
    { take: "501" }, { take: "0" }, { take: "1.5" }, { type: "users" }, { includeContent: "1" },
    { since: "invalid" }, { until: "2026-02-30T00:00:00Z" },
    { since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" },
    { cursor: "eyJPUiI6W3t9XX0" }, { cursor: "' OR 1=1 --" }, { cursor: "a".repeat(2049) },
    { userId: "someone" },
  ])("rejects invalid query %j before reading research data", async (query) => {
    await expect(exportOfferingResearch(claims, "course", query)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.submissions).not.toHaveBeenCalled();
  });
});


describe("classroom outcomes export", () => {
  it("exports outcome receipts without identifying actor or answer content by default", async () => {
    mocks.outcomes.mockResolvedValue([{ id: ids[0], researchKey: "research-key", classroomInstanceId: "classroom", eventType: "CLASSROOM_REFLECT", createdAt: at, actorId: "student", payload: { result: { content: "private" } } }]);
    const result = await exportOfferingResearch(claims, "course", { type: "outcomes" });
    expect(result.rows[0]).toEqual({ id: ids[0], researchKey: "research-key", quality: "complete", classroomInstanceId: "classroom", eventType: "CLASSROOM_REFLECT", createdAt: at });
    expect(mocks.outcomes.mock.calls[0][0].select).not.toHaveProperty("payload");
    const content = await exportOfferingResearch(claims, "course", { type: "outcomes", includeContent: "true" });
    expect(content.rows[0]).toHaveProperty("payload.result.content", "private");
    expect(content.rows[0]).not.toHaveProperty("actorId");
  });
  it("paginates classroom outcomes by immutable creation time and ID", async () => {
    const row = { id: ids[0], researchKey: "r", classroomInstanceId: "i", eventType: "CLASSROOM_SUBMIT_STAGE", createdAt: at };
    mocks.outcomes.mockResolvedValue([row, { ...row, id: ids[1] }]);
    const first = await exportOfferingResearch(claims, "course", { type: "outcomes", take: "1" });
    await exportOfferingResearch(claims, "course", { type: "outcomes", cursor: first.nextCursor! });
    expect(mocks.outcomes.mock.lastCall?.[0]).toMatchObject({ where: { offeringId: "course", eventType: { startsWith: "CLASSROOM_" }, OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: ids[0] } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    await expect(exportOfferingResearch(claims, "course", { type: "events", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});


describe("AI and complete domain research export", () => {
  const aiRow = { id: ids[0], researchKey: "research", participation: { instanceId: "classroom" }, eventType: "response", actor: "assistant", createdAt: at, userId: "private-user", participationId: "private-participation", conversationId: "private-conversation", requestId: "private-client-key", content: "Private answer", payload: { detail: "Private prompt" } };
  const domainRow = { id: ids[0], researchKey: "research", classroomInstanceId: "classroom", eventType: "UPSERT_SUBMISSION", createdAt: at, actorId: "private-user", participationId: "private-participation", payload: { action: { text: "Private submission" } } };

  it("exports AI facts with a pseudonym and category fields, without identity or text by default", async () => {
    mocks.ai.mockResolvedValue([aiRow]);
    const result = await exportOfferingResearch(claims, "course", { type: "ai" });
    expect(result.rows[0]).toEqual({ id: ids[0], researchKey: "research", quality: "complete", classroomInstanceId: "classroom", eventType: "response", actor: "assistant", createdAt: at });
    const select = mocks.ai.mock.calls[0][0].select;
    for (const field of ["userId", "participationId", "conversationId", "requestId", "content", "payload"]) expect(select).not.toHaveProperty(field);
    expect(select.participation).toEqual({ select: { instanceId: true } });
    const content = await exportOfferingResearch(claims, "course", { type: "ai", includeContent: "true" });
    expect(content.rows[0]).toHaveProperty("content", "Private answer");
    expect(content.rows[0]).toHaveProperty("payload", aiRow.payload);
    expect(content.rows[0]).not.toHaveProperty("userId");
  });

  it("includes all domain event categories, including old five-stage actions and AI confirmations", async () => {
    mocks.outcomes.mockResolvedValue([domainRow, { ...domainRow, id: ids[1], eventType: "companion_confirmation_changed" }]);
    const result = await exportOfferingResearch(claims, "course", { type: "domain" });
    expect(result.rows).toMatchObject([{ eventType: "UPSERT_SUBMISSION" }, { eventType: "companion_confirmation_changed" }]);
    expect(mocks.outcomes.mock.calls[0][0].where).not.toHaveProperty("eventType");
    expect(result.rows[0]).not.toHaveProperty("payload");
    expect(result.rows[0]).not.toHaveProperty("actorId");
    const content = await exportOfferingResearch(claims, "course", { type: "domain", includeContent: "true" });
    expect(content.rows[0]).toHaveProperty("payload", domainRow.payload);
    expect(content.rows[0]).not.toHaveProperty("actorId");
  });

  it.each(["ai", "domain"] as const)("continues %s at identical timestamps and rejects changed cursor scope", async (type) => {
    const read = type === "ai" ? mocks.ai : mocks.outcomes;
    const row = type === "ai" ? aiRow : domainRow;
    read.mockResolvedValue([row, { ...row, id: ids[1] }]);
    const first = await exportOfferingResearch(claims, "course", { type, take: "1", includeContent: "true", since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" });
    read.mockResolvedValue([{ ...row, id: ids[1] }]);
    const second = await exportOfferingResearch(claims, "course", { type, cursor: first.nextCursor!, includeContent: "true" });
    expect(second.rows.map(row => row.id)).toEqual([ids[1]]);
    expect(second.window).toEqual(first.window);
    expect(second.nextCursor).toBeNull();
    expect(read.mock.lastCall?.[0]).toMatchObject({ where: { offeringId: "course", createdAt: { gte: new Date(first.window.since), lte: new Date(first.window.until) }, OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: ids[0] } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const changedQueries: Array<Record<string, string>> = [
      { type, includeContent: "false" }, { type: type === "ai" ? "domain" : "ai", includeContent: "true" },
      { type, includeContent: "true", until: "2026-09-03T00:00:00Z" },
    ];
    for (const query of changedQueries) await expect(exportOfferingResearch(claims, "course", { ...query, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(exportOfferingResearch(claims, "other-course", { type, includeContent: "true", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    mocks.link.mockResolvedValue(null);
    read.mockClear();
    await expect(exportOfferingResearch(claims, "course", { type, includeContent: "true", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["ai", "domain"] as const)("supports existing string IDs in %s cursors without assuming a database UUID type", async (type) => {
    const read = type === "ai" ? mocks.ai : mocks.outcomes;
    const row = type === "ai" ? aiRow : domainRow;
    read.mockResolvedValue([{ ...row, id: "legacy-event-1" }, { ...row, id: "legacy-event-2" }]);
    const first = await exportOfferingResearch(claims, "course", { type, take: "1" });
    read.mockResolvedValue([{ ...row, id: "legacy-event-2" }]);
    const next = await exportOfferingResearch(claims, "course", { type, cursor: first.nextCursor! });
    expect(next.rows[0].id).toBe("legacy-event-2");
  });

  it("labels records without a research snapshot without fabricating a participant match", async () => {
    mocks.ai.mockResolvedValue([{ ...aiRow, researchKey: null, participation: null }]);
    const ai = await exportOfferingResearch(claims, "course", { type: "ai" });
    expect(ai.rows[0]).toMatchObject({ researchKey: null, quality: "missing_research_key", classroomInstanceId: null });
    mocks.outcomes.mockResolvedValue([{ ...domainRow, researchKey: null }]);
    const domain = await exportOfferingResearch(claims, "course", { type: "domain" });
    expect(domain.rows[0]).toMatchObject({ researchKey: null, quality: "missing_research_key" });
  });
});
