import { describe, expect, it, vi } from "vitest";
import {
  createFifoConcurrencyLimiter,
  estimateCourseGenerationTokens,
  isCourseGenerationLlmContext,
  reportCourseGenerationTokenUsage,
  runWithCourseGenerationLlmContext,
  runWithCourseGenerationLlmCallContext,
} from "./llm-concurrency";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("course-generation LLM concurrency", () => {
  it("never runs more callbacks than the configured limit and releases slots after errors", async () => {
    const limiter = createFifoConcurrencyLimiter(3);
    const gates = Array.from({ length: 6 }, () => deferred());
    let active = 0;
    let maxActive = 0;

    const tasks = gates.map((gate, index) => limiter.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      if (index === 1) throw new Error("expected failure");
      return index;
    }));

    await Promise.resolve();
    expect(maxActive).toBe(3);
    gates[0]!.resolve();
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(3);
    gates.slice(3).forEach((gate) => gate.resolve());

    const results = await Promise.allSettled(tasks);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 3 });
  });

  it("marks only nested background work as course generation", async () => {
    expect(isCourseGenerationLlmContext()).toBe(false);
    await runWithCourseGenerationLlmContext(async () => {
      expect(isCourseGenerationLlmContext()).toBe(true);
      await Promise.resolve();
      expect(isCourseGenerationLlmContext()).toBe(true);
    });
    expect(isCourseGenerationLlmContext()).toBe(false);
  });

  it("reports provider usage and falls back to a lightweight character estimate", async () => {
    const totals: number[] = [];
    const sources: string[] = [];
    await runWithCourseGenerationLlmContext(async () => {
      await reportCourseGenerationTokenUsage(1_240, 10_000);
      await reportCourseGenerationTokenUsage(undefined, 250);
    }, { onTokenUsage: (total, source) => {
      totals.push(total);
      sources.push(source);
    } });

    expect(totals).toEqual([1_240, 100]);
    expect(sources).toEqual(["provider", "estimated"]);
    expect(estimateCourseGenerationTokens(0)).toBe(0);
  });

  it("records input/output and cache/reasoning subsets without counting them twice", async () => {
    const onCallUsage = vi.fn();
    const onTokenUsage = vi.fn();
    await runWithCourseGenerationLlmContext(() => runWithCourseGenerationLlmCallContext(async () => {
      await reportCourseGenerationTokenUsage(700, 100_000, {
        inputTokens: 500, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 70,
      });
      await reportCourseGenerationTokenUsage(undefined, 100_000, {
        inputTokens: 500, outputTokens: 200, reasoningTokens: 70, outcome: "failed",
      });
    }, { callId: "page-call", source: "slide-content", attempt: 2, transportRetry: true }), {
      onCallUsage, onTokenUsage,
    });
    expect(onTokenUsage.mock.calls.map(([tokens]) => tokens)).toEqual([700, 700]);
    expect(onCallUsage).toHaveBeenCalledWith(expect.objectContaining({
      callId: "page-call", source: "slide-content", attempt: 2, transportRetry: true,
      totalTokens: 700, inputTokens: 500, outputTokens: 200, cacheReadTokens: 300,
      cacheWriteTokens: 20, reasoningTokens: 70, usageSource: "provider", outcome: "response",
    }));
    expect(onCallUsage.mock.calls[1]![0].outcome).toBe("failed");
  });

  it("preserves zero-token refusals in the call ledger and marks estimates honestly", async () => {
    const onCallUsage = vi.fn();
    const onTokenUsage = vi.fn();
    await runWithCourseGenerationLlmContext(async () => {
      await reportCourseGenerationTokenUsage(0, 500, {
        source: "knowledge-structure", outcome: "failed", inputTokens: 0, outputTokens: 0, usageSource: "estimated",
      });
      await reportCourseGenerationTokenUsage(undefined, 500, {
        inputCharacters: 250, outputCharacters: 125, reasoningCharacters: 125,
      });
    }, { onCallUsage, onTokenUsage });
    expect(onCallUsage.mock.calls[0]![0]).toMatchObject({ totalTokens: 0, usageSource: "estimated", outcome: "failed" });
    expect(onCallUsage.mock.calls[1]![0]).toMatchObject({
      totalTokens: 200, inputTokens: 100, outputTokens: 100, reasoningTokens: 50, usageSource: "estimated",
    });
    expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(200, "estimated");
  });

  it("keeps aggregate accounting on ledger failure and makes storage failures terminal", async () => {
    const onTokenUsage = vi.fn();
    const cause = Object.assign(new Error("database unavailable"), { statusCode: 503 });
    await expect(runWithCourseGenerationLlmContext(() => reportCourseGenerationTokenUsage(100), {
      onCallUsage: () => { throw cause; }, onTokenUsage,
    })).rejects.toMatchObject({
      code: "COURSE_TOKEN_USAGE_PERSISTENCE_FAILED", isRetryable: false, cause,
    });
    expect(onTokenUsage).toHaveBeenCalledExactlyOnceWith(100, "provider");
  });
});
