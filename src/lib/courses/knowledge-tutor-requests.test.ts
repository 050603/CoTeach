import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeLectureTutorThread } from "@/lib/session/types";
type Task = { id: string; status: string; input: Record<string, unknown>; output?: unknown; conversationId: string; startedAt: Date | null };
const mocks = vi.hoisted(() => {
  const tasks = new Map<string, Task>();
  const tx = {
    aiTask: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiConversation: { upsert: vi.fn() }, aiMessage: { create: vi.fn() }, aiInteractionEvent: { create: vi.fn() },
    classroomParticipation: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
    studentProjectWorkspace: { update: vi.fn() }, classroomInstance: { update: vi.fn() }, domainEvent: { create: vi.fn() },
  };
  return { tasks, tx, lock: vi.fn() };
});
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (fn: (tx: typeof mocks.tx) => unknown) => fn(mocks.tx) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: vi.fn() }));
import { claimTutorRequest, failTutorRequest, finishTutorRequest, type TutorRequest } from "./knowledge-tutor-requests";
const input: TutorRequest = { courseId: "course", classroomId: "classroom", studentId: "student", requestId: "request", threadId: "thread", attemptId: "attempt", questionId: "question", message: "为什么", initial: false };
const additions = (index = 0): KnowledgeLectureTutorThread => ({ id: "thread", attemptId: "attempt", questionId: "question", messages: [ { id: `student-${index}`, role: "student", content: "为什么", createdAt: "2026-01-01T00:00:00.000Z" }, { id: `assistant-${index}`, role: "assistant", content: `解释${index}`, createdAt: "2026-01-01T00:00:00.000Z" } ], boardNotes: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
beforeEach(() => {
  vi.resetAllMocks(); mocks.tasks.clear();
  mocks.tx.aiTask.findUnique.mockImplementation(async ({ where }) => mocks.tasks.get(where.id) ?? null);
  mocks.tx.aiTask.findUniqueOrThrow.mockImplementation(async ({ where }) => mocks.tasks.get(where.id)!);
  mocks.tx.aiTask.create.mockImplementation(async ({ data }: { data: Task }) => { mocks.tasks.set(data.id, data); return data; });
  mocks.tx.aiTask.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Task> }) => { Object.assign(mocks.tasks.get(where.id)!, data); return mocks.tasks.get(where.id); });
  const workspace = { projectState: { aiLearningProgress: { classroomId: "classroom", studentId: "student", knowledgeLectureTutorThreads: [] } } };
  const participation = { id: "participation", enrollment: { status: "ACTIVE", offeringId: "offering", researchKey: "research" }, workspace, instance: { status: "TEACHING", runtimeConfig: { version: 1 }, activity: { chapter: { offering: { status: "OPEN" } } } } };
  mocks.tx.classroomParticipation.findFirst.mockResolvedValue(participation);
  mocks.tx.classroomParticipation.findFirstOrThrow.mockResolvedValue(participation);
  mocks.tx.studentProjectWorkspace.update.mockImplementation(async ({ data }) => { workspace.projectState = data.projectState; });
});
describe("durable knowledge tutor requests", () => {
  it("records a question before AI and replays the committed result without duplicate messages", async () => {
    const claim = await claimTutorRequest(input);
    expect(claim.run).toBe(true);
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "RUNNING", thread: undefined });
    if (!claim.run) throw new Error("claim failed");
    const thread = await finishTutorRequest(input, claim.token, additions());
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "COMPLETED", thread });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.aiTask.create).toHaveBeenCalledOnce();
  });
  it("retains long answers and exact model JSON without extra facts or replay overwrite", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    const threadInput = additions();
    const answer = "完整回答".repeat(1_500);
    threadInput.messages[1].content = answer;
    const raw = "  " + JSON.stringify({ answer, boardNotes: [{ title: "full title", body: "完整板书".repeat(300) }] }) + "\n";
    const thread = await finishTutorRequest(input, claim.token, threadInput, raw);
    const output = [...mocks.tasks.values()][0].output;
    expect(output).toMatchObject({ modelOutput: { raw, sha256: createHash("sha256").update(raw).digest("hex") } });
    expect(mocks.tx.aiMessage.create.mock.calls[1][0].data.content).toBe(answer);
    expect(mocks.tx.aiInteractionEvent.create.mock.calls[1][0].data.content).toBe(answer);
    expect(await finishTutorRequest(input, claim.token, additions(), "altered response")).toEqual(thread);
    expect(await claimTutorRequest(input)).toMatchObject({ status: "COMPLETED", thread });
    expect([...mocks.tasks.values()][0].output).toEqual(output);
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.aiInteractionEvent.create).toHaveBeenCalledTimes(2);
  });
  it("retains the complete conversation beyond the bounded UI cache", async () => {
    for (let index = 0; index < 20; index++) {
      const request = { ...input, requestId: `request-${index}` };
      const claim = await claimTutorRequest(request);
      if (!claim.run) throw new Error("claim failed");
      await finishTutorRequest(request, claim.token, additions(index));
    }
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledTimes(40);
    expect(mocks.tx.aiInteractionEvent.create).toHaveBeenCalledTimes(40);
    const participation = await mocks.tx.classroomParticipation.findFirstOrThrow();
    expect(participation.workspace.projectState.aiLearningProgress.knowledgeLectureTutorThreads[0].messages).toHaveLength(30);
    expect(mocks.tx.aiMessage.create.mock.calls[1][0].data.content).toBe("解释0");
  });
  it("rejects a reused request id with different content", async () => {
    await claimTutorRequest(input);
    await expect(claimTutorRequest({ ...input, message: "其他问题" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
  });
  it("keeps cancellation final and refuses a late assistant answer", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    await failTutorRequest(input, claim.token, true);
    await expect(finishTutorRequest(input, claim.token, additions())).rejects.toMatchObject({ code: "TUTOR_REQUEST_EXPIRED" });
    expect(await claimTutorRequest(input)).toMatchObject({ run: false, status: "CANCELLED" });
    expect(mocks.tx.aiMessage.create).toHaveBeenCalledOnce();
  });
  it("turns an interrupted process request into a durable failure on reconnect", async () => {
    await claimTutorRequest(input);
    for (const task of mocks.tasks.values()) task.startedAt = new Date(Date.now() - 181_000);
    expect(await claimTutorRequest(input)).toEqual({ run: false, status: "FAILED" });
    expect([...mocks.tasks.values()][0].status).toBe("FAILED");
  });
  it("rejects new questions after closure while preserving accepted results", async () => {
    const claim = await claimTutorRequest(input);
    if (!claim.run) throw new Error("claim failed");
    const participation = await mocks.tx.classroomParticipation.findFirst();
    participation.instance.status = "FINISHED";
    await expect(claimTutorRequest({ ...input, requestId: "new" })).rejects.toMatchObject({ code: "CLASSROOM_READ_ONLY" });
    await expect(finishTutorRequest(input, claim.token, additions())).resolves.toMatchObject({ id: "thread" });
  });
});
