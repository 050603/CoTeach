import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => {
  const db = {
    $queryRaw: vi.fn(),
    classroomParticipation: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    aiConversation: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiMessage: { create: vi.fn(), findMany: vi.fn() },
    aiTask: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    aiInteractionEvent: { findUnique: vi.fn(), create: vi.fn() },
    aiActionConfirmation: { findFirst: vi.fn(), update: vi.fn() },
    aiSupportRecord: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  };
  return { db, user: vi.fn(), llm: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (tx: unknown) => unknown) => operation(mocks.db) }));
vi.mock("./access", () => ({ getPlatformUser: mocks.user }));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.llm }));
import { aiCommandSchema, mutateAiCollaboration, readAiCollaboration } from "./ai-collaboration";
const claims = { sub: "student", role: "student" } as AuthClaims;
const conversation = { id: "conversation", userId: "student", participationId: "participation", offeringId: "offering", status: "OPEN" };
const participation = () => ({
  id: "participation", enrollment: { userId: "student", offeringId: "offering", status: "ACTIVE", researchKey: "research" },
  instance: { status: "TEACHING", activity: { archivedAt: null, chapter: { offering: { id: "offering", status: "OPEN", teachers: [{ userId: "teacher" }] } } } },
});
const send = { op: "send_message", idempotencyKey: "message-one", conversationId: "conversation", content: "如何设计调查？" } as const;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "student", role: "student" });
  mocks.db.classroomParticipation.findUnique.mockResolvedValue(participation());
  mocks.db.classroomParticipation.findUniqueOrThrow.mockResolvedValue(participation());
  mocks.db.aiConversation.findFirst.mockResolvedValue(conversation);
  mocks.db.aiConversation.findMany.mockResolvedValue([]);
  mocks.db.aiSupportRecord.findMany.mockResolvedValue([]);
  mocks.db.aiTask.findMany.mockResolvedValue([]);
  mocks.db.aiTask.create.mockResolvedValue({ id: "task" });
  mocks.db.aiTask.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.aiTask.findUnique.mockResolvedValue({ id: "task", createdById: "student", offeringId: "offering", conversation });
  mocks.db.aiMessage.findMany.mockResolvedValue([{ role: "user", content: send.content }]);
  mocks.llm.mockResolvedValue("先明确你想验证的问题，再设计三个开放问题。");
});
describe("V2 AI collaboration", () => {
  it("denies another student's participation before reading messages or writing facts", async () => {
    const row = participation(); row.enrollment.userId = "other";
    mocks.db.classroomParticipation.findUnique.mockResolvedValue(row);
    await expect(mutateAiCollaboration(claims, "participation", send)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.db.aiInteractionEvent.create).not.toHaveBeenCalled();
    expect(mocks.llm).not.toHaveBeenCalled();
  });
  it("denies corrupt cross-course participation", async () => {
    const row = participation(); row.enrollment.offeringId = "other";
    mocks.db.classroomParticipation.findUnique.mockResolvedValue(row);
    await expect(readAiCollaboration(claims, "participation")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("allows the offering teacher to read but never impersonate a student", async () => {
    mocks.user.mockResolvedValue({ id: "teacher", role: "teacher" });
    await expect(readAiCollaboration({ sub: "teacher", role: "teacher" } as AuthClaims, "participation")).resolves.toHaveProperty("conversations");
    await expect(mutateAiCollaboration({ sub: "teacher", role: "teacher" } as AuthClaims, "participation", send)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("keeps hidden and teacher-only legacy messages out of student reads", async () => {
    mocks.db.aiConversation.findMany.mockResolvedValue([{ ...conversation, messages: [
      { id: "private", metadata: { visibility: "teacher-only" } }, { id: "hidden", metadata: { hiddenFromStudentAt: new Date().toISOString() } }, { id: "visible", metadata: null },
    ] }]);
    const result = await readAiCollaboration(claims, "participation");
    expect(result.conversations[0].messages.map(message => message.id)).toEqual(["visible"]);
  });
  it("rejects closed classrooms before persisting a message", async () => {
    const row = participation(); row.instance.status = "ENDED";
    mocks.db.classroomParticipation.findUnique.mockResolvedValue(row);
    await expect(mutateAiCollaboration(claims, "participation", send)).rejects.toMatchObject({ code: "CLASSROOM_CLOSED" });
    expect(mocks.db.aiMessage.create).not.toHaveBeenCalled();
  });
  it("persists actual generated text and a linked research event", async () => {
    await mutateAiCollaboration(claims, "participation", send);
    expect(mocks.db.aiMessage.create).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ role: "user", userId: "student", content: send.content }) });
    expect(mocks.db.aiMessage.create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ role: "assistant", content: "先明确你想验证的问题，再设计三个开放问题。" }) });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ eventType: "generation_completed", researchKey: "research", participationId: "participation", taskId: "task" }) });
  });
  it("retains FAILED task and user input without manufacturing assistant output", async () => {
    mocks.llm.mockRejectedValue(new Error("secret provider detail"));
    await mutateAiCollaboration(claims, "participation", send);
    expect(mocks.db.aiMessage.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.aiTask.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.not.stringContaining("secret") }) }));
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ eventType: "generation_failed" }) });
  });
  it("returns the existing task for retries without another provider call", async () => {
    await mutateAiCollaboration(claims, "participation", send);
    const receipt = mocks.db.aiInteractionEvent.create.mock.calls[0][0].data;
    mocks.db.aiInteractionEvent.findUnique.mockResolvedValue(receipt);
    mocks.llm.mockClear(); mocks.db.aiMessage.create.mockClear();
    await mutateAiCollaboration(claims, "participation", send);
    expect(mocks.llm).not.toHaveBeenCalled(); expect(mocks.db.aiMessage.create).not.toHaveBeenCalled();
    await expect(mutateAiCollaboration(claims, "participation", { ...send, content: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("blocks interleaved messages while another generation runs", async () => {
    mocks.db.aiTask.findFirst.mockResolvedValue({ id: "running" });
    await expect(mutateAiCollaboration(claims, "participation", send)).rejects.toMatchObject({ code: "AI_BUSY" });
    expect(mocks.db.aiMessage.create).not.toHaveBeenCalled();
  });
  it("recovers interrupted generations with a research failure event before accepting a new message", async () => {
    mocks.db.aiTask.findMany.mockResolvedValue([{ id: "stale" }]);
    await mutateAiCollaboration(claims, "participation", send);
    expect(mocks.db.aiTask.update).toHaveBeenCalledWith({ where: { id: "stale" }, data: expect.objectContaining({ status: "FAILED" }) });
    expect(mocks.db.aiInteractionEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ taskId: "stale", eventType: "generation_failed", researchKey: "research", payload: { reason: "stale_request", schemaVersion: 1 } }) });
    expect(mocks.llm).toHaveBeenCalledOnce();
  });
  it("does not append a late provider result after a task has already failed", async () => {
    mocks.db.aiTask.updateMany.mockResolvedValue({ count: 0 });
    await mutateAiCollaboration(claims, "participation", send);
    expect(mocks.db.aiMessage.create).toHaveBeenCalledTimes(1);
  });
  it("rejects expired confirmations without changing task state", async () => {
    mocks.db.aiActionConfirmation.findFirst.mockResolvedValue({ status: "PENDING", expiresAt: new Date(0), taskId: "task" });
    await expect(mutateAiCollaboration(claims, "participation", { op: "decide_action", conversationId: "conversation", confirmationId: "confirmation", decision: "APPROVED", idempotencyKey: "decision" })).rejects.toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(mocks.db.aiActionConfirmation.update).not.toHaveBeenCalled();
  });
  it("records proposal confirmation without claiming action execution", async () => {
    mocks.db.aiActionConfirmation.findFirst.mockResolvedValue({ id: "confirmation", status: "PENDING", expiresAt: new Date(Date.now() + 5000), taskId: "task" });
    await mutateAiCollaboration(claims, "participation", { op: "decide_action", conversationId: "conversation", confirmationId: "confirmation", decision: "APPROVED", idempotencyKey: "decision" });
    expect(mocks.db.aiTask.update).toHaveBeenCalledWith({ where: { id: "task" }, data: expect.objectContaining({ output: { decision: "APPROVED", executed: false } }) });
  });
  it("rejects forged assistant roles and arbitrary actions in the command contract", () => {
    expect(aiCommandSchema.safeParse({ op: "execute_code", idempotencyKey: "key" }).success).toBe(false);
    expect(aiCommandSchema.safeParse({ ...send, content: " " }).success).toBe(false);
    expect(aiCommandSchema.safeParse({ ...send, content: "x".repeat(12001) }).success).toBe(false);
  });
});
