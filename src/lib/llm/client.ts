// LLM client. Reads endpoint / api key / model from settings page (server-providers.yml),
// legacy ai-settings.json, or OPENPBL_LLM_* env vars (in that order via getActiveAiSettings).
// When all are missing, throws LlmNotConfiguredError so the UI can show an explicit error.

import {
  buildEvaluationPlanPrompt,
  buildFullCoursePrompt,
  buildKnowledgeGraphPrompt,
  buildLessonOutlinePrompt,
  buildModuleTimingPlanPrompt,
  buildPblOutlinePrompt,
  buildTeachingOutlinePrompt,
} from "./prompts";
import type { GenerateInput, LlmCallRequest, LlmCallResponse } from "./types";
import { LlmNotConfiguredError } from "./types";
import {
  LlmCallFailedError,
  LlmEmptyResponseError,
  LlmJsonModeUnsupportedError,
  LlmOutputIncompleteError,
  LlmRateLimitError,
  LlmStreamCorruptedError,
  LlmTimeoutError,
} from "./errors";
import type {
  CourseContent,
  EvaluationPlan,
  KnowledgeGraph,
  LessonOutlineSection,
  TeachingOutlineSection,
} from "../session/types";
import { DEFAULT_EVALUATION_FLOWS } from "../session/types";
import { getActiveAiSettings } from "./settings";
import { proxyFetch } from "@openmaic/lib/server/proxy-fetch";
import { validatePblKnowledgeAlignment } from "@/lib/pbl-outline-validation";
import {
  assessKnowledgeGraphQuality,
  normalizeKnowledgePointName,
} from "@/lib/knowledge-graph-quality";
import {
  applyConfirmedPblTimingPlan,
  assessPblTeachingOutlineStructure,
  createPblTimingSkeleton,
  normalizePblTeachingOutline,
} from "@/lib/pbl-outline-normalization";
import {
  buildPblModelTimingPlan,
  isPblModuleTimingPlanConfirmed,
  normalizePblStageKey,
  rescalePblDetailDurations,
  type PblModelTimingRecommendation,
} from "@/lib/pbl-time-model";
import { localizeGeneratedNarrative } from "./generated-language";
import {
  reportCourseGenerationTokenUsage,
  withCourseGenerationLlmSlot,
} from "@/lib/course-generation/llm-concurrency";
import { withGenerationRetry } from "@openmaic/lib/generation/generation-retry";
import {
  requestClassForCourseContentAction,
  DURABLE_GENERATION_TRANSIENT_RETRIES,
  resolveLlmRequestTimeoutMs,
  type LlmRequestClass,
} from "@/lib/llm/request-policy";
export { localizeGeneratedNarrative } from "./generated-language";

function env(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) return process.env[name];
  return undefined;
}

export function isLlmConfigured(): boolean {
  return Boolean(env("OPENPBL_LLM_ENDPOINT") && env("OPENPBL_LLM_API_KEY"));
}

export async function isActiveLlmConfigured(): Promise<boolean> {
  const settings = await getActiveAiSettings();
  return Boolean(settings.endpoint && settings.apiKey);
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_MALFORMED_STREAM_CHUNKS = 5;
let llmCooldownUntil = 0;

// Re-export for backward compatibility — LlmRateLimitError used to live here.
export { LlmRateLimitError } from "./errors";

export function isLlmCoolingDown(): boolean {
  return Date.now() < llmCooldownUntil;
}

function setRateLimitCooldown(res: Response, detail = ""): LlmRateLimitError {
  const retryAfter = res.headers.get("retry-after");
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(1_000, retryAfterSeconds * 1_000)
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  llmCooldownUntil = Math.max(llmCooldownUntil, Date.now() + retryAfterMs);
  return new LlmRateLimitError(retryAfterMs, detail);
}

/**
 * Combine a caller-provided abort signal with a request-class timeout. Returns the
 * combined signal plus the timeout signal so callers can distinguish a
 * timeout-driven abort from a caller-driven abort and throw the more
 * specific `LlmTimeoutError`.
 */
function withTimeout(callerSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
} {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([callerSignal ?? new AbortController().signal, timeoutSignal]);
  return { signal, timeoutSignal };
}

/**
 * Summarize an upstream error body to a short, log-safe string. The full
 * body is intentionally discarded so `LlmCallFailedError` never carries
 * raw upstream payloads through logs or SSE events.
 */
function summarizeUpstream(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

export type LlmCallOptions = {
  jsonMode?: boolean;
  abortSignal?: AbortSignal;
  requestClass?: LlmRequestClass;
  maxTransientRetries?: number;
};

export async function callLLM(
  messages: ChatMessage[],
  opts: LlmCallOptions = {},
): Promise<string> {
  return callChatCompletions(messages, {
    jsonMode: opts.jsonMode ?? false,
    abortSignal: opts.abortSignal,
    requestClass: opts.requestClass ?? "standard",
    maxTransientRetries: opts.maxTransientRetries ?? 0,
  });
}

/**
 * Streaming LLM call — yields text deltas as they arrive.
 * Uses the same settings as callLLM but with stream: true.
 */
export async function* callLLMStream(
  messages: ChatMessage[],
  opts: { abortSignal?: AbortSignal; requestClass?: LlmRequestClass } = {},
): AsyncGenerator<string, void, void> {
  opts.abortSignal?.throwIfAborted();
  if (isLlmCoolingDown()) {
    throw new LlmRateLimitError(Math.max(0, llmCooldownUntil - Date.now()));
  }

  const settings = await getActiveAiSettings();
  const endpoint = settings.endpoint || env("OPENPBL_LLM_ENDPOINT");
  const apiKey = settings.apiKey || env("OPENPBL_LLM_API_KEY");
  const model = settings.model || env("OPENPBL_LLM_MODEL");

  if (!endpoint || !apiKey || !model) throw new LlmNotConfiguredError();

  const url = endpoint.replace(/\/+$/, "") + "/chat/completions";
  const timeoutMs = resolveLlmRequestTimeoutMs(opts.requestClass ?? "standard");
  const { signal, timeoutSignal } = withTimeout(opts.abortSignal, timeoutMs);

  let res: Response;
  try {
    res = await proxyFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.5,
        stream: true,
      }),
      signal,
    }, settings.proxy);
  } catch (err) {
    opts.abortSignal?.throwIfAborted();
    if (timeoutSignal.aborted) throw new LlmTimeoutError(timeoutMs);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) throw setRateLimitCooldown(res, text);
    throw new LlmCallFailedError(`LLM 调用失败：${res.status}`, {
      status: res.status,
      upstreamSummary: summarizeUpstream(text),
    });
  }

  const reader = res.body?.getReader();
  if (!reader) throw new LlmEmptyResponseError();

  const decoder = new TextDecoder();
  let buffer = "";
  let malformedChunkCount = 0;
  let finishReason: string | undefined;

  try {
    while (true) {
      opts.abortSignal?.throwIfAborted();
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (err) {
        opts.abortSignal?.throwIfAborted();
        if (timeoutSignal.aborted) throw new LlmTimeoutError(timeoutMs);
        throw err;
      }
      const { done, value } = readResult;
      opts.abortSignal?.throwIfAborted();
      buffer += done ? `${decoder.decode()}\n` : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        opts.abortSignal?.throwIfAborted();
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trimStart();
        if (data === "[DONE]") return;

        let parsed: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] };
        try {
          parsed = JSON.parse(data);
        } catch {
          // Record malformed chunk instead of silently skipping. Once the
          // stream exceeds the malformed-chunk budget the response is
          // considered corrupted and we abort so the caller can surface a
          // targeted error rather than silently producing partial output.
          malformedChunkCount += 1;
          const preview = data.length > 200 ? `${data.slice(0, 200)}…` : data;
          console.warn(
            `[LLM] Malformed stream chunk (${malformedChunkCount}/${MAX_MALFORMED_STREAM_CHUNKS}): ${preview}`,
          );
          if (malformedChunkCount > MAX_MALFORMED_STREAM_CHUNKS) {
            throw new LlmStreamCorruptedError(malformedChunkCount);
          }
          continue;
        }
        const choice = parsed?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (finishReason === "length" || finishReason === "content_filter") {
          throw new LlmCallFailedError(`LLM 流式回答未完成（${finishReason}）`);
        }
        if (choice?.delta?.content) yield choice.delta.content;
      }
      if (done) {
        if (!finishReason) throw new LlmCallFailedError("LLM 流式连接提前结束，回答未完成");
        return;
      }
    }
  } finally {
    // Releasing the lock alone leaves an unfinished response occupying its
    // connection when a consumer stops iterating or a terminal SSE event arrives.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function isLlmReady(): Promise<boolean> {
  try {
    return !isLlmCoolingDown() && (await isActiveLlmConfigured());
  } catch {
    return false;
  }
}

export function parseLLMJson<T = unknown>(text: string): T {
  return extractJson(text) as T;
}

async function callChatCompletions(
  messages: ChatMessage[],
  opts: {
    jsonMode: boolean;
    abortSignal?: AbortSignal;
    requestClass: LlmRequestClass;
    maxTransientRetries: number;
  },
): Promise<string> {
  const timeoutMs = resolveLlmRequestTimeoutMs(opts.requestClass);
  return withGenerationRetry(
    () => withCourseGenerationLlmSlot(
      () => callChatCompletionsWithoutCourseLimit(messages, {
        jsonMode: opts.jsonMode,
        abortSignal: opts.abortSignal,
        timeoutMs,
      }),
      { signal: opts.abortSignal },
    ),
    {
      label: `LLM ${opts.requestClass} request`,
      maxRetries: Math.max(
        0,
        Math.min(DURABLE_GENERATION_TRANSIENT_RETRIES, opts.maxTransientRetries),
      ),
      baseDelayMs: 2_000,
      maxDelayMs: 10_000,
      signal: opts.abortSignal,
      onRetry: (event) => {
        console.warn(
          `[LLM] ${event.label} transient failure (${event.attempt}/${event.maxAttempts}); retrying in ${event.nextDelayMs}ms: ${event.reason}`,
        );
      },
    },
  );
}

async function callChatCompletionsWithoutCourseLimit(
  messages: ChatMessage[],
  opts: { jsonMode: boolean; abortSignal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  if (isLlmCoolingDown()) {
    throw new LlmRateLimitError(Math.max(0, llmCooldownUntil - Date.now()));
  }

  const settings = await getActiveAiSettings();
  const endpoint = settings.endpoint || env("OPENPBL_LLM_ENDPOINT");
  const apiKey = settings.apiKey || env("OPENPBL_LLM_API_KEY");
  const model = settings.model || env("OPENPBL_LLM_MODEL");

  if (!endpoint || !apiKey || !model) throw new LlmNotConfiguredError();

  const url = endpoint.replace(/\/+$/, "") + "/chat/completions";
  const { signal, timeoutSignal } = withTimeout(opts.abortSignal, opts.timeoutMs);

  async function doFetch(useJsonMode: boolean): Promise<Response> {
    return proxyFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.5,
        ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal,
    }, settings.proxy);
  }

  let res: Response;
  try {
    res = await doFetch(opts.jsonMode);
  } catch (err) {
    if (timeoutSignal.aborted) throw new LlmTimeoutError(opts.timeoutMs);
    const cause = err instanceof Error
      ? (err as Error & { cause?: unknown }).cause
      : undefined;
    const causeCode = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LLM request failed [host=${new URL(url).hostname}]: ${reason}${causeCode ? ` (${causeCode})` : ""}`,
      { cause: err },
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Identify JSON-mode-unsupported responses and surface them as a
    // dedicated error instead of silently retrying in plain mode.
    const jsonModeRejected = /response_format|json[ _-]?mode|json_object/i.test(text)
      && /unsupported|not supported|invalid|unrecognized|unknown|不支持|无效/i.test(text);
    if (opts.jsonMode && res.status === 400 && jsonModeRejected) {
      throw new LlmJsonModeUnsupportedError(summarizeUpstream(text));
    }
    if (res.status === 429) throw setRateLimitCooldown(res, text);
    throw new LlmCallFailedError(`LLM 调用失败：${res.status}`, {
      status: res.status,
      upstreamSummary: summarizeUpstream(text),
    });
  }

  let data: {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
  } catch (error) {
    if (timeoutSignal.aborted) throw new LlmTimeoutError(opts.timeoutMs);
    throw error;
  }
  const content = data.choices?.[0]?.message?.content;
  const reportedTotal = data.usage?.total_tokens
    ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0) || undefined);
  await reportCourseGenerationTokenUsage(
    reportedTotal,
    messages.reduce((sum, message) => sum + message.content.length, 0) + (content?.length ?? 0),
  );
  if (!content) throw new LlmEmptyResponseError();
  return content;
}

function extractJson(text: string): unknown {
  const candidates = [
    text.trim(),
    text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue with the bounded JSON fragments below.
    }
  }

  const fragments = [
    text.match(/\{[\s\S]*\}/)?.[0],
    text.match(/\[[\s\S]*\]/)?.[0],
  ].filter((fragment): fragment is string => Boolean(fragment));
  for (const fragment of fragments) {
    try {
      return JSON.parse(fragment);
    } catch {
      // Keep the original error category for the UI.
    }
  }
  throw new Error("LLM 返回非 JSON");
}

function emptyCourseContent(): CourseContent {
  return {
    pblOutline: "",
    knowledgePoints: [],
    knowledgeGraph: { nodes: [], edges: [] },
    teachingOutline: [],
    lessonOutline: [],
    evaluationPlan: { dimensions: [], overallRubric: "" },
  };
}

function requireText(value: unknown, scope: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${scope}失败：AI 返回结构不完整，请检查模型输出后重试。`);
  }
  return localizeGeneratedNarrative(value.trim());
}

function validateKnowledgePoints(raw: unknown): CourseContent["knowledgePoints"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("知识图谱生成失败：AI 未返回知识点。");
  }
  const points = raw.map<CourseContent["knowledgePoints"][number]>((item, index) => {
    const point = item && typeof item === "object"
      ? item as {
          id?: string;
          name?: string;
          description?: string;
          keyInfo?: string;
          masteryBoundary?: string;
          objectiveIndexes?: unknown;
          relatedIds?: unknown;
          level?: unknown;
        }
      : {};
    return {
      id: typeof point.id === "string" && point.id.trim() ? point.id.trim() : `kp-${index + 1}`,
      name: requireText(point.name, "知识点"),
      description: typeof point.description === "string" ? localizeGeneratedNarrative(point.description.trim()) : "",
      keyInfo: typeof point.keyInfo === "string" && point.keyInfo.trim() ? localizeGeneratedNarrative(point.keyInfo.trim()) : undefined,
      masteryBoundary: typeof point.masteryBoundary === "string" && point.masteryBoundary.trim()
        ? localizeGeneratedNarrative(point.masteryBoundary.trim())
        : undefined,
      objectiveIndexes: Array.isArray(point.objectiveIndexes)
        ? [...new Set(point.objectiveIndexes.filter((value): value is number =>
            typeof value === "number" && Number.isInteger(value) && value >= 0,
          ))]
        : undefined,
      relatedIds: Array.isArray(point.relatedIds)
        ? point.relatedIds.filter((id): id is string => typeof id === "string")
        : undefined,
      level:
        point.level === "foundation" ||
        point.level === "core" ||
        point.level === "application" ||
        point.level === "extension"
          ? point.level
          : undefined,
    };
  });
  if (new Set(points.map((point) => point.id)).size !== points.length) {
    throw new Error("知识图谱生成失败：知识点 ID 存在重复。");
  }
  if (new Set(points.map((point) => normalizeKnowledgePointName(point.name))).size !== points.length) {
    throw new Error("知识图谱生成失败：知识点名称存在重复或同义重复。");
  }
  return points;
}

function normalizeKnowledgeGraph(raw: unknown, knowledgePoints: CourseContent["knowledgePoints"]): KnowledgeGraph {
  const obj = raw && typeof raw === "object" ? raw as Partial<KnowledgeGraph> : {};
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error("知识图谱生成失败：AI 未返回图谱节点。");
  }
  const rawNodes = obj.nodes;
  const rawNodesById = new Map(rawNodes.map((node) => [node.id, node]));
  if (rawNodesById.size !== rawNodes.length) {
    throw new Error("知识图谱生成失败：图谱节点 ID 存在重复。");
  }
  if (knowledgePoints.some((point) => !rawNodesById.has(point.id))) {
    throw new Error("知识图谱生成失败：图谱节点没有覆盖全部本课知识点。");
  }

  const lessonNodes: KnowledgeGraph["nodes"] = knowledgePoints.map((point) => {
    const node = rawNodesById.get(point.id)!;
    const nodeLevel =
      node.level === "foundation" ||
      node.level === "core" ||
      node.level === "application" ||
      node.level === "extension"
        ? node.level
        : undefined;
    return {
      id: point.id,
      label: point.name,
      description: point.description || (typeof node.description === "string" ? localizeGeneratedNarrative(node.description.trim()) : ""),
      keyInfo: point.keyInfo || (typeof node.keyInfo === "string" ? localizeGeneratedNarrative(node.keyInfo.trim()) : undefined),
      level: point.level ?? nodeLevel,
      instructionalRole: "lesson" as const,
      objectiveIndexes: point.objectiveIndexes?.length
        ? point.objectiveIndexes
        : Array.isArray(node.objectiveIndexes)
          ? [...new Set(node.objectiveIndexes.filter((value): value is number =>
              typeof value === "number" && Number.isInteger(value) && value >= 0,
            ))]
          : undefined,
      masteryBoundary: point.masteryBoundary
        || (typeof node.masteryBoundary === "string" && node.masteryBoundary.trim()
          ? localizeGeneratedNarrative(node.masteryBoundary.trim())
          : point.keyInfo || point.description),
      relatedLessonIds: Array.isArray(node.relatedLessonIds)
        ? node.relatedLessonIds.filter((id): id is string => typeof id === "string")
        : undefined,
    };
  });
  const prerequisiteNodes: KnowledgeGraph["nodes"] = rawNodes.flatMap((node) => {
    if (knowledgePoints.some((point) => point.id === node.id)) return [];
    if (node.instructionalRole !== "prerequisite") {
      throw new Error("知识图谱生成失败：本课知识点之外的节点必须标记为 prerequisite。");
    }
    const level = node.level === "core" || node.level === "application" || node.level === "extension"
      ? node.level
      : "foundation" as const;
    return [{
      id: typeof node.id === "string" ? node.id.trim() : "",
      label: typeof node.label === "string" ? localizeGeneratedNarrative(node.label.trim()) : "",
      description: typeof node.description === "string" ? localizeGeneratedNarrative(node.description.trim()) : "",
      keyInfo: typeof node.keyInfo === "string" && node.keyInfo.trim()
        ? localizeGeneratedNarrative(node.keyInfo.trim())
        : undefined,
      level,
      instructionalRole: "prerequisite" as const,
      priorKnowledgeEvidence: typeof node.priorKnowledgeEvidence === "string" && node.priorKnowledgeEvidence.trim()
        ? localizeGeneratedNarrative(node.priorKnowledgeEvidence.trim())
        : undefined,
      diagnosticBoundary: typeof node.diagnosticBoundary === "string" && node.diagnosticBoundary.trim()
        ? localizeGeneratedNarrative(node.diagnosticBoundary.trim())
        : undefined,
      position: node.position,
    }];
  });
  const nodes = [...lessonNodes, ...prerequisiteNodes];

  const nodeIds = new Set(nodes.map((node) => node.id));
  if (prerequisiteNodes.length > 0 && Array.isArray(obj.edges)) {
    const malformedStructuredEdge = obj.edges.some((edge) =>
      !edge
      || typeof edge !== "object"
      || !(edge.type === "required-prerequisite"
        || edge.type === "supports"
        || edge.type === "application"
        || edge.type === "contrast"
        || edge.type === "transfer")
      || !(edge.strength === "required" || edge.strength === "helpful")
      || typeof edge.rationale !== "string"
      || !edge.rationale.trim(),
    );
    if (malformedStructuredEdge) {
      throw new Error("知识图谱生成失败：包含课前先修时，每条关系必须明确填写 type、strength 和 rationale。");
    }
  }
  const candidateEdges = Array.isArray(obj.edges)
    ? obj.edges.map((edge, index) => ({
          id: typeof edge.id === "string" && edge.id ? edge.id : `edge-${index + 1}`,
          source: typeof edge.source === "string" ? edge.source : "",
          target: typeof edge.target === "string" ? edge.target : "",
          label: typeof edge.label === "string" && edge.label.trim() ? localizeGeneratedNarrative(edge.label.trim()) : "关联",
          type: edge.type === "required-prerequisite"
            || edge.type === "application"
            || edge.type === "contrast"
            || edge.type === "transfer"
            ? edge.type
            : "supports" as const,
          strength: edge.strength === "helpful" ? "helpful" as const : "required" as const,
          rationale: typeof edge.rationale === "string" && edge.rationale.trim()
            ? localizeGeneratedNarrative(edge.rationale.trim())
            : typeof edge.label === "string" ? localizeGeneratedNarrative(edge.label.trim()) : "",
        }))
    : [];
  const edges = candidateEdges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target,
  );
  if (edges.length !== candidateEdges.length) {
    throw new Error("知识图谱生成失败：关系包含无效节点引用或自环。");
  }

  return { nodes, edges };
}

function applyGraphLevels(
  knowledgePoints: CourseContent["knowledgePoints"],
  graph: KnowledgeGraph,
): CourseContent["knowledgePoints"] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return knowledgePoints.map((point) => {
    const node = nodes.get(point.id);
    return {
      ...point,
      level: point.level ?? node?.level,
      masteryBoundary: point.masteryBoundary ?? node?.masteryBoundary,
      objectiveIndexes: point.objectiveIndexes ?? node?.objectiveIndexes,
    };
  });
}

export function normalizeKnowledgeGraphOutput(
  rawKnowledgePoints: unknown,
  rawKnowledgeGraph: unknown,
  teacherRequiredKnowledgePoints: readonly string[] = [],
): { knowledgePoints: CourseContent["knowledgePoints"]; knowledgeGraph: KnowledgeGraph } {
  const parsedKnowledgePoints = validateKnowledgePoints(rawKnowledgePoints);
  const knowledgeGraph = normalizeKnowledgeGraph(rawKnowledgeGraph, parsedKnowledgePoints);
  const knowledgePoints = applyGraphLevels(parsedKnowledgePoints, knowledgeGraph);
  const quality = assessKnowledgeGraphQuality(
    knowledgeGraph,
    knowledgePoints,
    teacherRequiredKnowledgePoints,
  );
  if (!quality.ok) {
    throw new Error(`知识图谱生成失败：${quality.issues.slice(0, 3).join("；")}。`);
  }
  return { knowledgePoints, knowledgeGraph };
}

function validateLessonOutline(
  raw: unknown,
  input: GenerateInput,
  context?: Partial<Pick<CourseContent, "knowledgePoints" | "knowledgeGraph" | "teachingOutline">>,
): LessonOutlineSection[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("知识讲授大纲生成失败：AI 未返回章节大纲。");
  }
  const details = raw.map((item, index) => {
    const section = item && typeof item === "object" ? item as Partial<LessonOutlineSection> : {};
    const requestedStageKey = typeof section.stageKey === "string" ? section.stageKey.trim() : "";
    const stageKey = input.pblConfig?.generationTemplate === "pbl-six-stage"
      ? normalizePblStageKey(requestedStageKey) ?? "ai-learning"
      : (requestedStageKey || input.stages[0]?.key) ?? "ai-learning";
    const parent = context?.teachingOutline?.find((activity) => activity.id === section.parentActivityId);
    const isStudentKnowledge = stageKey === "ai-learning";
    return {
      id: typeof section.id === "string" && section.id.trim() ? section.id.trim() : `lo-${index + 1}`,
      stageKey,
      title: requireText(section.title, "知识讲授大纲"),
      objectives: Array.isArray(section.objectives)
        ? section.objectives.map((objective) => localizeGeneratedNarrative(String(objective))).filter(Boolean)
        : [],
      activities: Array.isArray(section.activities)
        ? section.activities.map((activity) => localizeGeneratedNarrative(String(activity))).filter(Boolean)
        : [],
      durationMin: Number.isFinite(Number(section.durationMin)) ? Math.max(1, Number(section.durationMin)) : 1,
      parentActivityId:
        typeof section.parentActivityId === "string" && section.parentActivityId.trim()
          ? section.parentActivityId.trim()
          : undefined,
      detailKind:
        typeof section.detailKind === "string" && DETAIL_KIND_VALUES.has(section.detailKind)
          ? section.detailKind
          : undefined,
      knowledgePointIds: Array.isArray(section.knowledgePointIds)
        ? section.knowledgePointIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
        : [],
      resourceTypes: isStudentKnowledge
        ? Array.isArray(section.resourceTypes)
          ? section.resourceTypes.filter(
              (type): type is NonNullable<LessonOutlineSection["resourceTypes"]>[number] =>
                typeof type === "string" && RESOURCE_TYPE_VALUES.has(type),
            )
          : ["ppt"]
        : ["ppt", "script"],
      targetDurationSec: Number.isFinite(Number(section.targetDurationSec))
        ? Math.max(60, Number(section.targetDurationSec))
        : Math.max(60, (parent?.durationMin ?? Number(section.durationMin) ?? 1) * 60),
      ttsPolicy: isStudentKnowledge ? "target-duration" : "none",
    } satisfies LessonOutlineSection;
  });

  if (input.pblConfig?.generationTemplate !== "pbl-six-stage" || !context?.knowledgePoints?.length) {
    return details;
  }

  const aiDetails = details.filter((detail) => detail.stageKey === "ai-learning");
  const covered = new Set(aiDetails.flatMap((detail) => detail.knowledgePointIds ?? []));
  const missingPoints = context.knowledgePoints.filter((point) => !covered.has(point.id));
  if (missingPoints.length === 0 || aiDetails.length === 0) return details;

  const parentId = aiDetails[0].parentActivityId ?? context.teachingOutline?.find((activity) => activity.stageKey === "ai-learning")?.id;
  const scaffoldDetails: LessonOutlineSection[] = missingPoints.map((point) => ({
    id: `lo-knowledge-coverage-${point.id}`,
    stageKey: "ai-learning",
    title: `知识点补充：${point.name}`,
    objectives: [point.description || point.name],
    activities: [`通过一个最能体现“${point.name}”关键含义或应用边界的短案例或检查题验证理解；仅在确实有助于理解时连接项目任务。`],
    durationMin: 1,
    parentActivityId: parentId,
    detailKind: "knowledge-explanation",
    knowledgePointIds: [point.id],
    resourceTypes: ["ppt"],
    targetDurationSec: 60,
    ttsPolicy: "target-duration",
  }));
  const parentActivities = context.teachingOutline ?? [];
  return rescalePblDetailDurations<LessonOutlineSection>(
    [...details, ...scaffoldDetails],
    parentActivities,
  );
}

const RESOURCE_TYPE_VALUES = new Set([
  "ppt",
  "interactive-demo",
  "code-interactive",
  "script",
  "worksheet",
  "rubric",
  "project-brief",
]);
const DETAIL_KIND_VALUES = new Set([
  "teacher-introduction",
  "knowledge-explanation",
  "interactive-practice",
  "project-scaffold",
  "project-practice",
  "showcase-coaching",
  "reflection-transfer",
  "other",
]);

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textFromUnknown(item))
      .filter((item): item is string => Boolean(item))
      .join("；");
    return text || undefined;
  }
  const record = asJsonRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "value", "content", "description", "action", "task", "responsibility", "role", "name", "label", "key"]) {
    const text = textFromUnknown(record[key]);
    if (text) return text;
  }
  return undefined;
}

function firstValue(record: JsonRecord, keys: ReadonlyArray<string>): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function firstText(
  record: JsonRecord,
  keys: ReadonlyArray<string>,
  nestedRecords: ReadonlyArray<JsonRecord | undefined> = [],
): string | undefined {
  const values = [record, ...nestedRecords];
  for (const source of values) {
    if (!source) continue;
    for (const key of keys) {
      const text = textFromUnknown(source[key]);
      if (text) return text;
    }
  }
  return undefined;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function stringListFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,，、;；\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === "string") return stringListFromUnknown(item);
      const record = asJsonRecord(item);
      const id = record && firstText(record, ["id", "key", "value"]);
      return id ? [id] : [];
    })
    .filter(Boolean);
}

function textListFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n|[；;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textFromUnknown(item))
    .filter((item): item is string => Boolean(item));
}

export function normalizePblTimingRecommendationResponse(
  raw: unknown,
  input: GenerateInput,
  context?: Partial<Pick<CourseContent, "knowledgePoints" | "knowledgeGraph">>,
  now?: string,
): {
  teachingOutline: TeachingOutlineSection[];
  moduleTimingPlan: ReturnType<typeof buildPblModelTimingPlan>;
} {
  const parsed = typeof raw === "string" ? extractJson(raw) : raw;
  const root = asJsonRecord(parsed);
  const recommendationRecord = asJsonRecord(
    root?.moduleTimingRecommendation ??
    root?.timingRecommendation ??
    root?.moduleTimingPlan ??
    parsed,
  );
  if (!recommendationRecord) {
    throw new LlmOutputIncompleteError(
      ["moduleTimingRecommendation"],
      "课程时间建议",
    );
  }
  const allocationPayload = firstValue(recommendationRecord, [
    "allocations",
    "stages",
    "modules",
  ]);
  if (!Array.isArray(allocationPayload) || allocationPayload.length === 0) {
    throw new LlmOutputIncompleteError(
      ["moduleTimingRecommendation.allocations"],
      "课程时间建议",
    );
  }
  const allocations = allocationPayload.flatMap((item) => {
    const allocation = asJsonRecord(item);
    if (!allocation) return [];
    const stageKey = firstText(allocation, [
      "stageKey",
      "stage",
      "phase",
      "key",
      "阶段",
    ]);
    const durationMin = toFiniteNumber(
      firstValue(allocation, [
        "durationMin",
        "durationMinutes",
        "minutes",
        "duration",
        "时长",
      ]),
      Number.NaN,
    );
    if (!stageKey || !Number.isFinite(durationMin) || durationMin <= 0) {
      return [];
    }
    const rationale = firstText(allocation, [
      "rationale",
      "reason",
      "reasoning",
      "依据",
      "理由",
    ]);
    return [{
      stageKey,
      durationMin,
      ...(rationale ? { rationale: localizeGeneratedNarrative(rationale, context?.knowledgePoints ?? []) } : {}),
    }];
  });
  if (allocations.length === 0) {
    throw new LlmOutputIncompleteError(
      ["moduleTimingRecommendation.allocations.stageKey", "moduleTimingRecommendation.allocations.durationMin"],
      "课程时间建议",
    );
  }
  const confidenceValue = firstText(recommendationRecord, ["confidence", "置信度"])?.toLowerCase();
  const recommendation: PblModelTimingRecommendation = {
    allocations,
    evidence: textListFromUnknown(firstValue(recommendationRecord, ["evidence", "basis", "依据"]))
      .map((item) => localizeGeneratedNarrative(item, context?.knowledgePoints ?? [])),
    assumptions: textListFromUnknown(firstValue(recommendationRecord, ["assumptions", "假设"]))
      .map((item) => localizeGeneratedNarrative(item, context?.knowledgePoints ?? [])),
    confidence:
      confidenceValue === "low" || confidenceValue === "high"
        ? confidenceValue
        : "medium",
  };
  const totalMinutes = Math.max(0, Math.round(input.hours * 60));
  const timingContext = {
    topic: input.name,
    subject: input.subject,
    summary: input.summary,
    grade: input.grade,
    difficulty: input.pblConfig?.difficultyLevel,
    learningObjectives: input.learningObjectives,
    learnerProfile: input.learnerProfile,
    knowledgePoints: context?.knowledgePoints,
    knowledgeGraph: context?.knowledgeGraph,
  };
  const skeleton = createPblTimingSkeleton({
    totalMinutes,
    ...timingContext,
  });
  const moduleTimingPlan = buildPblModelTimingPlan(
    totalMinutes,
    skeleton,
    recommendation,
    timingContext,
    { now },
  );
  const allocationById = new Map(
    moduleTimingPlan.allocations.map((allocation) => [
      allocation.id,
      allocation.durationMin,
    ]),
  );
  return {
    teachingOutline: skeleton.map((activity) => ({
      ...activity,
      durationMin: allocationById.get(activity.id) ?? activity.durationMin,
    })),
    moduleTimingPlan,
  };
}

function unwrapTeachingOutlinePayload(raw: unknown, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      return unwrapTeachingOutlinePayload(extractJson(raw), depth + 1);
    } catch {
      return undefined;
    }
  }
  const record = asJsonRecord(raw);
  if (!record) return undefined;
  for (const key of [
    "teachingOutline",
    "teachingModules",
    "courseModules",
    "modules",
    "outline",
    "activities",
    "items",
    "课程模块",
    "授课大纲",
    "data",
    "result",
  ]) {
    if (record[key] === undefined || record[key] === null) continue;
    const payload = unwrapTeachingOutlinePayload(record[key], depth + 1);
    if (payload !== undefined) return payload;
  }
  return undefined;
}

function normalizeTeachingOutlineStageKey(
  raw: JsonRecord,
  input: GenerateInput,
  index: number,
): string {
  const requested = firstText(raw, ["stageKey", "stage_key", "stage", "phase", "moduleStage", "阶段"]);
  const fallbackStage = input.stages[Math.min(index, Math.max(0, input.stages.length - 1))]?.key;
  if (input.pblConfig?.generationTemplate === "pbl-six-stage") {
    return normalizePblStageKey(requested) ?? fallbackStage ?? "launch";
  }
  const exact = requested && input.stages.some((stage) => stage.key === requested) ? requested : undefined;
  const byLabel = requested && input.stages.find((stage) => stage.label.trim() === requested)?.key;
  return exact ?? byLabel ?? fallbackStage ?? "launch";
}

function normalizeTeachingActivityKind(value: unknown): TeachingOutlineSection["activityKind"] {
  const normalized = textFromUnknown(value)?.trim().toLowerCase();
  const aliases: Record<string, NonNullable<TeachingOutlineSection["activityKind"]>> = {
    launch: "launch",
    introduction: "launch",
    引入: "launch",
    启动: "launch",
    knowledge: "knowledge",
    teaching: "knowledge",
    授知: "knowledge",
    knowledge_teaching: "knowledge",
    proposal: "proposal",
    design: "proposal",
    构思: "proposal",
    practice: "practice",
    make: "practice",
    project_practice: "practice",
    实践: "practice",
    showcase: "showcase",
    presentation: "showcase",
    汇报: "showcase",
    reflection: "reflection",
    transfer: "reflection",
    反思: "reflection",
    other: "other",
  };
  return normalized ? aliases[normalized] : undefined;
}

/**
 * Normalize the small structural variations commonly returned by LLMs.
 * The six role fields are operationally required by the editor, so missing
 * fields receive explicit, editable defaults instead of aborting the whole
 * course generation request.
 *
 * Threshold: when a single section is missing more than 3 of its 6 role
 * fields the AI output is considered structurally incomplete and we throw
 * `LlmOutputIncompleteError` rather than silently filling >50% defaults.
 * The transparent `normalizationNote` mechanism still covers the common
 * 1–3 missing-fields case so teachers can review the auto-filled values.
 */
const MISSING_FIELDS_THRESHOLD = 3;

export function normalizeTeachingOutlineResponse(
  raw: unknown,
  input: GenerateInput,
  context?: Partial<Pick<CourseContent, "knowledgePoints" | "knowledgeGraph" | "moduleTimingPlan">>,
): TeachingOutlineSection[] {
  const payload = unwrapTeachingOutlinePayload(raw);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("授课大纲生成失败：AI 未返回教案级授课大纲。");
  }

  const parsed = payload.flatMap((item, index) => {
    const section = asJsonRecord(item);
    if (!section) return [];

    const stageKey = normalizeTeachingOutlineStageKey(section, input, index);
    const stageLabel = input.stages.find((stage) => stage.key === stageKey)?.label ?? "课程学习阶段";
    const roleRecords = [
      asJsonRecord(section.roles),
      asJsonRecord(section.responsibilities),
      asJsonRecord(section.roleAssignments),
    ];
    const missingFields: string[] = [];
    const read = (keys: ReadonlyArray<string>, label: string): string => {
      const value = firstText(section, keys, roleRecords);
      if (value) return localizeGeneratedNarrative(value, context?.knowledgePoints ?? []);
      missingFields.push(label);
      return "";
    };

    const title = read(["title", "name", "moduleName", "activityTitle", "课程模块"], "title") ||
      `${stageLabel || "课程"}模块`;
    const teachingGoal = read(
      ["teachingGoal", "teaching_goal", "goal", "objective", "teachingObjective", "教学目标"],
      "teachingGoal",
    ) || `围绕“${title}”完成本模块的核心学习任务。`;
    const teacherRole = read(
      ["teacherRole", "teacher_role", "teacher", "teacherAction", "teacherTasks", "教师职责", "教师角色"],
      "teacherRole",
    ) || `教师组织“${title}”，明确任务要求并根据学生表现进行指导。`;
    const platformRole = read(
      ["platformRole", "platform_role", "platform", "platformAction", "platformTasks", "平台职责", "平台作用"],
      "platformRole",
    ) || "平台展示本模块资源，收集过程证据并记录学习结果。";
    const aiRole = read(
      ["aiRole", "ai_role", "ai", "aiAction", "aiTasks", "AI职责", "AI作用"],
      "aiRole",
    ) || (stageKey === "ai-learning"
      ? "AI 提供分步讲解、练习与反馈，帮助学生独立完成任务，不直接给出最终答案。"
      : "AI 提供伴学提示与澄清问题，不代替学生完成项目。");
    const studentActivity = read(
      ["studentActivity", "student_activity", "student", "studentTask", "studentAction", "studentTasks", "学生活动", "学习任务"],
      "studentActivity",
    ) || `学生围绕“${title}”完成任务并提交过程证据。`;

    // Threshold check: surface a dedicated error when a section is missing
    // more than 3 of its 6 role fields. The transparent `normalizationNote`
    // path below still handles the common 1–3 missing-fields case.
    if (missingFields.length > MISSING_FIELDS_THRESHOLD) {
      throw new LlmOutputIncompleteError(
        [...missingFields],
        `第 ${index + 1} 个授课模块「${title}」`,
      );
    }

    const rawResources = firstValue(section, ["resourceTypes", "resource_types", "resources", "资源类型"]);
    const resourceTypes = stringListFromUnknown(rawResources).filter(
      (type): type is NonNullable<TeachingOutlineSection["resourceTypes"]>[number] => RESOURCE_TYPE_VALUES.has(type),
    );
    const normalizedResourceTypes: NonNullable<TeachingOutlineSection["resourceTypes"]> = resourceTypes.length > 0
      ? resourceTypes
      : stageKey === "ai-learning"
        ? ["ppt"]
        : ["ppt", "script"];
    const rawKnowledgePointIds = firstValue(section, [
      "knowledgePointIds",
      "knowledge_point_ids",
      "knowledgeIds",
      "knowledgePoints",
      "知识点ID",
    ]);
    const knowledgePointIds = stringListFromUnknown(rawKnowledgePointIds);
    const requestedOpenMaicUse = firstText(section, ["openMaicUse", "openMAICUse", "openmaicUse", "aiRoute", "route"]);
    const openMaicUse = requestedOpenMaicUse === "student-ai-learning" || requestedOpenMaicUse === "student_ai_learning"
      ? "student-ai-learning"
      : stageKey === "ai-learning"
        ? "student-ai-learning"
        : "none";
    const durationMin = Math.max(
      1,
      Math.round(toFiniteNumber(firstValue(section, ["durationMin", "durationMinutes", "duration", "minutes", "时长"]), 1)),
    );
    const notesValue = firstText(section, ["notes", "note", "remarks", "备注"]);
    const notes = notesValue ? localizeGeneratedNarrative(notesValue, context?.knowledgePoints ?? []) : undefined;
    const normalizationNote = missingFields.length > 0
      ? `AI 输出缺少字段（${missingFields.join("、")}），系统已补全，请教师核查。`
      : undefined;

    return [{
      id: firstText(section, ["id", "moduleId", "activityId"]) ?? `to-${index + 1}`,
      stageKey,
      title,
      durationMin,
      teachingGoal,
      teacherRole,
      platformRole,
      aiRole,
      studentActivity,
      activityKind: normalizeTeachingActivityKind(firstValue(section, ["activityKind", "activity_kind", "kind", "type", "活动类型"])),
      knowledgePointIds,
      openMaicUse,
      resourceTypes: normalizedResourceTypes,
      notes: [notes, normalizationNote].filter(Boolean).join("；"),
    } satisfies TeachingOutlineSection];
  });

  if (parsed.length === 0) {
    throw new Error("授课大纲生成失败：AI 未返回可用课程模块。");
  }

  if (input.pblConfig?.generationTemplate !== "pbl-six-stage") return parsed;
  const options = {
    totalMinutes: Math.max(0, Math.round(input.hours * 60)),
    topic: input.name,
    subject: input.subject,
    summary: input.summary,
    grade: input.grade,
    difficulty: input.pblConfig.difficultyLevel,
    knowledgePoints: context?.knowledgePoints,
    knowledgeGraph: context?.knowledgeGraph,
  };
  const normalized = context?.moduleTimingPlan
    && isPblModuleTimingPlanConfirmed(context.moduleTimingPlan)
    ? applyConfirmedPblTimingPlan(parsed, context.moduleTimingPlan, options)
    : normalizePblTeachingOutline(parsed, options);
  const structureIssues = assessPblTeachingOutlineStructure(normalized);
  if (structureIssues.length > 0) {
    throw new Error(`授课大纲结构校验失败：${structureIssues.map((issue) => issue.message).join("；")}`);
  }
  return normalized;
}

function validateTeachingOutline(
  raw: unknown,
  input: GenerateInput,
  context?: Partial<Pick<CourseContent, "knowledgePoints" | "knowledgeGraph">>,
): TeachingOutlineSection[] {
  return normalizeTeachingOutlineResponse(raw, input, context);
}

export function normalizeEvaluationPlanOutput(raw: unknown, fallback?: EvaluationPlan): EvaluationPlan {
  const plan = unwrapEvaluationPlanRecord(raw);
  const rawDimensions = Array.isArray(plan.dimensions) && plan.dimensions.length > 0
    ? plan.dimensions
    : fallback?.dimensions;
  if (!Array.isArray(rawDimensions) || rawDimensions.length === 0) {
    throw new Error("评价方案生成失败：AI 未返回评价维度。");
  }

  type RawDimension = Record<string, unknown>;
  const parsed = (rawDimensions as RawDimension[]).map((dimension, index) => {
    // Accept common field name aliases for "name"
    const name =
      pickString(dimension, ["name", "title", "dimensionName", "维度名称", "label"]) ??
      "";
    if (!name) {
      throw new Error(`评价方案生成失败：第 ${index + 1} 个维度缺少名称字段（name）。`);
    }

    // Parse weight: accept number, numeric string, or "20%" format
    const weight = parseWeight(dimension);

    // Accept common field name aliases for "description"
    const description =
      pickString(dimension, ["description", "desc", "说明", "标准", "criteria"]) ?? "";

    // Accept common field name aliases for "responsibleRole"
    const roleRaw = pickString(dimension, ["responsibleRole", "role", "负责人", "评价方"]);
    const responsibleRole: "ai" | "teacher" | undefined =
      roleRaw === "ai" || roleRaw === "teacher"
        ? roleRaw
        : roleRaw === "AI" || roleRaw === "ai过程" || roleRaw === "AI过程"
          ? "ai"
          : roleRaw === "教师" || roleRaw === "teacher"
            ? "teacher"
            : undefined;

    const id =
      typeof dimension.id === "string" && dimension.id.trim()
        ? dimension.id.trim()
        : `ev-${index + 1}`;

    return {
      id,
      name: localizeGeneratedNarrative(name),
      weight,
      description: localizeGeneratedNarrative(description),
      responsibleRole,
    };
  });

  const overallRubric =
    pickString(plan, ["overallRubric", "rubric", "整体评价", "评价说明"])
    ?? fallback?.overallRubric
    ?? "";

  const parsedFlows = parseEvaluationFlows(plan.flows);

  return {
    dimensions: parsed,
    overallRubric: localizeGeneratedNarrative(overallRubric),
    flows: parsedFlows ?? fallback?.flows,
  };
}

function unwrapEvaluationPlanRecord(raw: unknown): Record<string, unknown> {
  let current = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  for (let depth = 0; depth < 3 && !Array.isArray(current.dimensions); depth += 1) {
    const direct = current.evaluationPlan ?? current.revised;
    const content = current.content && typeof current.content === "object" && !Array.isArray(current.content)
      ? current.content as Record<string, unknown>
      : undefined;
    const nested = direct ?? content?.evaluationPlan;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break;
    current = nested as Record<string, unknown>;
  }
  return current;
}

function parseEvaluationFlows(raw: unknown): EvaluationPlan["flows"] {
  if (!Array.isArray(raw)) return undefined;
  const defaults = new Map(DEFAULT_EVALUATION_FLOWS.map((flow) => [flow.sourceRole, flow]));
  const parsed = raw.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const flow = value as Record<string, unknown>;
    const sourceRole = pickString(flow, ["sourceRole", "role", "评价方"]);
    if (sourceRole !== "ai" && sourceRole !== "teacher") return [];
    const fallback = defaults.get(sourceRole)!;
    const evidence = Array.isArray(flow.evidenceRequirements)
      ? flow.evidenceRequirements.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => localizeGeneratedNarrative(item.trim()))
      : [...fallback.evidenceRequirements];
    return [{
      id: pickString(flow, ["id"]) ?? `evaluation-${sourceRole}-${index + 1}`,
      sourceRole: sourceRole as "ai" | "teacher",
      name: localizeGeneratedNarrative(pickString(flow, ["name", "title"]) ?? fallback.name),
      weight: parseWeight(flow),
      evidenceRequirements: evidence,
      enabled: flow.enabled !== false,
      scored: flow.scored !== false,
    }];
  });
  const aiWeight = parsed.filter((flow) => flow.sourceRole === "ai").reduce((sum, flow) => sum + flow.weight, 0);
  const teacherWeight = parsed.filter((flow) => flow.sourceRole === "teacher").reduce((sum, flow) => sum + flow.weight, 0);
  if (aiWeight <= 0 || teacherWeight <= 0) return undefined;
  return parsed;
}

/** Try multiple keys on a record and return the first non-empty string value. */
function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

/** Parse a weight value that may be a number, numeric string, or "20%" format. */
function parseWeight(dimension: Record<string, unknown>): number {
  const raw = dimension.weight ?? dimension["权重"] ?? dimension["percentage"] ?? dimension["ratio"];
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[%％]/g, "").trim();
    const num = Number(cleaned);
    if (!Number.isNaN(num)) return num;
  }
  return 0;
}

/**
 * 补全 AI 授知页面缺失的知识点关联。
 *
 * 与 classroom-generation 的 repairPblKnowledgeReferences 同理:分步生成的
 * 大纲校验只要求知识点全覆盖,允许导学等概述页面不带 knowledgePointIds,
 * 而完整课程校验(requireReferences)要求每个授知页面都有关联。两级校验
 * 不一致会导致同一份大纲在后续阶段硬失败,这里统一在强校验前补全:优先
 * 继承所属课程模块的知识点,无父模块时回退关联全部知识点。
 */
function repairMissingKnowledgeReferences(
  details: LessonOutlineSection[],
  teachingOutline: TeachingOutlineSection[],
  knowledgePoints: CourseContent["knowledgePoints"],
): LessonOutlineSection[] {
  return details.map((detail) => {
    if (detail.stageKey !== "ai-learning") return detail;
    if ((detail.knowledgePointIds ?? []).length > 0) return detail;
    const parent = teachingOutline.find((activity) => activity.id === detail.parentActivityId);
    const inherited = (parent?.knowledgePointIds ?? []).filter(Boolean);
    const fallbackIds = inherited.length > 0
      ? inherited
      : knowledgePoints.map((point) => point.id).filter(Boolean);
    if (fallbackIds.length === 0) return detail;
    return { ...detail, knowledgePointIds: fallbackIds };
  });
}

function validateFullCourse(json: unknown, input: GenerateInput): CourseContent {
  const data = json && typeof json === "object" ? json as Partial<CourseContent> : {};
  const { knowledgePoints, knowledgeGraph } = normalizeKnowledgeGraphOutput(
    data.knowledgePoints,
    data.knowledgeGraph,
  );
  const teachingOutline = data.teachingOutline
    ? validateTeachingOutline(data.teachingOutline, input, { knowledgePoints, knowledgeGraph })
    : [];
  let lessonOutline = validateLessonOutline(data.lessonOutline, input, {
    knowledgePoints,
    knowledgeGraph,
    teachingOutline,
  });
  if (input.pblConfig?.generationTemplate === "pbl-six-stage") {
    lessonOutline = repairMissingKnowledgeReferences(lessonOutline, teachingOutline, knowledgePoints);
    const activityIds = new Set(teachingOutline.map((activity) => activity.id));
    const orphanDetails = lessonOutline.filter(
      (detail) => !detail.parentActivityId || !activityIds.has(detail.parentActivityId),
    );
    if (orphanDetails.length > 0) {
      throw new Error("课程大纲生成失败：存在未关联课程模块的资源。");
    }
    const studentDetails = lessonOutline.filter((detail) => detail.stageKey === "ai-learning");
    const knowledgeValidation = validatePblKnowledgeAlignment(
      studentDetails,
      knowledgePoints,
      { requireReferences: true, requireCoverage: true },
    );
    if (knowledgeValidation.issues.length > 0) {
      throw new Error(
        `课程大纲知识点校验失败：${knowledgeValidation.issues[0]?.message ?? "请检查知识点关联。"}`,
      );
    }
  }
  return {
    pblOutline: requireText(data.pblOutline, "PBL 大纲"),
    knowledgePoints,
    knowledgeGraph,
    teachingOutline,
    lessonOutline,
    evaluationPlan: normalizeEvaluationPlanOutput(data.evaluationPlan),
  };
}

export async function generateCourseContent(
  request: LlmCallRequest,
  opts?: { signal?: AbortSignal },
): Promise<LlmCallResponse> {
  const { action, input } = request;

  if (!(await isActiveLlmConfigured())) throw new LlmNotConfiguredError();

  let system = "";
  let user = "";
  switch (action) {
    case "pblOutline": {
      const prompt = buildPblOutlinePrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "lessonOutline": {
      const prompt = buildLessonOutlinePrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "teachingOutline": {
      const prompt = buildTeachingOutlinePrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "knowledgeGraph": {
      const prompt = buildKnowledgeGraphPrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "moduleTimingPlan": {
      const prompt = buildModuleTimingPlanPrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "evaluationPlan": {
      const prompt = buildEvaluationPlanPrompt(input, request.context);
      system = prompt.system;
      user = prompt.user;
      break;
    }
    case "fullCourse": {
      const prompt = buildFullCoursePrompt(input);
      system = prompt.system;
      user = prompt.user;
      break;
    }
  }

  const text = await callChatCompletions(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      jsonMode: true,
      abortSignal: opts?.signal,
      requestClass: requestClassForCourseContentAction(action),
      maxTransientRetries: DURABLE_GENERATION_TRANSIENT_RETRIES,
    },
  );

  const json = extractJson(text);

  if (action === "pblOutline") {
    return {
      content: { ...emptyCourseContent(), pblOutline: requireText((json as { pblOutline?: unknown }).pblOutline, "PBL 大纲") },
      source: "llm",
    };
  }
  if (action === "lessonOutline") {
    return {
      content: {
        ...emptyCourseContent(),
        lessonOutline: validateLessonOutline(
          (json as { lessonOutline?: unknown }).lessonOutline,
          input,
          request.context,
        ),
      },
      source: "llm",
    };
  }
  if (action === "teachingOutline") {
    const jsonRecord = asJsonRecord(json);
    return {
      content: {
        ...emptyCourseContent(),
        pblOutline:
          typeof jsonRecord?.pblOutline === "string"
            ? localizeGeneratedNarrative(jsonRecord.pblOutline.trim(), request.context?.knowledgePoints ?? [])
            : "",
        teachingOutline: normalizeTeachingOutlineResponse(
          json,
          input,
          request.context,
        ),
      },
      source: "llm",
    };
  }
  if (action === "knowledgeGraph") {
    const { knowledgePoints, knowledgeGraph } = normalizeKnowledgeGraphOutput(
      (json as { knowledgePoints?: unknown }).knowledgePoints,
      (json as { knowledgeGraph?: unknown }).knowledgeGraph,
      request.context?.teacherRequiredKnowledgePoints,
    );
    return {
      content: {
        ...emptyCourseContent(),
        knowledgePoints,
        knowledgeGraph,
      },
      source: "llm",
    };
  }
  if (action === "moduleTimingPlan") {
    const result = normalizePblTimingRecommendationResponse(
      json,
      input,
      request.context,
    );
    return {
      content: {
        ...emptyCourseContent(),
        teachingOutline: result.teachingOutline,
        moduleTimingPlan: result.moduleTimingPlan,
      },
      source: "llm",
    };
  }
  if (action === "evaluationPlan") {
    return {
      content: { ...emptyCourseContent(), evaluationPlan: normalizeEvaluationPlanOutput((json as { evaluationPlan?: unknown }).evaluationPlan) },
      source: "llm",
    };
  }
  return { content: validateFullCourse(json, input), source: "llm" };
}
