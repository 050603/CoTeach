import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LAB_SECTION_FIXTURES } from "./fixtures";
import { LAB_TECHNICAL_POLICY } from "./technical-policy";
import { readExperimentArmMetrics, type ExperimentState } from "./experiment-report";
import {
  buildExperimentState,
  parseExperimentRunnerOptions,
  runExperiment,
  type ExperimentRunnerOptions,
} from "./experiment-runner";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

function options(runtimeRoot: string, overrides: Partial<ExperimentRunnerOptions> = {}): ExperimentRunnerOptions {
  return {
    runtimeRoot,
    experimentId: "v4-v5-fixture-test",
    modelString: "provider:frozen-model",
    reasoning: "high",
    tts: {
      provider: "frozen-tts",
      model: "tts-model",
      voice: "teacher-voice",
      language: "zh-CN",
      speed: 1,
    },
    dryRun: false,
    resume: false,
    ...overrides,
  };
}

const frozenCode: ExperimentState["freeze"]["code"] = {
  commit: "0123456789abcdef",
  dirty: false,
  worktreeSha256: "frozen-worktree",
};

describe("V4/V5 experiment runner", () => {
  it("builds the fixed alternating six-arm schedule with isolated audio scopes", () => {
    const state = buildExperimentState(options("/tmp/runtime"), frozenCode, "2026-09-18T00:00:00.000Z");
    expect(state.runs.map((run) => `${run.sectionId}/${run.pipeline}/${run.variant}`)).toEqual([
      `${LAB_SECTION_FIXTURES[0].id}/v4/baseline`,
      `${LAB_SECTION_FIXTURES[0].id}/v5/enhanced`,
      `${LAB_SECTION_FIXTURES[1].id}/v5/enhanced`,
      `${LAB_SECTION_FIXTURES[1].id}/v4/baseline`,
      `${LAB_SECTION_FIXTURES[2].id}/v4/baseline`,
      `${LAB_SECTION_FIXTURES[2].id}/v5/enhanced`,
    ]);
    expect(new Set(state.runs.map((run) => run.runId))).toHaveLength(6);
    expect(new Set(state.runs.map((run) => run.audioCacheScope))).toHaveLength(6);
    expect(state.freeze.generationPolicy).toEqual(LAB_TECHNICAL_POLICY);
    expect(state.runs.every((run) => run.command.includes("--fresh")
      && run.command.includes("--concurrency")
      && run.command.includes("1"))).toBe(true);
  });

  it("runs fixture metrics sequentially and writes an aggregate quality report", async () => {
    const runtimeRoot = await temporaryDirectory("quality-lab-experiment-");
    const fixtureMetricsDir = await temporaryDirectory("quality-lab-metrics-");
    for (const fixture of LAB_SECTION_FIXTURES) {
      for (const pipeline of ["v4", "v5"] as const) {
        await fs.writeFile(path.join(fixtureMetricsDir, `${fixture.id}.${pipeline}.json`), JSON.stringify({
          quality: { passed: true, reasons: [] },
          cost: {
            tokenUsage: pipeline === "v4" ? 100_000 : 75_000,
            tokenUsageSource: "provider-reported",
          },
          timing: { endToEndMs: pipeline === "v4" ? 1_000_000 : 700_000 },
          calls: { logical: pipeline === "v4" ? 14 : 9, transportAttempts: 9 },
          audio: { calls: 8, cacheHits: 0, durationSec: 180 },
        }));
      }
    }
    const execute = vi.fn(async () => 0);
    let tick = 0;
    const result = await runExperiment(options(runtimeRoot, { fixtureMetricsDir }), {
      captureCodeIdentity: async () => frozenCode,
      execute,
      now: () => new Date(Date.UTC(2026, 8, 18, 0, 0, tick++)),
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.state.status).toBe("complete");
    expect(result.state.runs.every((run) => run.status === "complete")).toBe(true);
    const report = await fs.readFile(result.reportPath!, "utf8");
    expect(report).toContain("V5 满足自动优化候选门槛");
    expect(report).toContain("-25.0%");
    expect(report).toContain("教师听感由 3010 人工评判单独记录");
  });

  it("stops after a failed arm and resumes it without fresh while retaining completed arms", async () => {
    const runtimeRoot = await temporaryDirectory("quality-lab-resume-");
    let calls = 0;
    const firstExecute = vi.fn(async () => (++calls === 3 ? 7 : 0));
    const deps = {
      captureCodeIdentity: async () => frozenCode,
      execute: firstExecute,
      now: () => new Date(),
    };
    const first = await runExperiment(options(runtimeRoot), deps);
    expect(first.state.status).toBe("failed");
    expect(first.state.runs.map((run) => run.status)).toEqual([
      "complete", "complete", "failed", "planned", "planned", "planned",
    ]);

    const resumedCommands: string[][] = [];
    const resumed = await runExperiment(options(runtimeRoot, { resume: true }), {
      ...deps,
      execute: async (command, args) => { resumedCommands.push([command, ...args]); return 0; },
    });
    expect(resumed.state.status).toBe("complete");
    expect(resumedCommands).toHaveLength(4);
    expect(resumedCommands[0]).not.toContain("--fresh");
    expect(resumedCommands.slice(1).every((command) => command.includes("--fresh"))).toBe(true);
    expect(resumed.state.runs[0].attempts).toHaveLength(1);
    expect(resumed.state.runs[2].attempts).toHaveLength(2);
  });

  it("requires all frozen provider settings at the CLI boundary", () => {
    expect(() => parseExperimentRunnerOptions(["--model", "m"])).toThrow(/--reasoning/);
    const parsed = parseExperimentRunnerOptions([
      "--experiment-id", "candidate-v5",
      "--model", "provider:model",
      "--reasoning", "high",
      "--tts-provider", "tts-provider",
      "--tts-model", "tts-model",
      "--tts-voice", "voice",
      "--dry-run",
    ]);
    expect(parsed).toMatchObject({ experimentId: "candidate-v5", dryRun: true });
  });

  it("keeps legacy token provenance unknown and aggregates explicit mixed sources", async () => {
    const runtimeRoot = await temporaryDirectory("quality-lab-token-source-");
    const state = buildExperimentState(options(runtimeRoot), frozenCode, "2026-09-18T00:00:00.000Z");
    const run = state.runs[0];
    const runDir = path.join(runtimeRoot, run.runDirectory);
    const designDir = path.join(
      runtimeRoot,
      "designs",
      state.experimentId,
      run.sectionId,
      "1",
      run.pipeline,
    );
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(designDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify({
      result: {
        statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
        durationSec: 180,
      },
    }));
    await fs.writeFile(path.join(runDir, "calls.json"), JSON.stringify([
      { status: "complete", tokenUsage: 100, systemChars: 25, userChars: 25, outputChars: 25 },
    ]));
    const legacy = await readExperimentArmMetrics(runtimeRoot, run);
    expect(legacy).toMatchObject({ tokenUsage: 100, tokenUsageSource: "unknown" });

    await fs.writeFile(path.join(runDir, "calls.json"), JSON.stringify([
      { status: "complete", tokenUsage: 100, tokenUsageSource: "estimated" },
    ]));
    await fs.writeFile(path.join(designDir, "calls.json"), JSON.stringify([
      { status: "complete", tokenUsage: 50, tokenUsageSource: "provider" },
    ]));
    const current = await readExperimentArmMetrics(runtimeRoot, run);
    expect(current).toMatchObject({ tokenUsage: 150, tokenUsageSource: "mixed" });
  });

  it("counts recovery gaps and every attempt in end-to-end wall clock time", async () => {
    const runtimeRoot = await temporaryDirectory("quality-lab-wall-clock-");
    const state = buildExperimentState(options(runtimeRoot), frozenCode, "2026-09-18T00:00:00.000Z");
    const run = state.runs[0];
    run.attempts = [
      {
        startedAt: "2026-09-18T00:00:00.000Z",
        completedAt: "2026-09-18T00:01:00.000Z",
        elapsedMs: 60_000,
        fresh: true,
        exitCode: 1,
      },
      {
        startedAt: "2026-09-18T00:02:00.000Z",
        completedAt: "2026-09-18T00:04:00.000Z",
        elapsedMs: 120_000,
        fresh: false,
        exitCode: 0,
      },
    ];
    const runDir = path.join(runtimeRoot, run.runDirectory);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "result.json"), JSON.stringify({
      result: {
        statuses: { ppt: { state: "complete" }, script: { state: "complete" }, tts: { state: "complete" } },
        durationSec: 180,
      },
    }));
    expect(await readExperimentArmMetrics(runtimeRoot, run)).toMatchObject({ endToEndMs: 240_000 });
  });
});
