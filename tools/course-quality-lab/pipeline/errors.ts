import type { PipelineErrorKind, PipelineIssue } from "./types";

export class PipelineError extends Error {
  readonly kind: PipelineErrorKind;
  readonly moduleId?: string;
  readonly cause?: unknown;
  readonly issues: readonly PipelineIssue[];

  constructor(
    kind: PipelineErrorKind,
    message: string,
    options: { moduleId?: string; cause?: unknown; issues?: readonly PipelineIssue[] } = {},
  ) {
    super(message);
    this.name = "PipelineError";
    this.kind = kind;
    this.moduleId = options.moduleId;
    this.cause = options.cause;
    this.issues = options.issues ?? [];
  }
}

export function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

export function classifyPipelineError(
  error: unknown,
  fallback: PipelineErrorKind = "transport",
  moduleId?: string,
): PipelineError {
  if (error instanceof PipelineError) return error;
  const kind = isCancellation(error) ? "cancelled" : fallback;
  const message = error instanceof Error ? error.message : String(error);
  return new PipelineError(kind, message, { moduleId, cause: error });
}

export function parseFailure(error: unknown, moduleId?: string): PipelineError {
  return classifyPipelineError(error, "parse", moduleId);
}

export function structureFailure(error: unknown, moduleId?: string): PipelineError {
  return classifyPipelineError(error, "structure", moduleId);
}

export function qualityFailure(
  message: string,
  issues: readonly PipelineIssue[],
  moduleId?: string,
): PipelineError {
  return new PipelineError("quality", message, { moduleId, issues });
}

