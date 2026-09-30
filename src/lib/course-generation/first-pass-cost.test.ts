import { describe, expect, it } from "vitest";
import { buildFirstPassSourceCatalog, expandFirstPassSourceCatalog, priceFirstPassCall, summarizeFirstPassCostRuns, type FirstPassCostRun } from "./first-pass-cost";
import type { CourseGenerationCallUsage } from "./llm-concurrency";

const usage: CourseGenerationCallUsage = {
  callId: "call", source: "planning", attempt: 1, transportRetry: false, outcome: "response", usageSource: "provider",
  totalTokens: 1_000_000, inputTokens: 600_000, outputTokens: 400_000,
  cacheReadTokens: 300_000, cacheWriteTokens: 0, reasoningTokens: 200_000,
};
const rates = { currency: "CNY", source: "captured-provider-invoice", effectiveAt: "2026-09-30", inputPerMillion: 2,
  outputPerMillion: 4, cacheReadPerMillion: 0.5 };

function run(arm: "baseline" | "new", repetition: number, overrides: Partial<FirstPassCostRun> = {}): FirstPassCostRun {
  return { sampleId: "sample", arm, repetition, mode: "end-to-end", stage: "all", status: "complete", qualityPassed: true,
    stageResults: ["knowledge", "duration", "outline", "pages"].map((stage) => ({ stage, passed: true, firstPass: true, issues: [] })),
    usage: [{ ...usage, totalTokens: arm === "baseline" ? 1_000_000 : 1_100_000,
      inputTokens: arm === "baseline" ? 600_000 : 660_000, outputTokens: arm === "baseline" ? 400_000 : 440_000 }], ...overrides };
}

describe("first-pass cost acceptance", () => {
  it("preserves complete original passages and each source identity through legacy references", () => {
    const original = "教材必要条件、分支、案例及末尾不得删除。".repeat(30);
    const sources = { revision: "original-v2", stages: [{ outputs: "", durationMin: 30 }],
      documents: [{ id: "doc", content: original }], evidence: [
        { id: "source-a", content: original, source: { page: 4, version: 2 } },
        { id: "source-b", content: original, source: { page: 9, version: 5 } },
      ] };
    const catalog = buildFirstPassSourceCatalog(sources);
    expect(Object.values(catalog.sourceTexts)).toEqual([original]);
    expect(expandFirstPassSourceCatalog(catalog)).toEqual(sources);
    expect(JSON.stringify(catalog)).not.toContain('"outputs":"新造的成果"');
  });
  it("prices cache and reasoning without charging their parent token count again", () => {
    expect(priceFirstPassCall(usage, rates)).toBeCloseTo(2.35);
    expect(priceFirstPassCall({ ...usage, reasoningTokens: 399_000 }, rates)).toBeCloseTo(2.35);
  });
  it("cannot verify cost without rates or complete provider usage", () => {
    expect(priceFirstPassCall(usage)).toBeNull();
    expect(priceFirstPassCall({ ...usage, usageSource: "estimated" }, rates)).toBeNull();
    expect(priceFirstPassCall({ ...usage, cacheReadTokens: undefined }, rates)).toBeNull();
    expect(priceFirstPassCall({ ...usage, inputTokens: undefined }, rates)).toBeNull();
  });
  it("includes failed attempts and cannot count half a course as a cheap success", () => {
    const runs = [1, 2, 3].flatMap((repetition) => [run("baseline", repetition), run("new", repetition)]);
    runs[5] = run("new", 3, { status: "failed", qualityPassed: false,
      stageResults: [{ stage: "knowledge", passed: false, firstPass: false, issues: ["missing source"] }], usage: [usage, usage] });
    const report = summarizeFirstPassCostRuns(runs, rates);
    expect(report.samples[0]!.new.failedRuns).toBe(1);
    expect(report.samples[0]!.new.providerCalls).toBe(4);
    expect(report.samples[0]!.new.fullCourseFirstPassRate).toBeCloseTo(2 / 3);
    expect(report.samples[0]!.acceptance).toBe("failed");
    expect(summarizeFirstPassCostRuns(runs).samples[0]!.verifiedCostRatio).toBeNull();
    const probes = runs.map((entry) => ({ ...entry, stage: "knowledge" as const }));
    expect(summarizeFirstPassCostRuns(probes, rates).samples[0]!.verifiedCostRatio).toBeNull();
  });
  it("does not certify a completed authoring run when original media assets remain missing", () => {
    const runs = [1, 2, 3].flatMap((repetition) => [run("baseline", repetition),
      run("new", repetition, { scopeCompleteness: "authoring-only" })]);
    const report = summarizeFirstPassCostRuns(runs, rates).samples[0]!;
    expect(report.new.qualityPassed).toBe(false);
    expect(report.new.fullCourseFirstPassRate).toBe(0);
    expect(report.verifiedCostRatio).toBeNull();
    expect(report.acceptance).toBe("unverified");
  });
});
