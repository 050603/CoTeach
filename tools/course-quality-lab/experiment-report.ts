import fs from "node:fs/promises";
import path from "node:path";

import type { LabModuleMetrics, LabTokenUsageSource } from "./types";
import type { LAB_TECHNICAL_POLICY } from "./technical-policy";

export type ExperimentPipeline = "v4" | "v5";
export type ExperimentVariant = "baseline" | "enhanced";

export interface ExperimentRunRecord {
  sequence: number;
  runId: string;
  sectionId: string;
  title: string;
  pipeline: ExperimentPipeline;
  variant: ExperimentVariant;
  audioCacheScope: string;
  runDirectory: string;
  status: "planned" | "running" | "complete" | "failed";
  command: string[];
  attempts: Array<{
    startedAt: string;
    completedAt?: string;
    elapsedMs?: number;
    fresh: boolean;
    exitCode?: number;
    error?: string;
  }>;
}

export interface ExperimentState {
  version: 1;
  experimentId: string;
  createdAt: string;
  updatedAt: string;
  status: "planned" | "running" | "complete" | "failed";
  dryRun: boolean;
  freeze: {
    fixtureSha256: string;
    /** Legacy content-review policy retained when reading archived experiments. */
    qualityPolicy?: Record<string, unknown>;
    generationPolicy?: typeof LAB_TECHNICAL_POLICY;
    code: { commit: string; dirty: boolean; worktreeSha256: string };
    model: { modelString: string; reasoning: string };
    tts: { provider: string; model: string; voice: string; language: string; speed: number };
  };
  runs: ExperimentRunRecord[];
}

export interface ExperimentArmMetrics {
  sectionId: string;
  pipeline: ExperimentPipeline;
  qualityPassed: boolean;
  qualityReasons: string[];
  tokenUsage: number;
  tokenUsageSource: LabTokenUsageSource;
  endToEndMs: number;
  logicalCalls: number;
  transportAttempts: number;
  transportRetries: number;
  qualityRepairCalls: number;
  firstPassPages?: number;
  evaluatedPages?: number;
  deterministicAdjustments?: number;
  checkpointReuses: number;
  ttsCalls: number;
  ttsCacheHits: number;
  durationSec?: number;
  moduleMetrics?: Record<string, LabModuleMetrics>;
}

interface CheckpointResult {
  result?: {
    statuses?: Record<string, { state?: string }>;
    technicalValidation?: { state?: string };
    durationSec?: number;
    checks?: string[];
    metrics?: Record<string, unknown>;
  };
}

interface RawCall {
  kind?: string;
  status?: string;
  elapsedMs?: number;
  systemChars?: number;
  userChars?: number;
  outputChars?: number;
  tokenUsage?: number;
  totalTokens?: number;
  tokenUsageSource?: "provider" | "estimated" | "mixed" | "unknown";
  attempts?: unknown[];
}

function legacyModuleMetrics(
  calls: RawCall[],
  ttsCalls: Array<{ status?: string; cacheHit?: boolean; elapsedMs?: number }>,
): Record<string, LabModuleMetrics> | undefined {
  const groups = new Map<string, RawCall[]>();
  const moduleName = (kind: string | undefined) => kind === "design" ? "planning" : kind ?? "unknown";
  for (const call of calls) {
    const name = moduleName(call.kind);
    groups.set(name, [...(groups.get(name) ?? []), call]);
  }
  const entries = [...groups.entries()].map(([name, moduleCalls]) => {
    const tokens = legacyTokenMetrics(moduleCalls);
    return [name, {
      tokenUsage: tokens.tokenUsage,
      tokenUsageSource: tokens.tokenUsageSource,
      inputCharacters: moduleCalls.reduce((sum, call) => sum + finite(call.systemChars) + finite(call.userChars), 0),
      outputCharacters: moduleCalls.reduce((sum, call) => sum + finite(call.outputChars), 0),
      calls: moduleCalls.length,
      failedCalls: moduleCalls.filter((call) => call.status === "failed").length,
      transportAttempts: moduleCalls.reduce((sum, call) => sum + (call.attempts?.length || (call.status ? 1 : 0)), 0),
      transportRetries: moduleCalls.reduce((sum, call) => sum + Math.max(0, (call.attempts?.length ?? 1) - 1), 0),
      elapsedMs: moduleCalls.reduce((sum, call) => sum + finite(call.elapsedMs), 0),
    } satisfies LabModuleMetrics] as const;
  });
  if (ttsCalls.length > 0) {
    entries.push(["tts", {
      tokenUsage: 0,
      tokenUsageSource: "unknown",
      inputCharacters: 0,
      outputCharacters: 0,
      calls: ttsCalls.length,
      failedCalls: ttsCalls.filter((call) => call.status === "failed").length,
      transportAttempts: ttsCalls.length,
      transportRetries: 0,
      elapsedMs: ttsCalls.reduce((sum, call) => sum + finite(call.elapsedMs), 0),
    }]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function experimentWallClockMs(run: ExperimentRunRecord): number {
  const firstStartedAt = Date.parse(run.attempts[0]?.startedAt ?? "");
  const lastCompletedAt = Date.parse(run.attempts.at(-1)?.completedAt ?? "");
  if (Number.isFinite(firstStartedAt) && Number.isFinite(lastCompletedAt)
    && lastCompletedAt >= firstStartedAt) {
    return lastCompletedAt - firstStartedAt;
  }
  return run.attempts.reduce((sum, attempt) => sum + finite(attempt.elapsedMs), 0);
}

function tokenSource(value: unknown): LabTokenUsageSource {
  if (value === "provider") return "provider-reported";
  return value === "provider-reported" || value === "estimated" || value === "mixed" || value === "unknown"
    ? value
    : "unknown";
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizeExplicitMetrics(
  raw: Record<string, unknown>,
  run: ExperimentRunRecord,
): ExperimentArmMetrics {
  const quality = raw.quality && typeof raw.quality === "object"
    ? raw.quality as Record<string, unknown>
    : raw;
  const cost = raw.cost && typeof raw.cost === "object" ? raw.cost as Record<string, unknown> : raw;
  const timing = raw.timing && typeof raw.timing === "object" ? raw.timing as Record<string, unknown> : raw;
  const calls = raw.calls && typeof raw.calls === "object" ? raw.calls as Record<string, unknown> : raw;
  const audio = raw.audio && typeof raw.audio === "object" ? raw.audio as Record<string, unknown> : raw;
  return {
    sectionId: run.sectionId,
    pipeline: run.pipeline,
    qualityPassed: quality.passed === true || raw.qualityPassed === true,
    qualityReasons: Array.isArray(quality.reasons)
      ? quality.reasons.filter((item): item is string => typeof item === "string")
      : [],
    tokenUsage: finite(cost.tokenUsage ?? raw.tokenUsage),
    tokenUsageSource: tokenSource(cost.tokenUsageSource ?? raw.tokenUsageSource),
    endToEndMs: finite(timing.endToEndMs ?? raw.endToEndMs ?? raw.wallClockMs),
    logicalCalls: finite(calls.logical ?? raw.logicalCalls ?? raw.modelCalls),
    transportAttempts: finite(calls.transportAttempts ?? raw.transportAttempts),
    transportRetries: finite(calls.transportRetries ?? raw.transportRetries),
    qualityRepairCalls: finite(calls.qualityRepairs ?? raw.qualityRepairCalls),
    ...(raw.firstPassPages !== undefined ? { firstPassPages: finite(raw.firstPassPages) } : {}),
    ...(raw.evaluatedPages !== undefined ? { evaluatedPages: finite(raw.evaluatedPages) } : {}),
    ...(raw.deterministicAdjustments !== undefined
      ? { deterministicAdjustments: finite(raw.deterministicAdjustments) }
      : {}),
    checkpointReuses: finite(calls.checkpointReuses ?? raw.checkpointReuses),
    ttsCalls: finite(audio.calls ?? raw.ttsCalls),
    ttsCacheHits: finite(audio.cacheHits ?? raw.ttsCacheHits),
    durationSec: finite(audio.durationSec ?? raw.durationSec) || undefined,
    ...(raw.moduleMetrics && typeof raw.moduleMetrics === "object"
      ? { moduleMetrics: raw.moduleMetrics as Record<string, LabModuleMetrics> }
      : {}),
  };
}

function legacyTokenMetrics(calls: RawCall[]): Pick<ExperimentArmMetrics, "tokenUsage" | "tokenUsageSource"> {
  const sources = new Set<LabTokenUsageSource>();
  let tokenUsage = 0;
  for (const call of calls) {
    const recorded = finite(call.tokenUsage ?? call.totalTokens);
    tokenUsage += recorded > 0
      ? recorded
      : Math.ceil((finite(call.systemChars) + finite(call.userChars) + finite(call.outputChars)) / 2.5);
    sources.add(call.tokenUsageSource === "provider"
      ? "provider-reported"
      : call.tokenUsageSource === "estimated" || call.tokenUsageSource === "mixed"
        ? call.tokenUsageSource
        : "unknown");
  }
  return {
    tokenUsage,
    tokenUsageSource: sources.size === 1 ? [...sources][0] : sources.size > 1 ? "mixed" : "unknown",
  };
}

export async function readExperimentArmMetrics(
  runtimeRoot: string,
  run: ExperimentRunRecord,
): Promise<ExperimentArmMetrics> {
  const runDir = path.join(runtimeRoot, run.runDirectory);
  const explicit = await readJson<Record<string, unknown>>(path.join(runDir, "metrics.json"));
  if (explicit) return normalizeExplicitMetrics(explicit, run);

  const [checkpoint, calls, designCalls, telemetry, ttsCalls] = await Promise.all([
    readJson<CheckpointResult>(path.join(runDir, "result.json")),
    readJson<RawCall[]>(path.join(runDir, "calls.json")),
    readJson<RawCall[]>(path.join(
      runtimeRoot,
      "designs",
      path.basename(path.dirname(path.dirname(path.dirname(run.runDirectory)))),
      run.sectionId,
      "1",
      run.pipeline,
      "calls.json",
    )),
    readJson<Record<string, unknown>>(path.join(runDir, "telemetry.json")),
    readJson<Array<{ status?: string; cacheHit?: boolean; elapsedMs?: number }>>(path.join(runDir, "tts-calls.json")),
  ]);
  const result = checkpoint?.result;
  if (result?.metrics && typeof result.metrics === "object") {
    const normalized = normalizeExplicitMetrics({
      ...result.metrics,
      durationSec: result.durationSec,
      qualityPassed: Object.values(result.statuses ?? {}).every((item) => item.state === "complete")
        && (result.technicalValidation?.state === undefined || result.technicalValidation.state === "complete"),
    }, run);
    if (normalized.endToEndMs <= 0) {
      normalized.endToEndMs = experimentWallClockMs(run);
    }
    return normalized;
  }

  const callList = [
    ...(Array.isArray(designCalls) ? designCalls : []),
    ...(Array.isArray(calls) ? calls : []),
  ];
  const ttsList = Array.isArray(ttsCalls) ? ttsCalls : [];
  const tokens = legacyTokenMetrics(callList);
  const moduleMetrics = legacyModuleMetrics(callList, ttsList);
  const durationSec = finite(result?.durationSec) || undefined;
  const statusesComplete = Object.values(result?.statuses ?? {}).length > 0
    && Object.values(result?.statuses ?? {}).every((item) => item.state === "complete");
  const technicalValidationPassed = result?.technicalValidation?.state === undefined
    || result.technicalValidation.state === "complete";
  const qualityReasons = [
    ...(!statusesComplete ? ["PPT、文稿或音频产物不完整"] : []),
    ...(!technicalValidationPassed ? ["技术校验未完成"] : []),
  ];
  return {
    sectionId: run.sectionId,
    pipeline: run.pipeline,
    qualityPassed: statusesComplete && technicalValidationPassed,
    qualityReasons,
    ...tokens,
    endToEndMs: experimentWallClockMs(run)
      || Math.max(0, Date.parse(String(telemetry?.completedAt ?? "")) - Date.parse(String(telemetry?.startedAt ?? ""))),
    logicalCalls: callList.length,
    transportAttempts: callList.reduce((sum, call) => sum + (call.attempts?.length || (call.status ? 1 : 0)), 0),
    transportRetries: callList.reduce((sum, call) => sum + Math.max(0, (call.attempts?.length ?? 1) - 1), 0),
    qualityRepairCalls: finite(telemetry?.qualityRepairCalls),
    ...(telemetry?.firstPassPages !== undefined ? { firstPassPages: finite(telemetry.firstPassPages) } : {}),
    ...(telemetry?.evaluatedPages !== undefined ? { evaluatedPages: finite(telemetry.evaluatedPages) } : {}),
    ...(telemetry?.deterministicAdjustments !== undefined
      ? { deterministicAdjustments: finite(telemetry.deterministicAdjustments) }
      : {}),
    checkpointReuses: finite(telemetry?.checkpointReuses),
    ttsCalls: ttsList.length,
    ttsCacheHits: ttsList.filter((item) => item.cacheHit).length,
    durationSec,
    ...(moduleMetrics ? { moduleMetrics } : {}),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function range(values: number[]): string {
  if (values.length === 0) return "无数据";
  return `${Math.min(...values).toLocaleString("zh-CN")}–${Math.max(...values).toLocaleString("zh-CN")}`;
}

function pctDelta(before: number, after: number): string {
  if (before <= 0) return "不可比";
  const value = ((after - before) / before) * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

function tokenLabel(metric: ExperimentArmMetrics): string {
  const source = metric.tokenUsageSource === "provider-reported"
    ? "实报"
    : metric.tokenUsageSource === "estimated"
      ? "估算"
      : metric.tokenUsageSource === "mixed"
        ? "混合"
        : "来源未知";
  return `${metric.tokenUsage.toLocaleString("zh-CN")}（${source}）`;
}

export function renderExperimentReport(state: ExperimentState, metrics: ExperimentArmMetrics[]): string {
  const pairs = state.runs.reduce<Array<{
    sectionId: string;
    title: string;
    v4?: ExperimentArmMetrics;
    v5?: ExperimentArmMetrics;
  }>>((items, run) => {
    let item = items.find((candidate) => candidate.sectionId === run.sectionId);
    if (!item) {
      item = { sectionId: run.sectionId, title: run.title };
      items.push(item);
    }
    item[run.pipeline] = metrics.find((metric) => metric.sectionId === run.sectionId && metric.pipeline === run.pipeline);
    return items;
  }, []);
  const completePairs = pairs.filter((pair): pair is typeof pair & { v4: ExperimentArmMetrics; v5: ExperimentArmMetrics } =>
    Boolean(pair.v4 && pair.v5));
  const v4Tokens = completePairs.map((pair) => pair.v4.tokenUsage);
  const v5Tokens = completePairs.map((pair) => pair.v5.tokenUsage);
  const v4Times = completePairs.map((pair) => pair.v4.endToEndMs);
  const v5Times = completePairs.map((pair) => pair.v5.endToEndMs);
  const overallCandidate = completePairs.length === 3
    && completePairs.every((pair) => pair.v4.qualityPassed && pair.v5.qualityPassed)
    && median(v5Tokens) < median(v4Tokens)
    && median(v5Times) < median(v4Times);
  const lines = [
    "# V4 / V5 课程生成对比实验报告",
    "",
    `实验 ID：\`${state.experimentId}\`  `,
    `生成时间：${state.updatedAt}  `,
    `结论：${overallCandidate ? "V5 满足自动优化候选门槛" : "V5 尚未满足自动优化候选门槛"}`,
    "",
    "## 冻结条件",
    "",
    `- 代码：\`${state.freeze.code.commit}\`，工作区指纹 \`${state.freeze.code.worktreeSha256.slice(0, 12)}\`${state.freeze.code.dirty ? "（含未提交修改）" : ""}`,
    `- fixture：\`${state.freeze.fixtureSha256}\``,
    `- 模型：\`${state.freeze.model.modelString}\`；推理配置：\`${state.freeze.model.reasoning}\``,
    `- TTS：\`${state.freeze.tts.provider}/${state.freeze.tts.model}/${state.freeze.tts.voice}\`，${state.freeze.tts.language}，速度 ${state.freeze.tts.speed}`,
    `- 固定运行顺序：${state.runs.map((run) => `${run.sequence}. ${run.sectionId}/${run.pipeline}`).join(" → ")}`,
    "",
    "## 逐课程结果",
    "",
    "| 课程 | V4 Token | V5 Token | Token 变化 | V4 端到端 | V5 端到端 | 时长变化 | 独立质量门槛 | 候选 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...pairs.map((pair) => {
      if (!pair.v4 || !pair.v5) return `| ${pair.title} | 缺失 | 缺失 | — | — | — | — | 未完成 | 否 |`;
      const candidate = pair.v4.qualityPassed && pair.v5.qualityPassed
        && pair.v5.tokenUsage < pair.v4.tokenUsage
        && pair.v5.endToEndMs < pair.v4.endToEndMs;
      return `| ${pair.title} | ${tokenLabel(pair.v4)} | ${tokenLabel(pair.v5)} | ${pctDelta(pair.v4.tokenUsage, pair.v5.tokenUsage)} | ${seconds(pair.v4.endToEndMs)} | ${seconds(pair.v5.endToEndMs)} | ${pctDelta(pair.v4.endToEndMs, pair.v5.endToEndMs)} | V4 ${pair.v4.qualityPassed ? "通过" : "未通过"} / V5 ${pair.v5.qualityPassed ? "通过" : "未通过"} | ${candidate ? "是" : "否"} |`;
    }),
    "",
    "## 调用、修复与恢复",
    "",
    "| 课程 / 流水线 | 逻辑调用 | 真实请求 | 传输重试 | 首次通过 | 确定性调整 | 质量修复 | 检查点复用 | TTS / 缓存 | 真实音频 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metrics.map((metric) => {
      const title = pairs.find((pair) => pair.sectionId === metric.sectionId)?.title ?? metric.sectionId;
      const firstPass = metric.firstPassPages === undefined || metric.evaluatedPages === undefined
        ? "未记录"
        : `${metric.firstPassPages}/${metric.evaluatedPages}`;
      return `| ${title} / ${metric.pipeline.toUpperCase()} | ${metric.logicalCalls} | ${metric.transportAttempts} | ${metric.transportRetries} | ${firstPass} | ${metric.deterministicAdjustments ?? "未记录"} | ${metric.qualityRepairCalls} | ${metric.checkpointReuses} | ${metric.ttsCalls} / ${metric.ttsCacheHits} | ${metric.durationSec === undefined ? "未记录" : `${metric.durationSec.toFixed(1)}s`} |`;
    }),
    "",
    "## 总体统计",
    "",
    "| 指标 | V4 中位数（范围） | V5 中位数（范围） | 变化 |",
    "| --- | ---: | ---: | ---: |",
    `| Token | ${median(v4Tokens).toLocaleString("zh-CN")}（${range(v4Tokens)}） | ${median(v5Tokens).toLocaleString("zh-CN")}（${range(v5Tokens)}） | ${pctDelta(median(v4Tokens), median(v5Tokens))} |`,
    `| 端到端时间 | ${seconds(median(v4Times))}（${range(v4Times.map((value) => value / 1000))}s） | ${seconds(median(v5Times))}（${range(v5Times.map((value) => value / 1000))}s） | ${pctDelta(median(v4Times), median(v5Times))} |`,
    "",
    "质量门槛使用同一套独立验收结果；Token 来源逐项标注。教师听感由 3010 人工评判单独记录，不计入自动候选结论。三组结果只用于效果验证，不声明统计显著性。",
    "",
  ];
  const moduleRows = metrics
    .filter((metric) => metric.pipeline === "v5")
    .flatMap((metric) => Object.entries(metric.moduleMetrics ?? {}).map(([module, value]) => ({
      sectionId: metric.sectionId,
      module,
      value,
    })));
  if (moduleRows.length > 0) {
    lines.push(
      "## V5 模块成本",
      "",
      "| 课程 | 模块 | Token（来源） | 调用 / 失败 | 请求 / 重试 | 耗时 |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      ...moduleRows.map(({ sectionId, module, value }) => {
        const title = pairs.find((pair) => pair.sectionId === sectionId)?.title ?? sectionId;
        const source = tokenSource(value.tokenUsageSource);
        return `| ${title} | ${module} | ${value.tokenUsage.toLocaleString("zh-CN")}（${source}） | ${value.calls} / ${value.failedCalls} | ${value.transportAttempts} / ${value.transportRetries} | ${seconds(value.elapsedMs)} |`;
      }),
      "",
    );
  }
  const failed = metrics.flatMap((metric) => metric.qualityReasons.map((reason) => `${metric.sectionId}/${metric.pipeline}：${reason}`));
  if (failed.length > 0) {
    lines.push("## 未通过原因", "", ...failed.map((reason) => `- ${reason}`), "");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeExperimentReport(runtimeRoot: string, state: ExperimentState): Promise<string> {
  const completed = state.runs.filter((run) => run.status === "complete");
  const metrics = await Promise.all(completed.map((run) => readExperimentArmMetrics(runtimeRoot, run)));
  const report = renderExperimentReport(state, metrics);
  const reportPath = path.join(runtimeRoot, "reports", `${state.experimentId}.md`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, report, "utf8");
  await fs.rename(temporary, reportPath);
  return reportPath;
}
