import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  CourseQualityLabStorage,
  DEFAULT_LAB_ROOT,
  LabStorageError,
} from "./storage";
import type {
  CourseQualityLabManifest,
  LabModuleMetrics,
  LabPair,
  LabPipelineModule,
  LabRepairEvent,
  LabTokenUsageSource,
  LabVariantKey,
  LabVariantMetrics,
  LabVariantResult,
  PairReview,
  ReviewCollection,
  ReviewDimension,
  ReviewOutcome,
} from "./types";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUILD_DIR = path.join(MODULE_DIR, "dist");
const MAX_REVIEW_BYTES = 256 * 1024;
const PAIR_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u;
const OUTCOMES = new Set<ReviewOutcome>(["baseline", "enhanced", "tie", "undecided"]);
const DIMENSIONS = new Set<ReviewDimension>([
  "explanationDepth",
  "examples",
  "teachingAssessmentAlignment",
  "visualExpression",
  "listeningExperience",
]);

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

type Log = Pick<Console, "info" | "error">;

export interface CourseQualityLabServerOptions {
  rootDir?: string;
  buildDir?: string;
  logger?: Log;
  startGenerationRetry?: (input: {
    rootDir: string;
    sectionId: string;
    pair: LabPair;
    variant: LabVariantKey;
  }) => Promise<{ pid?: number }>;
}

type PublicError = Error & { status?: number; code?: string };

function publicError(status: number, code: string, message: string): PublicError {
  const error = new Error(message) as PublicError;
  error.status = status;
  error.code = code;
  return error;
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  response.setHeader("Cache-Control", "no-store");
  applyCommonHeaders(response);
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
  fileName?: string,
): void {
  const bytes = Buffer.from(body);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", bytes.length);
  response.setHeader("Cache-Control", "no-store");
  if (fileName) response.setHeader("Content-Disposition", contentDisposition(fileName));
  applyCommonHeaders(response);
  response.end(bytes);
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function decodeRoutePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw publicError(400, "INVALID_PATH", "请求路径编码无效。");
  }
}

function decodeSegments(encodedPath: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    throw publicError(400, "INVALID_PATH", "文件路径编码无效。");
  }
  if (
    !decoded
    || decoded.includes("\0")
    || decoded.includes("\\")
    || path.posix.isAbsolute(decoded)
  ) {
    throw publicError(400, "INVALID_PATH", "文件路径无效。");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw publicError(400, "INVALID_PATH", "文件路径无效。");
  }
  return segments;
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolves an existing file and prevents traversal through a symlink. */
export async function resolveExistingFile(baseDir: string, encodedPath: string): Promise<string> {
  const segments = decodeSegments(encodedPath);
  let baseReal: string;
  try {
    baseReal = await realpath(baseDir);
  } catch {
    throw publicError(404, "FILE_NOT_FOUND", "文件尚未生成。");
  }
  const candidate = path.resolve(baseReal, ...segments);
  if (!isWithin(baseReal, candidate)) throw publicError(400, "INVALID_PATH", "文件路径无效。");
  let resolved: string;
  try {
    resolved = await realpath(candidate);
    const info = await lstat(resolved);
    if (!info.isFile()) throw publicError(404, "FILE_NOT_FOUND", "文件尚未生成。");
  } catch (error) {
    if ((error as PublicError).status) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw publicError(404, "FILE_NOT_FOUND", "文件尚未生成。");
    }
    throw error;
  }
  if (!isWithin(baseReal, resolved)) throw publicError(403, "PATH_ESCAPE", "拒绝访问实验目录外的文件。");
  return resolved;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw publicError(416, "INVALID_RANGE", "请求的文件范围无效。");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw publicError(416, "INVALID_RANGE", "请求的文件范围无效。");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw publicError(416, "INVALID_RANGE", "请求的文件范围无效。");
  }
  return { start, end: Math.min(end, size - 1) };
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  options: { attachmentName?: string; immutable?: boolean } = {},
): Promise<void> {
  const info = await stat(filePath);
  const range = parseRange(request.headers.range, info.size);
  const etag = `W/\"${info.size}-${Math.trunc(info.mtimeMs)}\"`;
  if (!range && request.headers["if-none-match"] === etag) {
    response.statusCode = 304;
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, info.size - 1);
  response.statusCode = range ? 206 : 200;
  response.setHeader("Content-Type", MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("Content-Length", info.size === 0 ? 0 : end - start + 1);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", options.immutable ? "public, max-age=31536000, immutable" : "no-cache");
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  if (options.attachmentName) response.setHeader("Content-Disposition", contentDisposition(options.attachmentName));
  applyCommonHeaders(response);
  if (request.method === "HEAD" || info.size === 0) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", reject);
    stream.on("end", resolve);
    response.on("close", resolve);
    stream.pipe(response);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw publicError(415, "JSON_REQUIRED", "评判保存接口只接受 JSON。");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > MAX_REVIEW_BYTES) throw publicError(413, "BODY_TOO_LARGE", "评判内容超过 256 KB。");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw publicError(400, "INVALID_JSON", "评判内容不是有效的 JSON。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateReview(value: unknown, pairId: string, pair: LabPair): PairReview {
  if (!isRecord(value)) throw publicError(400, "INVALID_REVIEW", "评判内容格式无效。");
  if (value.pairId !== undefined && value.pairId !== pairId) {
    throw publicError(400, "PAIR_ID_MISMATCH", "请求路径与评判内容中的 pairId 不一致。");
  }
  if (!OUTCOMES.has(value.outcome as ReviewOutcome)) {
    throw publicError(400, "INVALID_REVIEW", "请选择有效的小节评判结果。");
  }
  if (!isRecord(value.dimensions)) throw publicError(400, "INVALID_REVIEW", "评价维度格式无效。");
  const dimensions: PairReview["dimensions"] = {};
  for (const [key, score] of Object.entries(value.dimensions)) {
    if (!DIMENSIONS.has(key as ReviewDimension) || typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
      throw publicError(400, "INVALID_REVIEW", "评价维度只能使用 1 到 5 的整数分值。");
    }
    dimensions[key as ReviewDimension] = score;
  }
  if (!isRecord(value.pageNotes)) throw publicError(400, "INVALID_REVIEW", "逐页备注格式无效。");
  const pageNotes: Record<string, string> = {};
  for (const [index, note] of Object.entries(value.pageNotes)) {
    if (!/^(0|[1-9]\d{0,3})$/.test(index) || typeof note !== "string" || note.length > 10_000) {
      throw publicError(400, "INVALID_REVIEW", "逐页备注的页码或内容无效。");
    }
    pageNotes[index] = note;
  }
  if (value.overallNote !== undefined && (typeof value.overallNote !== "string" || value.overallNote.length > 50_000)) {
    throw publicError(400, "INVALID_REVIEW", "总体备注格式无效。");
  }
  const teacherReviews: PairReview["teacherReviews"] = {};
  if (value.teacherReviews !== undefined) {
    if (!isRecord(value.teacherReviews)) throw publicError(400, "INVALID_REVIEW", "教师审核记录格式无效。");
    for (const [variantKey, rawReview] of Object.entries(value.teacherReviews)) {
      if ((variantKey !== "baseline" && variantKey !== "enhanced") || !isRecord(rawReview)) {
        throw publicError(400, "INVALID_REVIEW", "教师审核方案格式无效。");
      }
      const variant = variantKey as LabVariantKey;
      if (typeof rawReview.experimentId !== "string" || rawReview.experimentId !== pair.experimentId
        || rawReview.variant !== variant || !isRecord(rawReview.notes)) {
        throw publicError(400, "INVALID_REVIEW", "教师审核记录与当前实验或方案不匹配。");
      }
      const allowedIds = new Set((pair.variants[variant].teacherReviewNotes ?? []).map((note) => note.id));
      const notes: NonNullable<NonNullable<PairReview["teacherReviews"]>[LabVariantKey]>["notes"] = {};
      for (const [noteId, rawDecision] of Object.entries(rawReview.notes)) {
        if (!allowedIds.has(noteId) || !isRecord(rawDecision)
          || !["pending", "confirmed", "needs-revision"].includes(String(rawDecision.status))
          || (rawDecision.note !== undefined
            && (typeof rawDecision.note !== "string" || rawDecision.note.length > 10_000))) {
          throw publicError(400, "INVALID_REVIEW", "教师审核疑点、状态或备注无效。");
        }
        notes[noteId] = {
          status: rawDecision.status as "pending" | "confirmed" | "needs-revision",
          ...(typeof rawDecision.note === "string" ? { note: rawDecision.note } : {}),
        };
      }
      teacherReviews[variant] = {
        experimentId: rawReview.experimentId,
        variant,
        notes,
      };
    }
  }
  return {
    pairId,
    outcome: value.outcome as ReviewOutcome,
    dimensions,
    pageNotes,
    ...(typeof value.overallNote === "string" ? { overallNote: value.overallNote } : {}),
    ...(Object.keys(teacherReviews).length ? { teacherReviews } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function allPairs(manifest: CourseQualityLabManifest): LabPair[] {
  return manifest.sections.flatMap((section) => section.pairs);
}

type ModelCallRecord = {
  kind?: unknown;
  module?: unknown;
  stageId?: unknown;
  startedAt?: unknown;
  elapsedMs?: unknown;
  status?: unknown;
  systemChars?: unknown;
  userChars?: unknown;
  outputChars?: unknown;
  tokenUsage?: unknown;
  tokenUsageSource?: unknown;
  retryReason?: unknown;
  attempts?: Array<{
    status?: unknown;
    startedAt?: unknown;
  }>;
};

type TtsCallMetricRecord = {
  elapsedMs?: unknown;
  status?: unknown;
  cacheHit?: unknown;
  audioBytes?: unknown;
};

type GenerationTelemetryRecord = {
  startedAt?: unknown;
  completedAt?: unknown;
  checkpointReuses?: unknown;
  qualityRepairCalls?: unknown;
  firstPassPages?: unknown;
  evaluatedPages?: unknown;
  deterministicAdjustments?: unknown;
  pipelineVersion?: unknown;
  artifactVersions?: unknown;
  repairEvents?: unknown;
};

const PIPELINE_MODULES = new Set<LabPipelineModule>([
  "planning",
  "slide",
  "narration",
  "action",
  "review",
  "repair",
  "quiz",
  "tts",
]);
const REPAIR_SCOPES = new Set(["element", "segment", "page", "section"]);
const REPAIR_OUTCOMES = new Set(["resolved", "no-progress", "regressed", "escalated", "failed"]);

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function estimateTokens(characters: number): number {
  return characters > 0 ? Math.ceil(characters / 2.5) : 0;
}

function modelCallModule(call: ModelCallRecord): LabPipelineModule | undefined {
  if (typeof call.module === "string" && PIPELINE_MODULES.has(call.module as LabPipelineModule)) {
    return call.module as LabPipelineModule;
  }
  const hint = `${typeof call.kind === "string" ? call.kind : ""} ${typeof call.stageId === "string" ? call.stageId : ""}`.toLowerCase();
  if (/\b(?:planning|plan|design)\b/.test(hint)) return "planning";
  if (/\brepair\b/.test(hint)) return "repair";
  if (/\b(?:narration|script|speech)\b/.test(hint)) return "narration";
  if (/\b(?:action|animation)\b/.test(hint)) return "action";
  if (/\b(?:review|audit|check)\b/.test(hint)) return "review";
  if (/\bquiz\b/.test(hint)) return "quiz";
  if (/\bslide\b/.test(hint)) return "slide";
  return undefined;
}

function callTokenSource(call: ModelCallRecord): "provider" | "estimated" | "mixed" | "unknown" {
  return call.tokenUsageSource === "provider"
    || call.tokenUsageSource === "estimated"
    || call.tokenUsageSource === "mixed"
    ? call.tokenUsageSource
    : "unknown";
}

function aggregateTokenSource(calls: readonly ModelCallRecord[]): LabTokenUsageSource {
  if (!calls.length) return "unknown";
  const sources = new Set(calls.map(callTokenSource));
  if (sources.size !== 1) return "mixed";
  const source = [...sources][0];
  return source === "provider" ? "provider-reported" : source;
}

function tokenUsageForCall(call: ModelCallRecord): number {
  if (typeof call.tokenUsage === "number" && Number.isFinite(call.tokenUsage) && call.tokenUsage >= 0) {
    return Math.round(call.tokenUsage);
  }
  return estimateTokens(
    finiteNonNegative(call.systemChars)
    + finiteNonNegative(call.userChars)
    + finiteNonNegative(call.outputChars),
  );
}

function summarizeModelModule(calls: readonly ModelCallRecord[]): LabModuleMetrics {
  const attempts = calls.flatMap((call) => call.attempts ?? [])
    .filter((attempt) => typeof attempt.startedAt === "string" && attempt.status !== "queued");
  return {
    tokenUsage: calls.reduce((sum, call) => sum + tokenUsageForCall(call), 0),
    tokenUsageSource: aggregateTokenSource(calls),
    inputCharacters: calls.reduce((sum, call) => sum
      + finiteNonNegative(call.systemChars)
      + finiteNonNegative(call.userChars), 0),
    outputCharacters: calls.reduce((sum, call) => sum + finiteNonNegative(call.outputChars), 0),
    calls: calls.length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    transportAttempts: attempts.length,
    transportRetries: calls.reduce((total, call) => {
      const started = (call.attempts ?? [])
        .filter((attempt) => typeof attempt.startedAt === "string" && attempt.status !== "queued").length;
      return total + Math.max(0, started - 1);
    }, 0),
    elapsedMs: calls.reduce((sum, call) => sum + finiteNonNegative(call.elapsedMs), 0),
  };
}

function sanitizeTelemetryText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, maxLength);
  if (!text) return undefined;
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]");
}

function sanitizeRepairEvents(value: unknown): LabRepairEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events = value.flatMap((raw): LabRepairEvent[] => {
    if (!isRecord(raw) || typeof raw.scope !== "string" || !REPAIR_SCOPES.has(raw.scope)
      || typeof raw.outcome !== "string" || !REPAIR_OUTCOMES.has(raw.outcome)) return [];
    const moduleName = sanitizeTelemetryText(raw.module, 64);
    const reason = sanitizeTelemetryText(raw.reason, 500);
    if (!moduleName || !reason) return [];
    const targetIds = Array.isArray(raw.targetIds)
      ? raw.targetIds.flatMap((target) => {
        const safe = sanitizeTelemetryText(target, 160);
        return safe ? [safe] : [];
      }).slice(0, 100)
      : [];
    return [{
      module: moduleName,
      scope: raw.scope as LabRepairEvent["scope"],
      reason,
      targetIds,
      outcome: raw.outcome as LabRepairEvent["outcome"],
      attempt: Math.max(0, Math.trunc(finiteNonNegative(raw.attempt))),
    }];
  });
  return events.length ? events : undefined;
}

function sanitizeArtifactVersions(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, version]) => {
    const safeKey = sanitizeTelemetryText(key, 100);
    const safeVersion = sanitizeTelemetryText(version, 100);
    return safeKey && safeVersion ? [[safeKey, safeVersion] as const] : [];
  }).slice(0, 100);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

async function readOptionalJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(value) ? value as T[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function runtimeIdentity(
  rootDir: string,
  sectionId: string,
  batch: number,
  variantKey: LabVariantKey,
  result: LabVariantResult,
): { runDir: string; designDir?: string; legacyDesignDir?: string; oldestDesignDir?: string } | undefined {
  const artifactUrl = result.artifactBaseUrl ?? result.downloads?.script?.replace(/\/script\.txt$/, "");
  if (!artifactUrl?.startsWith("/files/artifacts/")) return undefined;
  const encodedRelative = artifactUrl.slice("/files/artifacts/".length);
  let relative: string;
  try {
    relative = decodeURIComponent(encodedRelative);
  } catch {
    return undefined;
  }
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  const runDir = path.join(rootDir, "runs", ...segments);
  const tail = segments.slice(-3);
  const hasExpectedTail = tail[0] === sectionId
    && tail[1] === String(batch)
    && tail[2] === variantKey;
  const experimentSegments = hasExpectedTail ? segments.slice(0, -3) : [];
  const declaredPipelineVersion = result.pipelineVersion ?? result.metrics?.pipelineVersion;
  const safePipelineVersion = typeof declaredPipelineVersion === "string"
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(declaredPipelineVersion)
    ? declaredPipelineVersion
    : undefined;
  const batchDesignDir = experimentSegments.length > 0
    ? path.join(rootDir, "designs", ...experimentSegments, sectionId, String(batch))
    : undefined;
  const designDir = batchDesignDir && safePipelineVersion
    ? path.join(batchDesignDir, safePipelineVersion)
    : batchDesignDir;
  const legacyDesignDir = experimentSegments.length > 0
    ? (safePipelineVersion
      ? batchDesignDir
      : path.join(rootDir, "designs", ...experimentSegments, sectionId))
    : undefined;
  const oldestDesignDir = experimentSegments.length > 0 && safePipelineVersion
    ? path.join(rootDir, "designs", ...experimentSegments, sectionId)
    : undefined;
  return { runDir, designDir, legacyDesignDir, oldestDesignDir };
}

function summarizeMetrics(
  generationCalls: readonly ModelCallRecord[],
  designCalls: readonly ModelCallRecord[],
  ttsCalls: readonly TtsCallMetricRecord[],
  telemetry?: GenerationTelemetryRecord,
): LabVariantMetrics {
  const modelCalls = [...designCalls, ...generationCalls];
  const requestAttempts = modelCalls.flatMap((call) => call.attempts ?? [])
    .filter((attempt) => typeof attempt.startedAt === "string" && attempt.status !== "queued");
  const transportRetries = modelCalls.reduce((total, call) => {
    const started = (call.attempts ?? [])
      .filter((attempt) => typeof attempt.startedAt === "string" && attempt.status !== "queued").length;
    return total + Math.max(0, started - 1);
  }, 0);
  const startedAtCandidates = [
    typeof telemetry?.startedAt === "string" ? Date.parse(telemetry.startedAt) : Number.NaN,
    ...modelCalls.flatMap((call) => typeof call.startedAt === "string" ? [Date.parse(call.startedAt)] : []),
  ].filter(Number.isFinite);
  const startedAt = startedAtCandidates.length ? Math.min(...startedAtCandidates) : Number.NaN;
  const completedAt = typeof telemetry?.completedAt === "string" ? Date.parse(telemetry.completedAt) : Number.NaN;
  const tokenUsageSource = aggregateTokenSource(modelCalls);
  const tokenUsage = modelCalls.reduce((total, call) => total + tokenUsageForCall(call), 0);
  const moduleMetrics: Partial<Record<LabPipelineModule, LabModuleMetrics>> = {};
  for (const moduleName of PIPELINE_MODULES) {
    if (moduleName === "tts") continue;
    const calls = modelCalls.filter((call) => modelCallModule(call) === moduleName);
    if (calls.length) moduleMetrics[moduleName] = summarizeModelModule(calls);
  }
  if (ttsCalls.length) {
    moduleMetrics.tts = {
      tokenUsage: 0,
      tokenUsageSource: "unknown",
      inputCharacters: 0,
      outputCharacters: 0,
      calls: ttsCalls.length,
      failedCalls: ttsCalls.filter((call) => call.status === "failed").length,
      transportAttempts: ttsCalls.length,
      transportRetries: 0,
      elapsedMs: ttsCalls.reduce((sum, call) => sum + finiteNonNegative(call.elapsedMs), 0),
    };
  }
  const repairEvents = sanitizeRepairEvents(telemetry?.repairEvents);
  const pipelineVersion = sanitizeTelemetryText(telemetry?.pipelineVersion, 100);
  const artifactVersions = sanitizeArtifactVersions(telemetry?.artifactVersions);
  const firstPassPages = optionalFiniteNonNegative(telemetry?.firstPassPages);
  const evaluatedPages = optionalFiniteNonNegative(telemetry?.evaluatedPages);
  const deterministicAdjustments = optionalFiniteNonNegative(telemetry?.deterministicAdjustments);
  const invalidOutputRetries = modelCalls.filter((call) => call.retryReason === "invalid-output").length;
  const technicalFailureStages = new Set(modelCalls
    .filter((call) => call.status === "failed")
    .flatMap((call) => typeof call.stageId === "string" ? [call.stageId] : [])).size;
  return {
    tokenUsage,
    tokenUsageSource,
    tokenUsageEstimated: tokenUsageSource !== "provider-reported",
    inputCharacters: modelCalls.reduce((sum, call) => sum
      + finiteNonNegative(call.systemChars)
      + finiteNonNegative(call.userChars), 0),
    outputCharacters: modelCalls.reduce((sum, call) => sum + finiteNonNegative(call.outputChars), 0),
    modelCalls: modelCalls.length,
    failedModelCalls: modelCalls.filter((call) => call.status === "failed").length,
    transportAttempts: requestAttempts.length,
    transportRetries,
    invalidOutputRetries,
    technicalFailureStages,
    transportAttemptsRecorded: modelCalls.some((call) => Array.isArray(call.attempts)),
    qualityRepairCalls: finiteNonNegative(telemetry?.qualityRepairCalls) || repairEvents?.length || 0,
    ...(firstPassPages !== undefined
      ? { firstPassPages }
      : {}),
    ...(evaluatedPages !== undefined
      ? { evaluatedPages }
      : {}),
    ...(deterministicAdjustments !== undefined
      ? { deterministicAdjustments }
      : {}),
    abandonedModelCalls: modelCalls.filter((call) => call.status === "abandoned").length,
    checkpointReuses: finiteNonNegative(telemetry?.checkpointReuses),
    telemetryRecorded: Boolean(telemetry),
    wallClockMs: Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0,
    modelElapsedMs: modelCalls.reduce((sum, call) => sum + finiteNonNegative(call.elapsedMs), 0),
    designCalls: designCalls.length,
    generationCalls: generationCalls.length,
    ttsCalls: ttsCalls.length,
    failedTtsCalls: ttsCalls.filter((call) => call.status === "failed").length,
    ttsElapsedMs: ttsCalls.reduce((sum, call) => sum + finiteNonNegative(call.elapsedMs), 0),
    ttsCacheHits: ttsCalls.filter((call) => call.cacheHit === true).length,
    audioBytes: ttsCalls.reduce((sum, call) => sum + finiteNonNegative(call.audioBytes), 0),
    ...(Object.keys(moduleMetrics).length ? { moduleMetrics } : {}),
    ...(repairEvents ? { repairEvents } : {}),
    ...(pipelineVersion ? { pipelineVersion } : {}),
    ...(artifactVersions ? { artifactVersions } : {}),
  };
}

/** Adds cost/stability metrics from private runtime logs without exposing call prompts or provider secrets. */
export async function withRuntimeMetrics(
  rootDir: string,
  manifest: CourseQualityLabManifest,
): Promise<CourseQualityLabManifest> {
  const enriched = structuredClone(manifest);
  await Promise.all(enriched.sections.flatMap((section) => section.pairs.flatMap((pair) =>
    (["baseline", "enhanced"] as const).map(async (variantKey) => {
      const result = pair.variants[variantKey];
      const identity = runtimeIdentity(rootDir, section.id, pair.batch, variantKey, result);
      if (!identity) return;
      const [generationCalls, currentDesignCalls, legacyDesignCalls, oldestDesignCalls, ttsCalls, telemetry] = await Promise.all([
        readOptionalJsonArray<ModelCallRecord>(path.join(identity.runDir, "calls.json")),
        identity.designDir
          ? readOptionalJsonArray<ModelCallRecord>(path.join(identity.designDir, "calls.json"))
          : Promise.resolve([]),
        identity.legacyDesignDir
          ? readOptionalJsonArray<ModelCallRecord>(path.join(identity.legacyDesignDir, "calls.json"))
          : Promise.resolve([]),
        identity.oldestDesignDir
          ? readOptionalJsonArray<ModelCallRecord>(path.join(identity.oldestDesignDir, "calls.json"))
          : Promise.resolve([]),
        readOptionalJsonArray<TtsCallMetricRecord>(path.join(identity.runDir, "tts-calls.json")),
        readOptionalJson<GenerationTelemetryRecord>(path.join(identity.runDir, "telemetry.json")),
      ]);
      const designCalls = currentDesignCalls.length
        ? currentDesignCalls
        : legacyDesignCalls.length ? legacyDesignCalls : oldestDesignCalls;
      if (generationCalls.length || designCalls.length || ttsCalls.length || telemetry) {
        result.metrics = {
          ...result.metrics,
          ...summarizeMetrics(generationCalls, designCalls, ttsCalls, telemetry),
          ...(result.pipelineVersion && !telemetry?.pipelineVersion
            ? { pipelineVersion: result.pipelineVersion }
            : {}),
        };
      }
    }),
  )));
  return enriched;
}

function findPair(manifest: CourseQualityLabManifest, pairId: string): LabPair {
  const pair = allPairs(manifest).find((item) => item.id === pairId);
  if (!pair) throw publicError(404, "PAIR_NOT_FOUND", "清单中不存在这组对比结果。");
  return pair;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function renderSlideFrame(
  response: ServerResponse,
  buildDir: string,
  manifest: CourseQualityLabManifest,
  identity: { pairId: string } | { sectionId: string; batch: number },
  variantKey: LabVariantKey,
  slideIndex: number,
): Promise<void> {
  const section = "pairId" in identity
    ? manifest.sections.find((item) => item.pairs.some((pair) => pair.id === identity.pairId))
    : manifest.sections.find((item) => item.id === identity.sectionId);
  const pair = "pairId" in identity
    ? section?.pairs.find((item) => item.id === identity.pairId)
    : section?.pairs.find((item) => item.batch === identity.batch);
  const sectionId = section?.id ?? ("sectionId" in identity ? identity.sectionId : "");
  const batch = pair?.batch ?? ("batch" in identity ? identity.batch : 0);
  const variant = pair?.variants[variantKey];
  const slide = variant?.slides[slideIndex];
  if (!section || !pair || !slide) throw publicError(404, "SLIDE_NOT_FOUND", "该幻灯片尚未生成。");
  const imageUrl = typeof slide.imageUrl === "string" && slide.imageUrl.startsWith("/files/")
    ? slide.imageUrl
    : "";
  const scenesUrl = variant?.artifactBaseUrl?.startsWith("/files/")
    ? `${variant.artifactBaseUrl}/scenes.json`
    : `/files/artifacts/${encodeURIComponent(sectionId)}/${batch}/${variantKey}/scenes.json`;
  let frameScript = "";
  try {
    await resolveExistingFile(buildDir, "slide-frame.js");
    frameScript = '<script type="module" src="/slide-frame.js"></script>';
  } catch (error) {
    if ((error as PublicError).status !== 404) throw error;
  }
  const config = JSON.stringify({
    sectionId,
    batch,
    variant: variantKey,
    slideIndex,
    scenesUrl,
    imageUrl,
  }).replaceAll("<", "\\u003c");
  const image = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(slide.title ?? `第 ${slideIndex + 1} 页`)}" />`
    : '<div class="missing">该页预览图尚未生成</div>';
  sendText(response, 200, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(slide.title ?? section.title)}</title>
  ${frameScript ? '<link rel="stylesheet" href="/renderer.css" />' : ""}
  <style>
    html,body,#slide-frame{width:100%;height:100%;margin:0;background:#111827;overflow:hidden}
    #slide-frame{display:grid;place-items:center;position:relative}
    img{display:block;width:100%;height:100%;object-fit:contain}
    .missing{color:#cbd5e1;font:16px/1.5 system-ui,sans-serif}
  </style>
</head>
<body>
  <div id="slide-frame" data-scenes-url="${escapeHtml(scenesUrl)}" data-slide-index="${slideIndex}">${image}</div>
  <script>window.__COURSE_QUALITY_LAB_SLIDE__=${config}</script>
  ${frameScript}
</body>
</html>`, "text/html; charset=utf-8");
}

const SECRET_KEY = /^(api[-_]?key|authorization|credentials?|password|secret|client[-_]?secret|access[-_]?(?:key|token)|refresh[-_]?token|bearer[-_]?token)$/i;

/** Defense in depth if a generator accidentally writes provider credentials. */
function publicManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicManifestValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_KEY.test(key) ? "[redacted]" : publicManifestValue(child),
  ]));
}

function spreadsheetSafe(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function reviewsToCsv(collection: ReviewCollection): string {
  const headers = [
    "pairId",
    "outcome",
    ...DIMENSIONS,
    "pageNotes",
    "overallNote",
    "teacherReviews",
    "updatedAt",
  ];
  const rows = collection.reviews.map((review) => [
    review.pairId,
    review.outcome,
    ...Array.from(DIMENSIONS, (dimension) => review.dimensions[dimension]),
    JSON.stringify(review.pageNotes),
    review.overallNote,
    JSON.stringify(review.teacherReviews ?? {}),
    review.updatedAt,
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(spreadsheetSafe).join(",")).join("\r\n")}\r\n`;
}

function urlPathToFileReference(rootDir: string, urlValue: string): { base: string; encoded: string } {
  let pathname: string;
  try {
    const url = new URL(urlValue, "http://course-quality-lab.local");
    if (url.origin !== "http://course-quality-lab.local") throw new Error("remote URL");
    pathname = url.pathname;
  } catch {
    throw publicError(404, "DOWNLOAD_NOT_FOUND", "下载文件没有有效的本地地址。");
  }
  for (const [prefix, directory] of [
    ["/artifacts/", "artifacts"],
    ["/audio/", "audio"],
    ["/api/artifacts/", "artifacts"],
    ["/api/audio/", "audio"],
    ["/files/artifacts/", "artifacts"],
    ["/files/audio/", "audio"],
    ["/files/fonts/", "fonts"],
    ["/files/public/", "public"],
  ] as const) {
    if (pathname.startsWith(prefix)) {
      return { base: path.join(rootDir, directory), encoded: pathname.slice(prefix.length) };
    }
  }
  throw publicError(404, "DOWNLOAD_NOT_FOUND", "下载文件必须位于实验 artifacts 或 audio 目录。");
}

async function resolveManifestUrl(rootDir: string, value: string | undefined): Promise<string> {
  if (!value) throw publicError(404, "DOWNLOAD_NOT_FOUND", "该文件尚未生成。");
  const reference = urlPathToFileReference(rootDir, value);
  return resolveExistingFile(reference.base, reference.encoded);
}

async function makeAudioZip(rootDir: string, pairId: string, variant: LabVariantResult): Promise<Buffer> {
  const segments = variant.script.filter((segment) => segment.audioUrl);
  if (!segments.length) throw publicError(404, "AUDIO_NOT_FOUND", "该方案尚未生成可下载的音频。");
  const zip = new JSZip();
  for (const [index, segment] of segments.entries()) {
    const filePath = await resolveManifestUrl(rootDir, segment.audioUrl);
    const extension = path.extname(filePath) || ".mp3";
    const safeId = segment.id.replace(/[^\p{L}\p{N}._-]/gu, "_");
    zip.file(`${String(index + 1).padStart(3, "0")}-${safeId}${extension}`, createReadStream(filePath));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

async function serveDownload(
  request: IncomingMessage,
  response: ServerResponse,
  storage: CourseQualityLabStorage,
  manifest: CourseQualityLabManifest,
  pairId: string,
  variantKey: LabVariantKey,
  kind: string,
): Promise<void> {
  const pair = findPair(manifest, pairId);
  const variant = pair.variants[variantKey];
  if (!variant) throw publicError(404, "VARIANT_NOT_FOUND", "该方案不存在。");
  if (kind === "audio" || kind === "audio.zip") {
    if (variant.downloads?.audioZip) {
      const filePath = await resolveManifestUrl(storage.rootDir, variant.downloads.audioZip);
      await sendFile(request, response, filePath, { attachmentName: `${pairId}-${variantKey}-audio.zip` });
      return;
    }
    const bytes = await makeAudioZip(storage.rootDir, pairId, variant);
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Length", bytes.length);
    response.setHeader("Content-Disposition", contentDisposition(`${pairId}-${variantKey}-audio.zip`));
    response.setHeader("Cache-Control", "no-store");
    applyCommonHeaders(response);
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }
  if (kind !== "script" && kind !== "pptx") {
    throw publicError(404, "DOWNLOAD_NOT_FOUND", "不支持该下载类型。");
  }
  const link = variant.downloads?.[kind];
  const filePath = await resolveManifestUrl(storage.rootDir, link);
  const fallbackExtension = kind === "pptx" ? ".pptx" : path.extname(filePath) || ".txt";
  await sendFile(request, response, filePath, { attachmentName: `${pairId}-${variantKey}-${kind}${fallbackExtension}` });
}

function routeMatch(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}

function storageErrorStatus(error: LabStorageError): number {
  return error.code === "NOT_FOUND" ? 404 : 500;
}

async function defaultStartGenerationRetry(input: {
  rootDir: string;
  sectionId: string;
  pair: LabPair;
  variant: LabVariantKey;
}): Promise<{ pid?: number }> {
  const experimentId = input.pair.experimentId;
  if (!experimentId || !PAIR_ID.test(experimentId) || !PAIR_ID.test(input.sectionId)) {
    throw publicError(409, "RETRY_CONFIG_MISSING", "这条记录缺少可恢复的实验标识。");
  }
  const configPath = path.join(
    input.rootDir,
    "runs",
    experimentId,
    input.sectionId,
    String(input.pair.batch),
    input.variant,
    "resume-config.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw publicError(409, "RETRY_CONFIG_MISSING", "这条历史记录没有保存自动恢复配置。");
    }
    throw error;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.args)
    || parsed.args.some((value) => typeof value !== "string") || parsed.args.length > 80) {
    throw publicError(409, "RETRY_CONFIG_INVALID", "自动恢复配置无效。");
  }
  const child = spawn("pnpm", ["quality-lab:generate", "--", ...parsed.args as string[], "--retry-technical"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { pid: child.pid };
}

export function createCourseQualityLabServer(options: CourseQualityLabServerOptions = {}): Server {
  const storage = new CourseQualityLabStorage(options.rootDir ?? DEFAULT_LAB_ROOT);
  const buildDir = path.resolve(options.buildDir ?? DEFAULT_BUILD_DIR);
  const logger = options.logger ?? console;
  const startGenerationRetry = options.startGenerationRetry ?? defaultStartGenerationRetry;
  const activeRetries = new Set<string>();

  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if ((pathname === "/health/live" || pathname === "/api/health/live") && (method === "GET" || method === "HEAD")) {
        sendJson(response, 200, { status: "ok", service: "course-quality-lab" });
        return;
      }
      if (pathname === "/api/manifest" && method === "GET") {
        sendJson(response, 200, publicManifestValue(await withRuntimeMetrics(
          storage.rootDir,
          await storage.readManifest(),
        )));
        return;
      }
      if (pathname === "/api/reviews" && method === "GET") {
        sendJson(response, 200, await storage.readReviews());
        return;
      }
      const retryMatch = routeMatch(pathname, /^\/api\/generation\/retry\/([^/]+)\/(baseline|enhanced)$/);
      if (retryMatch && method === "POST") {
        const pairId = decodeRoutePart(retryMatch[1]);
        const variant = retryMatch[2] as LabVariantKey;
        if (!PAIR_ID.test(pairId)) throw publicError(400, "INVALID_PAIR_ID", "pairId 格式无效。");
        const manifest = await storage.readManifest();
        const section = manifest.sections.find((item) => item.pairs.some((pair) => pair.id === pairId));
        const pair = section?.pairs.find((item) => item.id === pairId);
        if (!section || !pair) throw publicError(404, "PAIR_NOT_FOUND", "清单中不存在这组结果。");
        const result = pair.variants[variant];
        const hasFailure = result.technicalValidation?.state === "failed"
          || Object.values(result.statuses).some((status) => status.state === "failed" || status.state === "missing");
        if (!hasFailure) throw publicError(409, "RETRY_NOT_NEEDED", "当前方案没有可重试的技术失败阶段。");
        const retryKey = `${pairId}:${variant}`;
        if (activeRetries.has(retryKey)) throw publicError(409, "RETRY_ALREADY_RUNNING", "该方案已在恢复中。");
        activeRetries.add(retryKey);
        try {
          const started = await startGenerationRetry({ rootDir: storage.rootDir, sectionId: section.id, pair, variant });
          setTimeout(() => activeRetries.delete(retryKey), 5_000).unref();
          sendJson(response, 202, { status: "started", ...started });
        } catch (error) {
          activeRetries.delete(retryKey);
          throw error;
        }
        return;
      }
      const reviewMatch = routeMatch(pathname, /^\/api\/reviews\/([^/]+)$/);
      if (reviewMatch && method === "PUT") {
        const pairId = decodeRoutePart(reviewMatch[1]);
        if (!PAIR_ID.test(pairId)) throw publicError(400, "INVALID_PAIR_ID", "pairId 格式无效。");
        const manifest = await storage.readManifest();
        const pair = findPair(manifest, pairId);
        const review = validateReview(await readJsonBody(request), pairId, pair);
        const collection = await storage.savePairReview(review);
        sendJson(response, 200, { review, reviews: collection.reviews, savedAt: review.updatedAt });
        return;
      }
      if ((pathname === "/api/exports/reviews.json" || pathname === "/api/export/reviews.json" || pathname === "/api/reviews/export.json") && method === "GET") {
        const reviews = await storage.readReviews();
        sendText(response, 200, `${JSON.stringify(reviews, null, 2)}\n`, "application/json; charset=utf-8", "course-quality-reviews.json");
        return;
      }
      if ((pathname === "/api/exports/reviews.csv" || pathname === "/api/export/reviews.csv" || pathname === "/api/reviews/export.csv") && method === "GET") {
        sendText(response, 200, reviewsToCsv(await storage.readReviews()), "text/csv; charset=utf-8", "course-quality-reviews.csv");
        return;
      }
      const downloadMatch = routeMatch(pathname, /^\/api\/download\/([^/]+)\/(baseline|enhanced)\/(script|pptx|audio(?:\.zip)?)$/);
      if (downloadMatch && (method === "GET" || method === "HEAD")) {
        const pairId = decodeRoutePart(downloadMatch[1]);
        if (!PAIR_ID.test(pairId)) throw publicError(400, "INVALID_PAIR_ID", "pairId 格式无效。");
        await serveDownload(
          request,
          response,
          storage,
          await storage.readManifest(),
          pairId,
          downloadMatch[2] as LabVariantKey,
          downloadMatch[3],
        );
        return;
      }
      const renderMatch = routeMatch(pathname, /^\/render\/([^/]+)\/(\d+)\/(baseline|enhanced)\/(\d+)$/);
      if (renderMatch && (method === "GET" || method === "HEAD")) {
        const sectionId = decodeRoutePart(renderMatch[1]);
        const batch = Number(renderMatch[2]);
        const slideIndex = Number(renderMatch[4]);
        if (!PAIR_ID.test(sectionId) || !Number.isSafeInteger(batch) || !Number.isSafeInteger(slideIndex)) {
          throw publicError(400, "INVALID_SLIDE_PATH", "幻灯片路径无效。");
        }
        await renderSlideFrame(
          response,
          buildDir,
          await storage.readManifest(),
          { sectionId, batch },
          renderMatch[3] as LabVariantKey,
          slideIndex,
        );
        return;
      }
      const pairRenderMatch = routeMatch(pathname, /^\/render-pair\/([^/]+)\/(baseline|enhanced)\/(\d+)$/);
      if (pairRenderMatch && (method === "GET" || method === "HEAD")) {
        const pairId = decodeRoutePart(pairRenderMatch[1]);
        const slideIndex = Number(pairRenderMatch[3]);
        if (!PAIR_ID.test(pairId) || !Number.isSafeInteger(slideIndex)) {
          throw publicError(400, "INVALID_SLIDE_PATH", "幻灯片路径无效。");
        }
        await renderSlideFrame(
          response,
          buildDir,
          await storage.readManifest(),
          { pairId },
          pairRenderMatch[2] as LabVariantKey,
          slideIndex,
        );
        return;
      }
      if (pathname.startsWith("/files/") && (method === "GET" || method === "HEAD")) {
        const relative = pathname.slice("/files/".length);
        const firstSlash = relative.indexOf("/");
        const directory = firstSlash >= 0 ? decodeRoutePart(relative.slice(0, firstSlash)) : "";
        if (!["artifacts", "audio", "fonts", "public"].includes(directory)) {
          throw publicError(404, "FILE_NOT_FOUND", "该实验文件不可公开访问。");
        }
        const filePath = await resolveExistingFile(
          path.join(storage.rootDir, directory),
          relative.slice(firstSlash + 1),
        );
        await sendFile(request, response, filePath, { immutable: directory === "audio" });
        return;
      }
      for (const prefix of ["/artifacts/", "/api/artifacts/"]) {
        if (pathname.startsWith(prefix) && (method === "GET" || method === "HEAD")) {
          const filePath = await resolveExistingFile(path.join(storage.rootDir, "artifacts"), pathname.slice(prefix.length));
          await sendFile(request, response, filePath);
          return;
        }
      }
      for (const prefix of ["/audio/", "/api/audio/"]) {
        if (pathname.startsWith(prefix) && (method === "GET" || method === "HEAD")) {
          const filePath = await resolveExistingFile(path.join(storage.rootDir, "audio"), pathname.slice(prefix.length));
          await sendFile(request, response, filePath, { immutable: true });
          return;
        }
      }
      if (pathname.startsWith("/api/")) {
        throw publicError(404, "NOT_FOUND", "该实验接口不存在。");
      }
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        throw publicError(405, "METHOD_NOT_ALLOWED", "该接口不支持此请求方法。");
      }

      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      let filePath: string;
      try {
        filePath = await resolveExistingFile(buildDir, relative);
      } catch (error) {
        if ((error as PublicError).status !== 404 || path.extname(relative)) throw error;
        filePath = await resolveExistingFile(buildDir, "index.html");
      }
      await sendFile(request, response, filePath);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof LabStorageError) {
        sendJson(response, storageErrorStatus(error), { error: error.code, message: error.message });
        return;
      }
      const known = error as PublicError;
      if (known.status) {
        if (known.status === 416) response.setHeader("Content-Range", "bytes */*");
        sendJson(response, known.status, { error: known.code ?? "REQUEST_FAILED", message: known.message });
        return;
      }
      logger.error("[course-quality-lab] request failed", error);
      sendJson(response, 500, { error: "INTERNAL_ERROR", message: "实验服务处理请求失败。" });
    }
  });
}

export interface LabCliOptions {
  host: string;
  port: number;
  rootDir: string;
  buildDir: string;
}

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseCliOptions(args = process.argv.slice(2), env = process.env): LabCliOptions {
  const portValue = optionValue(args, "--port") ?? env.COURSE_QUALITY_LAB_PORT ?? "3010";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`无效端口：${portValue}`);
  return {
    host: optionValue(args, "--host") ?? env.COURSE_QUALITY_LAB_HOST ?? "0.0.0.0",
    port,
    rootDir: path.resolve(optionValue(args, "--root") ?? env.COURSE_QUALITY_LAB_ROOT ?? DEFAULT_LAB_ROOT),
    buildDir: path.resolve(optionValue(args, "--build") ?? env.COURSE_QUALITY_LAB_BUILD_DIR ?? DEFAULT_BUILD_DIR),
  };
}

export async function listenCourseQualityLabServer(options: LabCliOptions, logger: Log = console): Promise<Server> {
  const storage = new CourseQualityLabStorage(options.rootDir);
  await storage.initialize();
  const server = createCourseQualityLabServer({ rootDir: options.rootDir, buildDir: options.buildDir, logger });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  logger.info(`[course-quality-lab] ready at http://${options.host}:${port}`);
  logger.info(`[course-quality-lab] data: ${options.rootDir}`);
  return server;
}

async function main(): Promise<void> {
  const options = parseCliOptions();
  try {
    const server = await listenCourseQualityLabServer(options);
    const close = () => server.close(() => process.exit(0));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`[course-quality-lab] 无法启动：${options.host}:${options.port} 端口已被占用。`);
    } else {
      console.error(`[course-quality-lab] 无法启动：${(error as Error).message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
