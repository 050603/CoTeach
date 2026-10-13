import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_EXECUTION_TIMEOUT_MS, COLLABORATION_REQUEST_LEASE_MS } from "@/lib/ai-collaboration/request-budget";
const mocks = vi.hoisted(() => ({
  llm: vi.fn(), background: vi.fn(), append: vi.fn(), claim: vi.fn(), complete: vi.fn(), prepare: vi.fn(), receipt: vi.fn(),
  tasks: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/ai-collaboration/legacy-scope", () => ({ authenticateLegacyAiStudent: async () => ({ studentId: "student", participationId: "participation", claims: null }) }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: async () => ({ id: "course", name: "project", students: [{ id: "student", name: "Student" }], stages: [{ key: "make" }], currentStageIndex: 0, content: {} }) }));
vi.mock("@/lib/companion/server-store", () => ({ getCompanionThread: async () => ({ messages: [] }), appendCompanionMessages: mocks.append,
  softDeleteCompanionMessage: vi.fn(), companionMessage: (message: object) => ({ ...message, id: crypto.randomUUID(), createdAt: new Date().toISOString() }) }));
vi.mock("@/lib/ai-collaboration/code-policy", () => ({
  buildCodeCollaborationPrompts: (input: { artifact: unknown }) => ({ system: "same policy", user: JSON.stringify(input.artifact) }),
  buildCodeTaskStarterPrompts: (input: { artifact: unknown }) => ({ system: "starter policy", user: JSON.stringify(input.artifact) }),
  detectProtectedCodeWorkRequest: () => undefined, isCodeCollaborationIntent: () => true,
  normalizeCodeCollaborationResponse: ({ raw }: { raw: unknown }) => raw,
  normalizeCodeTaskStarters: (raw: { starters: string[] }) => raw.starters,
}));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.llm, parseLLMJson: JSON.parse }));
vi.mock("@/lib/llm/settings", () => ({ getActiveAiSettings: async () => ({ model: "model", endpoint: "provider" }) }));
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: vi.fn(), withClassroomAiUsage: (_scope: unknown, operation: () => unknown) => operation() }));
vi.mock("@/lib/ai-collaboration/proactive-review-capacity", () => ({
  withProactiveReviewCapacity: mocks.background, ProactiveReviewCapacityError: class extends Error {},
}));
vi.mock("@/lib/ai-collaboration/project-support-types", () => ({ normalizeProjectSupportOutput: () => ({ details: {}, memoryCandidates: [] }) }));
vi.mock("@/lib/ai-collaboration/project-support-server", () => ({
  resolveProjectSupportContext: async () => ({ promptContext: "support", sources: [], knowledgePointLabels: [] }),
  listProjectMemories: async () => [], projectMemoryContinuation: () => null, dismissProjectMemories: vi.fn(), saveProjectMemoryCandidates: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/document-request-store", () => ({
  claimDocumentRequest: mocks.claim, completeDocumentRequest: mocks.complete, prepareDocumentRequestResponse: mocks.prepare,
  failDocumentRequest: vi.fn(), readDocumentRequestReceipt: mocks.receipt,
}));
import { GET, POST } from "./route";
const artifact = { version: 1, language: "python", activeFileId: "main", files: [{ id: "main", path: "main.py", content: "print(1)" }] };
const input = { courseId: "course", studentId: "student", stageKey: "make", language: "python", requestId: "request", conversationId: "legacy", intent: "discuss", message: "explain", artifact };
const request = (body: object) => new NextRequest("http://localhost/api/ai-collaboration/code", { method: "POST", body: JSON.stringify(body) });
describe("code AI route receipts", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks(); mocks.tasks.clear();
    mocks.llm.mockResolvedValue(JSON.stringify({ kind: "discussion", message: "answer", findings: [], starters: ["check"] }));
    mocks.background.mockImplementation((operation: () => unknown) => operation());
    mocks.claim.mockImplementation(async (task: { requestId: string; history: unknown }) => mocks.tasks.has(task.requestId)
      ? { kind: "existing", state: { status: "completed" } } : { kind: "run", token: "lease", history: task.history });
    mocks.prepare.mockResolvedValue(true);
    mocks.complete.mockImplementation(async (task: { requestId: string; response: Record<string, unknown> }) => { mocks.tasks.set(task.requestId, task.response); return true; });
    mocks.receipt.mockImplementation(async (task: { requestId: string }) => ({ status: 200, body: mocks.tasks.get(task.requestId) }));
  });
  it("replays chat and GET receipts with one model call and one atomic history commit", async () => {
    const first = await (await POST(request(input))).json();
    const replay = await (await POST(request(input))).json();
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "completed", requestId: "request", result: { message: "answer" } });
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete.mock.calls[0][0].messages).toHaveLength(2);
    expect(mocks.append).not.toHaveBeenCalled();
    const receipt = await GET(new NextRequest("http://localhost/api/ai-collaboration/code?courseId=course&studentId=student&stageKey=make&language=python&requestId=request"));
    expect(await receipt.json()).toEqual(first);
  });
  it("reuses no-finding background reviews and runs them with background priority", async () => {
    const body = { ...input, intent: "proactive-review", message: "" };
    const first = await (await POST(request(body))).json();
    expect(first.commentThreads).toEqual([]);
    expect(await (await POST(request({ ...body, requestId: "another-tab" }))).json()).toEqual(first);
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.background).toHaveBeenCalledOnce();
    await POST(request({ ...body, artifact: { ...artifact, files: [{ ...artifact.files[0], content: "print(2)" }] } }));
    expect(mocks.llm).toHaveBeenCalledTimes(2);
  });
  it("reuses task suggestions across new client request IDs", async () => {
    const body = { ...input, action: "code-task-starters", mode: "discuss" };
    const first = await (await POST(request(body))).json();
    expect(first.starters).toEqual(["check"]);
    expect(await (await POST(request({ ...body, requestId: "another-tab" }))).json()).toEqual(first);
    expect(mocks.llm).toHaveBeenCalledOnce();
    expect(mocks.background).toHaveBeenCalledOnce();
  });
  it.each([
    { intent: "proactive-review", message: "" },
    { action: "code-task-starters", mode: "discuss" },
  ])("allows a full reasoning budget for background $intent $action while retaining stale-request cancellation", async action => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const caller = new AbortController();
    await POST(new NextRequest("http://localhost/api/ai-collaboration/code", {
      method: "POST", body: JSON.stringify({ ...input, ...action }), signal: caller.signal,
    }));
    expect(timeout).toHaveBeenCalledWith(COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(COLLABORATION_EXECUTION_TIMEOUT_MS).toBe(110_000);
    expect(COLLABORATION_REQUEST_LEASE_MS).toBeGreaterThan(COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(mocks.background).toHaveBeenCalledOnce();
    const modelSignal = mocks.llm.mock.calls[0][1].abortSignal as AbortSignal;
    expect(modelSignal.aborted).toBe(false);
    caller.abort(new Error("artifact changed"));
    expect(modelSignal.aborted).toBe(true);
    expect(modelSignal.reason.message).toBe("artifact changed");
  });
});
