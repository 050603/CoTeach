import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LAB_SECTION_FIXTURES } from "./fixtures";
import {
  type ExperimentPipeline,
  type ExperimentRunRecord,
  type ExperimentState,
  writeExperimentReport,
} from "./experiment-report";

const DEFAULT_RUNTIME_ROOT = path.resolve(
  process.env.COURSE_QUALITY_LAB_ROOT ?? ".openpbl-runtime/course-quality-lab",
);
const RUNNER_LOCK = ".experiment-runner.lock";

export interface ExperimentRunnerOptions {
  runtimeRoot: string;
  experimentId: string;
  modelString: string;
  reasoning: string;
  tts: { provider: string; model: string; voice: string; language: string; speed: number };
  dryRun: boolean;
  resume: boolean;
  fixtureMetricsDir?: string;
}

interface RunnerDependencies {
  now: () => Date;
  captureCodeIdentity: () => Promise<ExperimentState["freeze"]["code"]>;
  execute: (command: string, args: string[]) => Promise<number>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
  });
}

export async function captureCodeIdentity(): Promise<ExperimentState["freeze"]["code"]> {
  const [commit, diff, untrackedText] = await Promise.all([
    runCapture("git", ["rev-parse", "HEAD"]),
    runCapture("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."]),
    runCapture("git", ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const untracked = untrackedText.split("\n").filter(Boolean).sort();
  const untrackedFingerprints = await Promise.all(untracked.map(async (file) => {
    const content = await fs.readFile(file);
    return `${file}\0${createHash("sha256").update(content).digest("hex")}`;
  }));
  const worktree = `${diff}\n${untrackedFingerprints.join("\n")}`;
  return { commit: commit.trim(), dirty: Boolean(diff || untracked.length), worktreeSha256: sha256(worktree) };
}

function defaultExecute(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function atomicWriteJson(file: string, value: unknown): Promise<void> {
  return fs.mkdir(path.dirname(file), { recursive: true }).then(async () => {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, file);
  });
}

function statePath(runtimeRoot: string, experimentId: string): string {
  return path.join(runtimeRoot, "experiments", experimentId, "experiment.json");
}

function generatorArgs(
  experimentId: string,
  sectionId: string,
  pipeline: ExperimentPipeline,
  variant: ExperimentRunRecord["variant"],
  audioCacheScope: string,
  modelString: string,
  reasoning: string,
  tts: ExperimentRunnerOptions["tts"],
  fresh: boolean,
): string[] {
  return [
    "quality-lab:generate",
    "--",
    "--pipeline", pipeline,
    "--variant", variant,
    "--experiment-id", experimentId,
    "--section", sectionId,
    "--batch", "1",
    "--audio-cache-scope", audioCacheScope,
    "--concurrency", "1",
    "--model", modelString,
    "--reasoning", reasoning,
    "--tts-provider", tts.provider,
    "--tts-model", tts.model,
    "--tts-voice", tts.voice,
    "--tts-language", tts.language,
    "--tts-speed", String(tts.speed),
    ...(fresh ? ["--fresh"] : []),
  ];
}

export function buildExperimentState(
  options: ExperimentRunnerOptions,
  code: ExperimentState["freeze"]["code"],
  createdAt: string,
): ExperimentState {
  const order: Array<{ fixtureIndex: number; pipeline: ExperimentPipeline }> = [
    { fixtureIndex: 0, pipeline: "v4" },
    { fixtureIndex: 0, pipeline: "v5" },
    { fixtureIndex: 1, pipeline: "v5" },
    { fixtureIndex: 1, pipeline: "v4" },
    { fixtureIndex: 2, pipeline: "v4" },
    { fixtureIndex: 2, pipeline: "v5" },
  ];
  const runs = order.map(({ fixtureIndex, pipeline }, index): ExperimentRunRecord => {
    const fixture = LAB_SECTION_FIXTURES[fixtureIndex];
    const variant = pipeline === "v4" ? "baseline" : "enhanced";
    const audioCacheScope = `${options.experimentId}/${fixture.id}/${pipeline}`;
    return {
      sequence: index + 1,
      runId: `${options.experimentId}-${String(index + 1).padStart(2, "0")}-${fixture.id}-${pipeline}`,
      sectionId: fixture.id,
      title: fixture.title,
      pipeline,
      variant,
      audioCacheScope,
      runDirectory: path.posix.join("runs", options.experimentId, fixture.id, "1", variant),
      status: "planned",
      command: ["pnpm", ...generatorArgs(
        options.experimentId,
        fixture.id,
        pipeline,
        variant,
        audioCacheScope,
        options.modelString,
        options.reasoning,
        options.tts,
        true,
      )],
      attempts: [],
    };
  });
  return {
    version: 1,
    experimentId: options.experimentId,
    createdAt,
    updatedAt: createdAt,
    status: "planned",
    dryRun: options.dryRun,
    freeze: {
      fixtureSha256: sha256(JSON.stringify(LAB_SECTION_FIXTURES)),
      code,
      model: { modelString: options.modelString, reasoning: options.reasoning },
      tts: options.tts,
    },
    runs,
  };
}

async function readState(file: string): Promise<ExperimentState | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as ExperimentState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function acquireLock(runtimeRoot: string): Promise<() => Promise<void>> {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const lockPath = path.join(runtimeRoot, RUNNER_LOCK);
  const create = async () => {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.close();
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number((await fs.readFile(lockPath, "utf8").catch(() => "")).trim());
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) {
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    if (alive) throw new Error(`另一个 V4/V5 实验仍在运行（PID ${pid}）`);
    await fs.unlink(lockPath).catch(() => undefined);
    await create();
  }
  return () => fs.unlink(lockPath).catch(() => undefined);
}

function assertFreeze(expected: ExperimentState, code: ExperimentState["freeze"]["code"]): void {
  if (expected.freeze.code.commit !== code.commit || expected.freeze.code.worktreeSha256 !== code.worktreeSha256) {
    throw new Error("实验期间代码工作区发生变化，已停止后续 arm；请恢复冻结代码后再继续");
  }
  if (expected.freeze.fixtureSha256 !== sha256(JSON.stringify(LAB_SECTION_FIXTURES))) {
    throw new Error("实验期间课程 fixture 发生变化，已停止后续 arm");
  }
}

async function materializeFixtureMetrics(
  fixtureDir: string,
  runtimeRoot: string,
  run: ExperimentRunRecord,
): Promise<void> {
  const candidates = [
    path.join(fixtureDir, `${run.sectionId}.${run.pipeline}.json`),
    path.join(fixtureDir, `${run.sectionId}-${run.pipeline}.json`),
  ];
  let source: string | undefined;
  for (const candidate of candidates) {
    try { await fs.access(candidate); source = candidate; break; } catch { /* try the next fixture name */ }
  }
  if (!source) throw new Error(`缺少 fixture 指标：${candidates.map((item) => path.basename(item)).join(" 或 ")}`);
  const target = path.join(runtimeRoot, run.runDirectory, "metrics.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

export async function runExperiment(
  options: ExperimentRunnerOptions,
  dependencies: Partial<RunnerDependencies> = {},
): Promise<{ state: ExperimentState; reportPath?: string }> {
  const deps: RunnerDependencies = {
    now: dependencies.now ?? (() => new Date()),
    captureCodeIdentity: dependencies.captureCodeIdentity ?? captureCodeIdentity,
    execute: dependencies.execute ?? defaultExecute,
  };
  const file = statePath(options.runtimeRoot, options.experimentId);
  const existing = await readState(file);
  if (existing && !options.resume && !existing.dryRun) {
    throw new Error(`实验 ${options.experimentId} 已存在；使用 --resume 从未完成检查点继续`);
  }
  const currentCode = await deps.captureCodeIdentity();
  const now = deps.now().toISOString();
  const state = existing ?? buildExperimentState(options, currentCode, now);
  if (existing) {
    if (existing.freeze.model.modelString !== options.modelString
      || existing.freeze.model.reasoning !== options.reasoning
      || JSON.stringify(existing.freeze.tts) !== JSON.stringify(options.tts)) {
      throw new Error("恢复参数与实验冻结的模型、推理或 TTS 配置不一致");
    }
    assertFreeze(existing, currentCode);
    state.dryRun = options.dryRun;
  }
  state.updatedAt = now;
  await atomicWriteJson(file, state);
  if (options.dryRun) return { state };

  const release = await acquireLock(options.runtimeRoot);
  try {
    state.status = "running";
    await atomicWriteJson(file, state);
    for (const run of state.runs) {
      if (run.status === "complete") continue;
      assertFreeze(state, await deps.captureCodeIdentity());
      const fresh = run.attempts.length === 0;
      const startedAt = deps.now();
      const attempt = { startedAt: startedAt.toISOString(), fresh } as ExperimentRunRecord["attempts"][number];
      run.attempts.push(attempt);
      run.status = "running";
      run.command = ["pnpm", ...generatorArgs(
        state.experimentId,
        run.sectionId,
        run.pipeline,
        run.variant,
        run.audioCacheScope,
        state.freeze.model.modelString,
        state.freeze.model.reasoning,
        state.freeze.tts,
        fresh,
      )];
      state.updatedAt = startedAt.toISOString();
      await atomicWriteJson(file, state);
      try {
        const exitCode = options.fixtureMetricsDir
          ? (await materializeFixtureMetrics(options.fixtureMetricsDir, options.runtimeRoot, run), 0)
          : await deps.execute(run.command[0], run.command.slice(1));
        attempt.exitCode = exitCode;
        if (exitCode !== 0) throw new Error(`生成命令退出码 ${exitCode}`);
        run.status = "complete";
      } catch (error) {
        attempt.error = error instanceof Error ? error.message : String(error);
        run.status = "failed";
        state.status = "failed";
      } finally {
        const completedAt = deps.now();
        attempt.completedAt = completedAt.toISOString();
        attempt.elapsedMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
        state.updatedAt = completedAt.toISOString();
        await atomicWriteJson(file, state);
      }
      if (run.status === "failed") break;
    }
    state.status = state.runs.every((run) => run.status === "complete") ? "complete" : "failed";
    state.updatedAt = deps.now().toISOString();
    await atomicWriteJson(file, state);
    const reportPath = await writeExperimentReport(options.runtimeRoot, state);
    return { state, reportPath };
  } finally {
    await release();
  }
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseExperimentRunnerOptions(argv: string[]): ExperimentRunnerOptions {
  const experimentId = valueAfter(argv, "--experiment-id") ?? `v4-v5-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(experimentId)) {
    throw new Error("--experiment-id 只能包含 3–80 个字母、数字、点、下划线或连字符");
  }
  const required = (flag: string) => {
    const value = valueAfter(argv, flag);
    if (!value) throw new Error(`缺少冻结参数 ${flag}`);
    return value;
  };
  const speed = Number(valueAfter(argv, "--tts-speed") ?? "1");
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("--tts-speed 必须是正数");
  return {
    runtimeRoot: path.resolve(valueAfter(argv, "--root") ?? DEFAULT_RUNTIME_ROOT),
    experimentId,
    modelString: required("--model"),
    reasoning: required("--reasoning"),
    tts: {
      provider: required("--tts-provider"),
      model: required("--tts-model"),
      voice: required("--tts-voice"),
      language: valueAfter(argv, "--tts-language") ?? "zh-CN",
      speed,
    },
    dryRun: argv.includes("--dry-run"),
    resume: argv.includes("--resume"),
    fixtureMetricsDir: valueAfter(argv, "--fixture-metrics-dir"),
  };
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedAsScript) {
  runExperiment(parseExperimentRunnerOptions(process.argv.slice(2)))
    .then(({ state, reportPath }) => {
      console.log(`实验 ${state.experimentId}：${state.status}`);
      if (reportPath) console.log(`报告：${reportPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
