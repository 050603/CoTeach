// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@openmaic/lib/server/proxy-fetch", () => ({ proxyFetch: mocks.transport }));
vi.mock("./settings", () => ({ getActiveAiSettings: async () => ({
  endpoint: "https://course-provider.invalid/v1", apiKey: "private-key", model: "unchanged-course-model",
  proxy: "http://managed-proxy.invalid:8080",
}) }));
import { runWithCourseGenerationLlmContext } from "@/lib/course-generation/llm-concurrency";

const messages = [{ role: "user" as const, content: "Full authoritative source and course positioning requirements" }];
const draft = '  {"grade":"初中","learningObjectives":["解释核心概念"]}\n';
function response(finishReason: unknown = "stop", usage: unknown = { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 }) {
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content: draft } }], usage });
}
beforeEach(() => { vi.resetModules(); mocks.transport.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("legacy course authoring completeness and accounting boundary", () => {
  it.each(["length", "content_filter", "tool_calls", "error", null, undefined])(
    "stops a parseable first draft with finish_reason=%s without reauthoring", async (finishReason) => {
      const { callLLM } = await import("./client");
      mocks.transport.mockResolvedValue(Response.json({ choices: [{ finish_reason: finishReason, message: { content: draft } }],
        usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } }));
      const onCallUsage = vi.fn(), onTokenUsage = vi.fn();
      const failure = await runWithCourseGenerationLlmContext(() => callLLM(messages, { jsonMode: true, maxTransientRetries: 9 }),
        { onCallUsage, onTokenUsage }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "LLM_STREAM_INCOMPLETE", complete: false, isRetryable: false, rawResponse: draft });
      expect(Object.getOwnPropertyDescriptor(failure, "rawResponse")?.enumerable).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(draft);
      expect(mocks.transport).toHaveBeenCalledOnce();
      expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        source: "legacy-course-authoring", modelId: "unchanged-course-model", outcome: "failed",
        totalTokens: 1000, usageSource: "provider", attempt: 1, transportRetry: false,
      }));
      expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(1000, "provider");
    });

  it("preserves the normal generic completion interface even without a finish marker", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(Response.json({ choices: [{ message: { content: draft } }] }));
    await expect(callLLM(messages)).resolves.toBe(draft);
    expect(mocks.transport).toHaveBeenCalledOnce();
  });

  it("records provider input/output/cache/reasoning with subsets excluded from the aggregate", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(response("stop", { prompt_tokens: 600, completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 200 } }));
    const onCallUsage = vi.fn(), onTokenUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages), { onCallUsage, onTokenUsage })).resolves.toBe(draft);
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      totalTokens: 1000, inputTokens: 600, outputTokens: 400, cacheReadTokens: 300, cacheWriteTokens: 50,
      reasoningTokens: 200, usageSource: "provider", outcome: "response",
    }));
    expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(1000, "provider");
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body)).toEqual({ model: "unchanged-course-model", messages, temperature: 0.5 });
  });

  it("retains exact DeepSeek cache-hit and reasoning counts while preserving a provider zero total", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(response("stop", { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12, completion_tokens_details: { reasoning_tokens: 0 } }));
    const onCallUsage = vi.fn(), onTokenUsage = vi.fn();
    await runWithCourseGenerationLlmContext(() => callLLM(messages), { onCallUsage, onTokenUsage });
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, usageSource: "provider",
    }));
    expect(onCallUsage.mock.calls[0][0].cacheWriteTokens).toBeUndefined();
    expect(onTokenUsage).not.toHaveBeenCalled();
  });

  it("preserves a completed draft when usage storage fails and never retries the network request", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(response());
    const onCallUsage = vi.fn(() => { throw Object.assign(new Error("ledger storage unavailable"), { statusCode: 503 }); });
    const onTokenUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), {
      onCallUsage, onTokenUsage,
    })).rejects.toMatchObject({ code: "COURSE_TOKEN_USAGE_PERSISTENCE_FAILED", rawResponse: draft, complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledOnce();
    expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(1000, "provider");
  });

  it("keeps malformed response bytes and records the failed provider attempt", async () => {
    const { callLLM } = await import("./client");
    const raw = '{"choices":[{"message":{"content":"partial';
    mocks.transport.mockResolvedValue(new Response(raw));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ rawResponse: raw, complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome: "failed", usageSource: "estimated", totalTokens: Math.ceil((messages[0].content.length + raw.length) / 2.5),
    }));
  });

  it.each([200, 503])("never accepts or replays complete-looking JSON before an interrupted HTTP %s body", async (status) => {
    const { callLLM } = await import("./client");
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: draft } }],
          usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 },
        })));
      } else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    } });
    mocks.transport.mockResolvedValue(new Response(body, { status }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ code: "LLM_STREAM_TRUNCATED", rawResponse: draft, complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", totalTokens: 1000, usageSource: "provider" }));
  });

  it.each([500, 502, 504])("records HTTP %s without retrying an unknown provider state", async (status) => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(new Response("upstream failed", { status }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ status, complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", usageSource: "estimated" }));
  });

  it("records a failed fetch with its prompt estimate and keeps it terminal", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome: "failed", totalTokens: Math.ceil(messages[0].content.length / 2.5), usageSource: "estimated",
    }));
  });

  it("allows one explicit 503 refusal retry and assigns separate ledger identities", async () => {
    vi.useFakeTimers();
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValueOnce(new Response("overloaded", { status: 503 })).mockResolvedValueOnce(response());
    const onCallUsage = vi.fn();
    const assertion = expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .resolves.toBe(draft);
    await vi.runAllTimersAsync(); await assertion;
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    const calls = onCallUsage.mock.calls.map(([usage]) => usage);
    expect(calls).toMatchObject([{ outcome: "failed", totalTokens: 0, attempt: 1, transportRetry: false },
      { outcome: "response", totalTokens: 1000, attempt: 2, transportRetry: true }]);
    expect(calls[0].callId).not.toBe(calls[1].callId);
  });

  it("does not stack a second transport retry after two explicit provider refusals", async () => {
    vi.useFakeTimers();
    const { callLLM } = await import("./client");
    mocks.transport.mockImplementation(async () => new Response("overloaded", { status: 503 }));
    const onCallUsage = vi.fn();
    const assertion = expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ status: 503, complete: false });
    await vi.runAllTimersAsync(); await assertion;
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(onCallUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps the seed's explicit zero transport allowance even on 429", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 0 }), { onCallUsage }))
      .rejects.toMatchObject({ status: 429, complete: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", totalTokens: 0 }));
  });

  it("retains model content and actual usage returned with an HTTP 503 instead of replaying it", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(Response.json({ choices: [{ message: { content: draft } }],
      usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } }, { status: 503 }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ status: 503, rawResponse: draft, complete: false, isRetryable: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", totalTokens: 1000, usageSource: "provider" }));
  });

  it("keeps provider-reported refusal costs instead of replacing them with an assumed zero", async () => {
    const { callLLM } = await import("./client");
    mocks.transport.mockResolvedValue(Response.json({ usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 } }, { status: 503 }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 0 }), { onCallUsage }))
      .rejects.toMatchObject({ status: 503, complete: false });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", totalTokens: 20, usageSource: "provider" }));
  });

  it("retains reasoning-only output on an HTTP failure and stops its transport retry", async () => {
    const { callLLM } = await import("./client");
    const payload = { choices: [{ message: { reasoning_content: "Partial reasoning already produced" } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } } };
    mocks.transport.mockResolvedValue(Response.json(payload, { status: 503 }));
    const onCallUsage = vi.fn();
    await expect(runWithCourseGenerationLlmContext(() => callLLM(messages, { maxTransientRetries: 9 }), { onCallUsage }))
      .rejects.toMatchObject({ rawResponse: JSON.stringify(payload), complete: false, isRetryable: false, outputStarted: true });
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect(onCallUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "failed", totalTokens: 30, reasoningTokens: 10 }));
  });
});
