import type { CourseGenerationCallUsage } from "./llm-concurrency";

export type FirstPassBillingRates = {
  currency: string;
  source: string;
  effectiveAt: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type FirstPassCostRun = {
  sampleId: string;
  arm: "baseline" | "new";
  repetition: number;
  mode: "end-to-end" | "frozen-stages";
  stage: "knowledge" | "duration" | "outline" | "pages" | "all";
  status: "planned" | "running" | "complete" | "failed";
  qualityPassed: boolean;
  scopeCompleteness?: "authoring-only" | "full-course";
  stageResults: Array<{ stage: string; passed: boolean; firstPass: boolean; issues: string[] }>;
  usage: CourseGenerationCallUsage[];
};

/** Lossless legacy-input projection: each long original passage has one value. */
export function buildFirstPassSourceCatalog(value: unknown): {
  sourceTexts: Record<string, string>; sources: unknown;
} {
  const sourceTexts: Record<string, string> = {};
  const ids = new Map<string, string>();
  const project = (item: unknown): unknown => {
    if (typeof item === "string" && item.length >= 100) {
      let id = ids.get(item);
      if (!id) { id = `original-text-${ids.size + 1}`; ids.set(item, id); sourceTexts[id] = item; }
      return { sourceTextRef: id };
    }
    if (Array.isArray(item)) return item.map(project);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, content]) => [key, project(content)]));
    return item;
  };
  return { sourceTexts, sources: project(value) };
}

export function expandFirstPassSourceCatalog(catalog: ReturnType<typeof buildFirstPassSourceCatalog>): unknown {
  const expand = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(expand);
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record.sourceTextRef === "string"
        && catalog.sourceTexts[record.sourceTextRef] !== undefined) return catalog.sourceTexts[record.sourceTextRef];
      return Object.fromEntries(Object.entries(record).map(([key, content]) => [key, expand(content)]));
    }
    return item;
  };
  return expand(catalog.sources);
}

/** Output includes reasoning; input includes cache. Price their subsets once. */
export function priceFirstPassCall(
  usage: CourseGenerationCallUsage,
  rates?: FirstPassBillingRates,
): number | null {
  if (!rates || !rates.source || !rates.effectiveAt || usage.usageSource !== "provider"
    || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const values = [rates.inputPerMillion, rates.outputPerMillion,
    rates.cacheReadPerMillion ?? rates.inputPerMillion,
    rates.cacheWritePerMillion ?? rates.inputPerMillion];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  if ((rates.cacheReadPerMillion !== undefined && usage.cacheReadTokens === undefined)
    || (rates.cacheWritePerMillion !== undefined && usage.cacheWriteTokens === undefined)) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (cacheRead + cacheWrite > usage.inputTokens) return null;
  return ((usage.inputTokens - cacheRead - cacheWrite) * rates.inputPerMillion
    + cacheRead * (rates.cacheReadPerMillion ?? rates.inputPerMillion)
    + cacheWrite * (rates.cacheWritePerMillion ?? rates.inputPerMillion)
    + usage.outputTokens * rates.outputPerMillion) / 1_000_000;
}

export function summarizeFirstPassCostRuns(
  runs: readonly FirstPassCostRun[],
  rates?: FirstPassBillingRates,
  repetitions = 3,
) {
  const sampleIds = [...new Set(runs.map((run) => run.sampleId))];
  const summarize = (group: FirstPassCostRun[]) => {
    const finished = group.filter((run) => run.status === "complete" || run.status === "failed");
    const usage = finished.flatMap((run) => run.usage);
    const stages = finished.flatMap((run) => run.stageResults);
    // Zero-work and partial-stage probes cannot be low-cost course successes.
    const full = finished.filter((run) => run.stage === "all" && run.mode === "end-to-end");
    const priced = full.flatMap((run) => run.usage).map((call) => priceFirstPassCall(call, rates));
    const fullSuccesses = full.filter((run) => run.status === "complete" && run.qualityPassed
      && run.scopeCompleteness !== "authoring-only"
      && run.stageResults.length >= 4 && run.stageResults.every((stage) => stage.passed && stage.firstPass));
    return {
      finishedRuns: finished.length,
      failedRuns: finished.filter((run) => run.status === "failed").length,
      fullCourseRuns: full.length,
      probeRuns: finished.length - full.length,
      fullCourseFirstPassRate: full.length ? fullSuccesses.length / full.length : null,
      stageFirstPassRate: stages.length ? stages.filter((stage) => stage.passed && stage.firstPass).length / stages.length : null,
      providerCalls: usage.length,
      totalTokens: usage.reduce((sum, call) => sum + call.totalTokens, 0),
      meanTokens: finished.length ? usage.reduce((sum, call) => sum + call.totalTokens, 0) / finished.length : null,
      usageSource: usage.length === 0 ? "unknown" : usage.every((call) => call.usageSource === "provider") ? "provider" : "mixed-or-estimated",
      meanCost: full.length && priced.length > 0 && priced.every((price) => price !== null)
        ? priced.reduce((sum, price) => sum + (price ?? 0), 0) / full.length : null,
      qualityPassed: full.length === repetitions && fullSuccesses.length === repetitions,
    };
  };
  const samples = sampleIds.map((sampleId) => {
    const sample = runs.filter((run) => run.sampleId === sampleId);
    const baseline = summarize(sample.filter((run) => run.arm === "baseline"));
    const current = summarize(sample.filter((run) => run.arm === "new"));
    const comparable = baseline.fullCourseRuns === repetitions && current.fullCourseRuns === repetitions
      && sample.filter((run) => run.stage === "all" && run.mode === "end-to-end")
        .every((run) => run.scopeCompleteness !== "authoring-only")
      && baseline.meanCost !== null && baseline.meanCost > 0 && current.meanCost !== null;
    const ratio = comparable ? current.meanCost! / baseline.meanCost! : null;
    return { sampleId, baseline, new: current, verifiedCostRatio: ratio,
      acceptance: !comparable ? "unverified" : current.qualityPassed
        && current.fullCourseFirstPassRate! >= baseline.fullCourseFirstPassRate! && ratio! <= 1.2 ? "passed" : "failed" };
  });
  return { currency: rates?.currency ?? null, billingRatesSource: rates?.source ?? null,
    repetitions, samples, acceptance: samples.length === 3 && samples.every((sample) => sample.acceptance === "passed") ? "passed" : "unverified" };
}
