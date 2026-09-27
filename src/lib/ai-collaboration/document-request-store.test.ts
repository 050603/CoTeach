import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  taskType: string;
  createdById: string;
  conversationId: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

const mocks = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const append = vi.fn(async () => undefined);
  const publish = vi.fn(async () => undefined);
  const db = {
    $queryRaw: vi.fn(async () => []),
    classroomParticipation: { findUniqueOrThrow: vi.fn(async () => ({ instanceId: "course-1", enrollment: { userId: "student-1", offeringId: "offering-1", researchKey: "research-1" } })) },
    aiInteractionEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    aiTask: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { id: string; createdById: string } }) => {
        const row = rows.get(where.id);
        return row?.createdById === where.createdById ? row : null;
      }),
      findMany: vi.fn(async () => [...rows.values()]),
      create: vi.fn(async ({ data }: { data: Partial<Row> & { id: string } }) => {
        const row = {
          status: "RUNNING", input: {}, output: null, error: null, startedAt: null,
          completedAt: null, createdAt: new Date(), ...data,
        } as Row;
        rows.set(data.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        rows.set(where.id, row);
        return row;
      }),
    },
  };
  return { rows, append, publish, db };
});

vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/db/transaction-retry", () => ({
  runMutationTransaction: (operation: (tx: typeof mocks.db) => unknown) => operation(mocks.db),
}));
vi.mock("@/lib/companion/server-store", () => ({
  appendCompanionMessagesWithinTransaction: mocks.append,
  ensureCompanionThreadWithinTransaction: async () => ({
    row: { id: "thread-1" },
    participation: { enrollment: { offeringId: "offering-1" } },
  }),
}));

import {
  cancelDocumentRequest,
  claimDocumentRequest,
  completeDocumentRequest,
  failDocumentRequest,
  getDocumentRequest,
  readDocumentRequestReceipt,
  type DocumentRequestInput,
} from "./document-request-store";

const input = (requestId = "request-1"): DocumentRequestInput => ({
  requestId,
  participationId: "participation-1",
  courseId: "course-1",
  studentId: "student-1",
  stageKey: "make",
  workspaceKind: "document",
  threadStageKey: "ai-collaboration:make",
  conversationId: "logical-conversation-1",
  documentVersion: "document-v1",
  fingerprint: "same-body",
  message: "怎样核验这条数据？",
  intent: "discuss",
  history: [{ role: "user", content: "之前试过查原始表" }],
});

describe("document collaboration request receipts", () => {
  beforeEach(() => {
    mocks.rows.clear();
    vi.clearAllMocks();
  });

  it("returns processing for a concurrent duplicate, then replays one committed answer", async () => {
    const first = await claimDocumentRequest(input());
    expect(first.kind).toBe("run");
    expect(await claimDocumentRequest(input())).toMatchObject({
      kind: "existing",
      state: { requestId: "request-1", status: "processing" },
    });
    if (first.kind !== "run") throw new Error("expected run");
    const response = { result: { kind: "discussion", message: "核对原始表。" }, messages: [{ id: "message-1" }] };
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response })).toBe(true);
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response })).toBe(false);
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(await claimDocumentRequest(input())).toMatchObject({
      kind: "existing",
      state: { status: "completed", response },
    });
    expect(await getDocumentRequest(input())).toMatchObject({ status: "completed", response });
  });

  it("retries a failed identical request using its original conversation history", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    expect(await failDocumentRequest({ ...input(), token: first.token, error: "AI_COLLABORATION_TIMEOUT" })).toBe(true);
    expect(await claimDocumentRequest({ ...input(), fingerprint: "changed-body" })).toEqual({ kind: "conflict" });
    const retried = await claimDocumentRequest({ ...input(), history: [{ role: "user", content: "另一标签页的新消息" }] });
    expect(retried).toMatchObject({ kind: "run", history: input().history });
    if (retried.kind !== "run") throw new Error("expected retried run");
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response: {} })).toBe(false);
    expect(await completeDocumentRequest({ ...input(), token: retried.token, messages: [], response: {} })).toBe(true);
  });

  it("lets an expired lease be reclaimed without accepting the old worker's result", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    const row = [...mocks.rows.values()][0];
    row.startedAt = new Date(Date.now() - 130_000);
    expect(await getDocumentRequest(input())).toMatchObject({
      status: "failed",
      error: "REQUEST_INTERRUPTED",
    });
    const second = await claimDocumentRequest(input());
    if (second.kind !== "run") throw new Error("expected reclaimed run");
    expect(second.token).not.toBe(first.token);
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response: {} })).toBe(false);
    expect(await completeDocumentRequest({ ...input(), token: second.token, messages: [], response: {} })).toBe(true);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });
  it("returns the actual running or completed receipt after an old review token is replaced", async () => {
    const review = { ...input(), intent: "proactive-document-comments" };
    const first = await claimDocumentRequest(review); if (first.kind !== "run") throw new Error("expected run");
    [...mocks.rows.values()][0].startedAt = new Date(Date.now() - 130_000);
    const replacement = await claimDocumentRequest(review); if (replacement.kind !== "run") throw new Error("expected replacement");
    expect(await completeDocumentRequest({ ...review, token: first.token, messages: [], response: { wrong: true } })).toBe(false);
    expect(await readDocumentRequestReceipt(review)).toMatchObject({ status: 202, body: { requestId: review.requestId, status: "processing" } });
    const response = { requestId: review.requestId, status: "completed", commentThreads: [], reviewDecision: { outcome: "no-comment" } };
    expect(await completeDocumentRequest({ ...review, token: replacement.token, messages: [], response })).toBe(true);
    expect(await readDocumentRequestReceipt(review)).toEqual({ status: 200, body: response });
    expect(mocks.append).toHaveBeenCalledOnce();
  });
  it("returns cancellation only when the persistent task is cancelled", async () => {
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 503, body: { status: "failed" } });
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await cancelDocumentRequest(input());
    expect(await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: {} })).toBe(false);
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 409, body: { status: "cancelled" } });
  });
  it("commits a no-comment review with a scoped decision receipt and replays it without extra messages", async () => {
    const review = { ...input(), intent: "proactive-document-comment" };
    const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    const response = { commentThread: null, reviewDecision: { outcome: "no-comment", reasonCodes: ["MODEL_NO_COMMENT"] } };
    const auditEvents = [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system" as const, content: "不批注", payload: { detail: response.reviewDecision } }];
    expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response, auditEvents })).toBe(true);
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ userId: "student-1", participationId: "participation-1", offeringId: "offering-1", researchKey: "research-1", requestId: "request-1", taskId: expect.any(String), content: "不批注" })] });
    expect(await claimDocumentRequest(review)).toMatchObject({ kind: "existing", state: { status: "completed", response } });
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messages: [] }));
    expect(mocks.publish).toHaveBeenCalledWith("course-1", expect.objectContaining({ type: "companion-message", payload: expect.objectContaining({ requestId: "request-1", studentId: "student-1" }) }));
  });
  it("does not acknowledge completion when the review decision write fails", async () => {
    const review = input(); const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    mocks.db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error("decision write unavailable"));
    await expect(completeDocumentRequest({ ...review, token: claim.token, messages: [], response: { commentThread: null },
      auditEvents: [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system", content: "不批注", payload: {} }] })).rejects.toThrow("decision write unavailable");
    expect((await getDocumentRequest(review))?.status).toBe("processing");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("retains the completed database receipt if only its realtime notification fails", async () => {
    const review = input(); const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    mocks.publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response: { commentThread: null },
        auditEvents: [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system", content: "不批注", payload: {} }] })).toBe(true);
      expect((await getDocumentRequest(review))?.status).toBe("completed");
    } finally { log.mockRestore(); }
  });

  it("keeps cancellation final and prevents a late answer from being saved", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    expect(await cancelDocumentRequest(input())).toMatchObject({ status: "cancelled" });
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response: {} })).toBe(false);
    expect(await claimDocumentRequest(input())).toMatchObject({ kind: "existing", state: { status: "cancelled" } });
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
