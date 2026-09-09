import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(), classroomParticipation: { findFirst: vi.fn() },
    aiConversation: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), upsert: vi.fn() },
    aiMessage: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiInteractionEvent: { create: vi.fn() },
    aiTask: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (db: unknown) => unknown) => operation(mocks.db) }));
import { appendCompanionMessages, softDeleteCompanionMessage, persistCompanionState } from "./server-store";
const message = { id: "message", role: "student" as const, content: "问题", createdAt: new Date().toISOString(), visibility: "student-and-teacher" as const, conversationId: "logical" };
beforeEach(() => {
  vi.resetAllMocks();
  const participation = { id: "participation", enrollment: { offeringId: "offering", researchKey: "research" }, instance: { activity: { chapter: { offeringId: "offering" } } } };
  mocks.db.classroomParticipation.findFirst.mockResolvedValue(participation);
  mocks.db.aiConversation.upsert.mockResolvedValue({ id: "conversation" });
  mocks.db.aiConversation.findUniqueOrThrow.mockResolvedValue({ id: "conversation", userId: "student", offeringId: "offering", metadata: { legacyStageKey: "make" }, participation });
});
describe("V2 companion persistence", () => {
  it("persists each message and its research fact in the mutation transaction", async () => {
    await appendCompanionMessages({ courseId: "instance", studentId: "student", stageKey: "make", messages: [message] });
    expect(mocks.db.aiMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: "message", role: "user", content: "问题", conversationId: "conversation" }) });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "student", researchKey: "research", participationId: "participation", content: "问题" }) });
  });
  it("keeps retries from duplicating message history", async () => {
    mocks.db.aiMessage.findUnique.mockResolvedValue({ id: "message", conversationId: "conversation", metadata: {} });
    await appendCompanionMessages({ courseId: "instance", studentId: "student", stageKey: "make", messages: [message] });
    expect(mocks.db.aiMessage.create).not.toHaveBeenCalled(); expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled();
  });
  it("rejects a message ID belonging to another conversation", async () => {
    mocks.db.aiMessage.findUnique.mockResolvedValue({ id: "message", conversationId: "other" });
    await expect(appendCompanionMessages({ courseId: "instance", studentId: "student", stageKey: "make", messages: [message] })).rejects.toMatchObject({ code: "MESSAGE_SCOPE_MISMATCH" });
  });
  it("hides a message while preserving its original content", async () => {
    mocks.db.aiMessage.findFirst.mockResolvedValue({ id: "message", role: "user", content: "original", createdAt: new Date(), metadata: { conversationId: "logical", legacyRole: "student" } });
    await expect(softDeleteCompanionMessage({ courseId: "instance", studentId: "student", stageKey: "make", messageId: "message", conversationId: "logical" })).resolves.toBe(true);
    const update = mocks.db.aiMessage.update.mock.calls[0][0].data;
    expect(update).not.toHaveProperty("content"); expect(update.metadata).toMatchObject({ hiddenFromStudentAt: expect.any(String), excludedFromAiAt: expect.any(String) });
  });
  it("rejects task mutations targeting another participation", async () => {
    mocks.db.aiTask.findUnique.mockResolvedValue({ createdById: "other", conversationId: "other" });
    const task = { id: "task", courseId: "instance", studentId: "student", stageKey: "make", kind: "conversation" as const, title: "任务", request: "问题", status: "queued" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await expect(persistCompanionState(mocks.db as never, "instance", {}, { companionTasks: [task] })).rejects.toMatchObject({ code: "TASK_SCOPE_MISMATCH" });
    expect(mocks.db.aiTask.upsert).not.toHaveBeenCalled();
  });
});
