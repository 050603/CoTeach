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
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: vi.fn() }));
vi.mock("@/lib/db/transaction-retry", () => {
  // Model the participation row lock held by the real database transaction.
  let previous: Promise<unknown> = Promise.resolve();
  return { runMutationTransaction: (operation: (tx: typeof mocks.db) => unknown) => {
    const result = previous.then(() => operation(mocks.db));
    previous = result.catch(() => undefined);
    return result;
  } };
});
vi.mock("@/lib/companion/server-store", () => ({
  appendCompanionMessagesWithinTransaction: mocks.append,
  ensureCompanionThreadWithinTransaction: async () => ({
    row: { id: "thread-1" },
    participation: { enrollment: { offeringId: "offering-1" } },
  }),
}));

import { buildDocumentSuggestionRequest, cachedDocumentSuggestions } from "./document-suggestion-cache";

import {
  cancelDocumentRequest,
  claimDocumentRequest,
  completeDocumentRequest,
  failDocumentRequest,
  prepareDocumentRequestResponse,
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


describe("persistent document work suggestions", () => {
  const context = () => ({
    courseId: "course-1", studentId: "student-1", participationId: "participation-1", stageKey: "make",
    workspaceKind: "document", threadStageKey: "ai-collaboration:make", documentHtml: "<p>调查记录</p>",
    generationPrompts: { system: "生成任务", user: "完整课程要求和文稿" },
    reviewPrompts: { system: "审核边界", user: "完整课程要求和文稿" },
    model: { endpoint: "https://example.test", model: "configured-model" },
  });
  beforeEach(() => { mocks.rows.clear(); vi.clearAllMocks(); });

  it("invalidates reuse for every relevant identity, complete document, prompt and model change", () => {
    const original = context();
    const first = buildDocumentSuggestionRequest(original);
    expect(buildDocumentSuggestionRequest(context())).toEqual(first);
    for (const change of [
      { studentId: "other-student" }, { participationId: "another-class" }, { courseId: "course-2" },
      { stageKey: "proposal" }, { workspaceKind: "external-artifact" },
      { documentHtml: `${original.documentHtml}<p>新增中间段落</p>` },
      { generationPrompts: { ...original.generationPrompts, user: "新的课程要求" } },
      { reviewPrompts: { ...original.reviewPrompts, system: "新版审核规则" } },
      { model: { ...original.model, model: "updated-model" } },
    ]) expect(buildDocumentSuggestionRequest({ ...original, ...change }).requestId).not.toBe(first.requestId);
  });

  it("merges 30 simultaneous requests and reuses a completed no-suggestion decision", async () => {
    const task = buildDocumentSuggestionRequest(context());
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn(async () => { started(); await gate; return []; });
    const first = cachedDocumentSuggestions(task, generate);
    await startedPromise;
    const joined = await Promise.all(Array.from({ length: 29 }, () => cachedDocumentSuggestions(task, generate)));
    expect(joined.every(result => result.status === 202)).toBe(true);
    release();
    expect(await first).toMatchObject({ status: 200, body: { starters: [], resultSource: "generated" } });
    const replayed = await Promise.all(Array.from({ length: 30 }, () => cachedDocumentSuggestions(task, generate)));
    expect(replayed.every(result => result.status === 200 && result.body.resultSource === "reused")).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledOnce();
  });

  it("retains successful model work if committing its decision audit fails", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn(async () => ["整理文稿中已有数据的记录表"]);
    mocks.db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(cachedDocumentSuggestions(task, generate)).rejects.toThrow("audit unavailable");
    expect(await cachedDocumentSuggestions(task, generate)).toMatchObject({
      status: 200, body: { starters: ["整理文稿中已有数据的记录表"] },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not treat generation failure as a cached empty answer", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn().mockRejectedValueOnce(new Error("upstream timeout")).mockResolvedValueOnce([]);
    await expect(cachedDocumentSuggestions(task, generate)).rejects.toThrow("upstream timeout");
    expect(await cachedDocumentSuggestions(task, generate)).toMatchObject({ status: 200, body: { starters: [] } });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("resumes paid candidates after a review timeout but never publishes unreviewed suggestions", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn(async () => ["未审核候选"]);
    const review = vi.fn().mockRejectedValueOnce(new Error("review timed out")).mockResolvedValueOnce(["已审核建议"]);
    const work = async (token: string, prepared?: string[]) => {
      const candidates = prepared ?? await generate();
      if (!prepared) await prepareDocumentRequestResponse({ ...task, token, response: { candidateStarters: candidates } });
      return review(candidates);
    };
    await expect(cachedDocumentSuggestions(task, work)).rejects.toThrow("review timed out");
    expect(await readDocumentRequestReceipt(task)).toMatchObject({ body: { status: "failed" } });
    expect((await readDocumentRequestReceipt(task)).body).not.toHaveProperty("starters");
    expect(await cachedDocumentSuggestions(task, work)).toMatchObject({ status: 200, body: { starters: ["已审核建议"] } });
    expect(generate).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("never gives another student's saved suggestion to a changed authenticated identity", async () => {
    const generate = vi.fn(async () => ["整理当前文稿中已有的引用来源清单"]);
    const task = buildDocumentSuggestionRequest(context());
    await cachedDocumentSuggestions(task, generate);
    expect(await cachedDocumentSuggestions({ ...task, studentId: "student-2" }, generate)).toMatchObject({ status: 409 });
    expect(generate).toHaveBeenCalledOnce();
  });
});
