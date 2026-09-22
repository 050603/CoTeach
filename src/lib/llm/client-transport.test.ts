// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@openmaic/lib/server/proxy-fetch", () => ({ proxyFetch: mocks.transport }));
vi.mock("./settings", () => ({
  getActiveAiSettings: async () => ({
    endpoint: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    model: "deepseek-chat",
    proxy: "http://managed-proxy.internal:8080",
  }),
}));
vi.mock("@/lib/course-generation/llm-concurrency", () => ({
  withCourseGenerationLlmSlot: (run: () => unknown) => run(),
  reportCourseGenerationTokenUsage: vi.fn(),
}));

import { callLLM, callLLMStream } from "./client";

describe("teacher and student LLM network transport", () => {
  beforeEach(() => {
    mocks.transport.mockReset();
    // A direct fetch must never bypass the deployment's managed transport.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected direct network request"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the managed transport for a complete non-streaming answer on the first attempt", async () => {
    mocks.transport.mockResolvedValue(Response.json({ choices: [{ message: { content: "回答" } }] }));
    const controller = new AbortController();
    await expect(callLLM([{ role: "user", content: "问题" }], { abortSignal: controller.signal })).resolves.toBe("回答");
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.transport.mock.calls[0][2]).toBe("http://managed-proxy.internal:8080");
    const [url, init] = mocks.transport.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ model: "deepseek-chat", messages: [{ role: "user", content: "问题" }] });
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });

  it("uses the same managed transport for the full streaming answer on the first attempt", async () => {
    mocks.transport.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const chunks: string[] = [];
    for await (const chunk of callLLMStream([{ role: "user", content: "问题" }])) chunks.push(chunk);
    expect(chunks).toEqual(["回答"]);
    expect(mocks.transport.mock.calls[0][2]).toBe("http://managed-proxy.internal:8080");
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body)).toMatchObject({ stream: true });
  });

  it("preserves a connection failure without silently switching to an unconfigured direct route", async () => {
    const failure = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    mocks.transport.mockRejectedValue(failure);
    await expect(callLLM([{ role: "user", content: "问题" }])).rejects.toThrow("ECONNREFUSED");
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a finish_reason at EOF, including a final SSE line without a newline", async () => {
    mocks.transport.mockResolvedValue(new Response('data:{"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}'));
    const chunks: string[] = [];
    for await (const chunk of callLLMStream([{ role: "user", content: "问题" }])) chunks.push(chunk);
    expect(chunks).toEqual(["回答"]);
  });

  it("reports an EOF without a completion marker and never repeats already emitted text", async () => {
    mocks.transport.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n'));
    const stream = callLLMStream([{ role: "user", content: "问题" }]);
    await expect(stream.next()).resolves.toMatchObject({ value: "未完成", done: false });
    await expect(stream.next()).rejects.toThrow("流式连接提前结束");
    expect(mocks.transport).toHaveBeenCalledTimes(1);
  });

  it("does not treat a token-limit finish followed by DONE as a complete answer", async () => {
    mocks.transport.mockResolvedValue(new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'));
    await expect(callLLMStream([{ role: "user", content: "问题" }]).next()).rejects.toThrow("未完成（length）");
  });

  it.each(["consumer", "done"])("cancels an unfinished response when completion comes from %s", async (completion) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"回答"}}]}\n\n'
          + (completion === "done" ? 'data: [DONE]\n\n' : '')));
      },
      cancel,
    });
    mocks.transport.mockResolvedValue(new Response(body));
    const stream = callLLMStream([{ role: "user", content: "问题" }]);
    await stream.next();
    if (completion === "consumer") await stream.return();
    else await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("prioritizes caller cancellation over a buffered DONE and releases the response", async () => {
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    mocks.transport.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n'));
    const stream = callLLMStream([{ role: "user", content: "问题" }], { abortSignal: controller.signal });
    await stream.next();
    controller.abort(reason);
    await expect(stream.next()).rejects.toBe(reason);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
  });

  it("does not start a request when the caller already cancelled", async () => {
    const reason = new DOMException("user cancelled", "AbortError");
    await expect(callLLMStream([{ role: "user", content: "问题" }], { abortSignal: AbortSignal.abort(reason) }).next()).rejects.toBe(reason);
    expect(mocks.transport).not.toHaveBeenCalled();
  });
});
