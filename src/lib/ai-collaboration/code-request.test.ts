import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), prepare: vi.fn(), fail: vi.fn(), receipt: vi.fn(),
  settings: vi.fn(), cache: vi.fn() }));
vi.mock("./document-request-store", () => ({ claimDocumentRequest: mocks.claim, completeDocumentRequest: mocks.complete,
  prepareDocumentRequestResponse: mocks.prepare, failDocumentRequest: mocks.fail, readDocumentRequestReceipt: mocks.receipt }));
vi.mock("@/lib/llm/settings", () => ({ getActiveAiSettings: mocks.settings }));
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: mocks.cache }));
import { beginCodeRequest, codeBackgroundRequestId } from "./code-request";
const input = { requestId: "code-request", participationId: "participation", courseId: "course", studentId: "student", stageKey: "make",
  workspaceKind: "code:python", conversationId: "legacy", threadStageKey: "ai-code-collaboration:make:python", fingerprint: "body-hash",
  documentVersion: "artifact-hash", message: "help", intent: "discuss", history: [] };
describe("code AI receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({ endpoint: "provider", model: "same-model" });
    mocks.claim.mockResolvedValue({ kind: "run", token: "lease", history: [] });
    mocks.prepare.mockResolvedValue(true);
    mocks.complete.mockResolvedValue(true);
  });
  it("replays a completed request and joins an in-flight request without generating again", async () => {
    mocks.claim.mockResolvedValue({ kind: "existing", state: { status: "completed" } });
    mocks.receipt.mockResolvedValue({ status: 200, body: { result: "saved answer" } });
    expect(await (await beginCodeRequest(input)).response!.json()).toEqual({ result: "saved answer" });
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.claim.mockResolvedValue({ kind: "existing", state: { status: "processing" } });
    mocks.receipt.mockResolvedValue({ status: 202, body: { status: "processing" } });
    expect((await beginCodeRequest(input)).response!.status).toBe(202);
    expect(mocks.cache.mock.calls).toEqual([["code-collaboration", "hit"], ["code-collaboration", "joined"]]);
  });
  it("commits student-visible output, history and research audit together", async () => {
    const task = await beginCodeRequest(input);
    const response = await task.finish!({ result: { message: "answer" } }, [], [{ courseId: "course", studentId: "student", stageKey: "make",
      source: "sidebar", eventType: "request", actorRole: "student", content: "help" }]);
    expect(await response.json()).toMatchObject({ status: "completed", artifactVersion: "artifact-hash" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ token: "lease", messages: [], auditEvents: [expect.objectContaining({ actor: "student", content: "help" })] }));
  });
  it("recovers generated output when the final receipt transaction failed", async () => {
    mocks.claim.mockResolvedValue({ kind: "run", token: "replacement", history: [],
      preparedResponse: { body: { result: "already generated" }, messages: [], events: [] } });
    const task = await beginCodeRequest(input);
    expect(await task.response!.json()).toMatchObject({ result: "already generated", status: "completed" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ token: "replacement" }));
  });
  it("never accepts an obsolete worker's answer", async () => {
    mocks.prepare.mockResolvedValue(false);
    mocks.receipt.mockResolvedValue({ status: 202, body: { status: "processing" } });
    const task = await beginCodeRequest(input);
    expect((await task.finish!({ result: "obsolete" }, [])).status).toBe(202);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("invalidates background reuse when prompts, model, language or operation change", async () => {
    const context = { prompts: { system: "policy", user: "course requirements and code" }, action: "proactive-review", language: "python" };
    const original = await codeBackgroundRequestId(context);
    expect(await codeBackgroundRequestId({ ...context })).toBe(original);
    expect(await codeBackgroundRequestId({ ...context, prompts: { ...context.prompts, user: "new course requirements and code" } })).not.toBe(original);
    expect(await codeBackgroundRequestId({ ...context, action: "code-task-starters" })).not.toBe(original);
    expect(await codeBackgroundRequestId({ ...context, language: "c" })).not.toBe(original);
    const sameTruncatedPrompt = await codeBackgroundRequestId({ ...context, context: { artifact: "full code ending A", run: "complete log A" } });
    expect(await codeBackgroundRequestId({ ...context, context: { artifact: "full code ending B", run: "complete log A" } })).not.toBe(sameTruncatedPrompt);
    expect(await codeBackgroundRequestId({ ...context, context: { artifact: "full code ending A", run: "complete log B" } })).not.toBe(sameTruncatedPrompt);
    mocks.settings.mockResolvedValue({ endpoint: "provider", model: "new-model" });
    expect(await codeBackgroundRequestId(context)).not.toBe(original);
  });
});
