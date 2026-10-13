import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_BROWSER_TIMEOUT_MS, COLLABORATION_EXECUTION_TIMEOUT_MS } from "@/lib/ai-collaboration/request-budget";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./bounded-fetch", () => ({ boundedFetch: mocks.fetch }));
import { acknowledgeCodeAiRequest, readPendingCodeAiRequest, requestBackgroundCodeAi, requestCodeAi } from "./code-ai-request";
const body = { courseId: "course", studentId: "student", stageKey: "make", language: "python", intent: "discuss", message: "explain", artifact: { files: ["old"] } };
describe("durable code AI requests", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());
  it("reuses the paid request and its original artifact after a lost response", async () => {
    mocks.fetch.mockImplementationOnce(async (url: string) => Response.json({ error: "REQUEST_STATE_UNAVAILABLE", status: "failed", retryable: true,
      requestId: new URL(url, "https://test").searchParams.get("requestId") }, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    await expect(requestCodeAi("scope", "sidebar", body)).rejects.toThrow("offline");
    const pending = readPendingCodeAiRequest("scope", "sidebar")!;
    const posted = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(posted.requestId).toBe(pending.requestId);
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: "completed", result: { message: "done" } }));
    const result = await requestCodeAi("scope", "sidebar", { ...body, artifact: { files: ["new"] } });
    expect(result.pending.body.artifact).toEqual(body.artifact);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    acknowledgeCodeAiRequest("scope", "sidebar", pending.requestId);
    expect(readPendingCodeAiRequest("scope", "sidebar")).toBeNull();
  });
  it("does not overwrite an unresolved request with a different question", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(requestCodeAi("scope", "comment", body)).rejects.toThrow();
    await expect(requestCodeAi("scope", "comment", { ...body, message: "different" })).rejects.toThrow("先恢复");
    expect(readPendingCodeAiRequest("scope", "comment")?.body.message).toBe("explain");
    expect(readPendingCodeAiRequest("another-student", "comment")).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not launch generation after an infrastructure failure or denied receipt read", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "DATABASE_UNAVAILABLE" }, { status: 503 }));
    expect((await requestCodeAi("scope", "sidebar", body)).response.status).toBe(503);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "FORBIDDEN" }, { status: 403 }));
    expect((await requestCodeAi("scope", "sidebar", body)).response.status).toBe(403);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("joins a background review until its durable receipt completes", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValueOnce(Response.json({ requestId: "background", status: "processing" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ requestId: "background", status: "processing" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ requestId: "background", status: "completed", commentThreads: [] }));
    const result = requestBackgroundCodeAi(body, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await (await result).json()).toMatchObject({ status: "completed", commentThreads: [] });
    expect(mocks.fetch.mock.calls[0][1].method).toBe("POST");
    expect(mocks.fetch.mock.calls[1][0]).toContain("requestId=background");
    expect(mocks.fetch.mock.calls[2][0]).toContain("requestId=background");
  });
  it("keeps waiting for a normal reasoning review past the old 50 second cutoff", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const controller = new AbortController();
    mocks.fetch.mockImplementation(async () => Date.now() - startedAt < 105_000
      ? Response.json({ requestId: "long-review", status: "processing" }, { status: 202 })
      : Response.json({ requestId: "long-review", status: "completed", commentThreads: [] }));
    const result = requestBackgroundCodeAi(body, controller.signal);
    await vi.advanceTimersByTimeAsync(105_000);
    expect(await (await result).json()).toMatchObject({ status: "completed" });
    expect(mocks.fetch.mock.calls[0][2]).toBe(COLLABORATION_BROWSER_TIMEOUT_MS);
    expect(COLLABORATION_BROWSER_TIMEOUT_MS).toBeGreaterThan(COLLABORATION_EXECUTION_TIMEOUT_MS);
    expect(mocks.fetch.mock.calls.every(call => call[1].signal === controller.signal)).toBe(true);
  });
  it("still cancels a pending background receipt when the artifact becomes stale", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockResolvedValue(Response.json({ requestId: "background", status: "processing" }, { status: 202 }));
    const controller = new AbortController();
    const result = requestBackgroundCodeAi(body, controller.signal);
    const rejected = expect(result).rejects.toThrow("artifact changed");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("artifact changed"));
    await rejected;
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
