import { describe, expect, it } from "vitest";
import {
  createFifoConcurrencyLimiter,
  estimateCourseGenerationTokens,
  isCourseGenerationLlmContext,
  reportCourseGenerationTokenUsage,
  runWithCourseGenerationLlmContext,
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
    await runWithCourseGenerationLlmContext(async () => {
      await reportCourseGenerationTokenUsage(1_240, 10_000);
      await reportCourseGenerationTokenUsage(undefined, 250);
    }, { onTokenUsage: (total) => { totals.push(total); } });

    expect(totals).toEqual([1_240, 100]);
    expect(estimateCourseGenerationTokens(0)).toBe(0);
  });
});
