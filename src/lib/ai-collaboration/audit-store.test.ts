import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: { $queryRaw: vi.fn(), classroomParticipation: { findFirst: vi.fn() }, aiConversation: { findFirst: vi.fn(), upsert: vi.fn() }, aiInteractionEvent: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (db: unknown) => unknown) => operation(mocks.db) }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { appendAiInteractionEvents, listAiInteractionEvents } from "./audit-store";
const event = { courseId: "instance", studentId: "student", stageKey: "make", conversationId: "editor-logical", source: "sidebar" as const, eventType: "response" as const, actorRole: "ai" as const, content: "建议", requestId: "request" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.classroomParticipation.findFirst.mockResolvedValue({ id: "participation", enrollment: { offeringId: "offering", researchKey: "research" }, instance: { activity: { chapter: { offeringId: "offering" } } } });
  mocks.db.aiConversation.upsert.mockImplementation(({ create }) => Promise.resolve(create));
  mocks.db.aiInteractionEvent.create.mockImplementation(({ data }) => Promise.resolve({ id: "event", createdAt: new Date(), ...data }));
  mocks.db.aiInteractionEvent.findMany.mockResolvedValue([]);
});
describe("legacy AI research fact bridge", () => {
  it("resolves logical editor conversation IDs and preserves the legacy response contract", async () => {
    const [result] = await appendAiInteractionEvents([event]);
    expect(result).toMatchObject({ courseId: "instance", studentId: "student", stageKey: "make", conversationId: "editor-logical", actorRole: "ai", content: "建议" });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ researchKey: "research", offeringId: "offering", participationId: "participation", actor: "assistant", conversationId: expect.stringMatching(/^legacy-ai-conversation:/) }) });
  });
  it("deduplicates retried request events before any foreign-key writes", async () => {
    await appendAiInteractionEvents([event]);
    const saved = mocks.db.aiInteractionEvent.create.mock.calls[0][0].data;
    mocks.db.aiInteractionEvent.findUnique.mockResolvedValue({ ...saved, id: "event", createdAt: new Date() });
    mocks.db.aiInteractionEvent.create.mockClear(); mocks.db.aiConversation.upsert.mockClear();
    await appendAiInteractionEvents([event]);
    expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled(); expect(mocks.db.aiConversation.upsert).not.toHaveBeenCalled();
  });
  it("rejects AI events without an actual student participation", async () => {
    mocks.db.classroomParticipation.findFirst.mockResolvedValue(null);
    await expect(appendAiInteractionEvents([event])).rejects.toMatchObject({ code: "EVENT_SCOPE_MISMATCH" });
    expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled();
  });
  it("scopes history by participation instance and rejects malformed cursors", async () => {
    await listAiInteractionEvents({ courseId: "instance", studentId: "student", stageKey: "make" });
    expect(mocks.db.aiInteractionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { participation: { instanceId: "instance" }, userId: "student", payload: { path: ["legacy", "stageKey"], equals: "make" } } }));
    await expect(listAiInteractionEvents({ courseId: "instance", cursor: "invalid" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
