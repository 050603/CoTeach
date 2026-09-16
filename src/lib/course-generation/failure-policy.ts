import { isRetryableGenerationError } from "@openmaic/lib/generation/generation-retry";

export const MAX_MANAGED_COURSE_GENERATION_RECOVERIES = 0;
export const COURSE_MEDIA_GENERATION_INCOMPLETE = "COURSE_MEDIA_GENERATION_INCOMPLETE";
const PERSISTED_FAILURE_PREFIX = "OPENPBL_COURSE_GENERATION_FAILURE_V1:";
const MAX_PERSISTED_ERROR_MESSAGE_LENGTH = 4_000;

type PersistedCourseGenerationFailure = {
  version: 1;
  retryable: boolean;
  name: string;
  message: string;
  code?: string | number;
  status?: number;
};

export type ManagedCourseGenerationRequest = {
  managedRecoveryCount?: number;
};

export function createCourseMediaGenerationIncompleteError(input: {
  imageCount: number;
  videoCount: number;
}): Error {
  const parts = [
    input.imageCount > 0 ? `${input.imageCount} 张课程图片` : null,
    input.videoCount > 0 ? `${input.videoCount} 个课程视频` : null,
  ].filter(Boolean);
  return Object.assign(new Error(
    `${parts.join("、") || "课程媒体"}在多次自动重试后仍未完成；已生成的课程页面均已保留，请稍后继续生成。`,
  ), {
    code: COURSE_MEDIA_GENERATION_INCOMPLETE,
    // Restarting the course cannot improve a page-independent provider or
    // media-review failure. The classroom remains usable and the preview owns
    // targeted resource repair.
    isRetryable: false,
  });
}

export function createManagedCourseGenerationRecoveryRequest<T extends object>(
  request: T & ManagedCourseGenerationRequest,
  error: unknown,
): (T & ManagedCourseGenerationRequest) | null {
  // Request boundaries already consumed the fault budget. Only explicit user
  // continuation or process restart may resume missing checkpoints.
  void request;
  void error;
  return null;
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = errorRecord(error);
  return stringValue(record?.message) ?? String(error);
}

function redactPersistedErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[-_ ]?key|authorization|token|secret|password)\s*["']?\s*[:=]\s*["']?)([^"'\s,;&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .slice(0, MAX_PERSISTED_ERROR_MESSAGE_LENGTH);
}

function isRecoverableTeachingToolFailure(message: string): boolean {
  return /missing required teaching tools(?: after correction)?:/i.test(message);
}

function isRecoverableWhiteboardQualityFailure(message: string): boolean {
  // Builds before WHITEBOARD_QUALITY_REPAIR_INCOMPLETE was introduced stored
  // these model-output defects as terminal errors. They are page-local and can
  // be regenerated safely while the other scene checkpoints stay intact.
  return message.includes("白板仍存在布局或内容问题")
    || message.includes("白板修正未保留讲授内容");
}

/**
 * Persist enough internal failure metadata to classify a later recovery after
 * a process restart. Route responses must format this value before returning
 * it; the diagnostic text is deliberately not a teacher-facing message.
 */
export function serializeCourseGenerationFailure(error: unknown): string {
  const record = errorRecord(error);
  const status = numberValue(record?.statusCode ?? record?.status ?? record?.status_code);
  const code = stringValue(record?.code) ?? numberValue(record?.code);
  const failure: PersistedCourseGenerationFailure = {
    version: 1,
    retryable: isRetryableGenerationError(error),
    name: error instanceof Error
      ? error.name
      : stringValue(record?.name) ?? "Error",
    message: redactPersistedErrorMessage(errorMessage(error)),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  return `${PERSISTED_FAILURE_PREFIX}${JSON.stringify(failure)}`;
}

function parsePersistedFailure(value: string): PersistedCourseGenerationFailure | null {
  if (!value.startsWith(PERSISTED_FAILURE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(value.slice(PERSISTED_FAILURE_PREFIX.length)) as Partial<PersistedCourseGenerationFailure>;
    if (
      parsed.version !== 1
      || typeof parsed.retryable !== "boolean"
      || typeof parsed.name !== "string"
      || typeof parsed.message !== "string"
    ) return null;
    return parsed as PersistedCourseGenerationFailure;
  } catch {
    return null;
  }
}

/** Restore the original retry classification without exposing its diagnostic. */
export function deserializeCourseGenerationFailure(value: string): Error {
  const persisted = parsePersistedFailure(value);
  if (!persisted) {
    const legacy = new Error(value);
    // Older rows stored the already-formatted transient teacher message. Keep
    // those jobs recoverable after deploying the structured format.
    if (
      value.includes("AI 页面生成服务连续多次未能完成")
    ) {
      Object.assign(legacy, { isRetryable: true });
    }
    return legacy;
  }
  const error = new Error(persisted.message);
  error.name = persisted.name;
  Object.assign(error, {
    // Historical quality failures cannot re-enter automatic fault recovery.
    isRetryable: persisted.retryable && !isRecoverableTeachingToolFailure(persisted.message) && !isRecoverableWhiteboardQualityFailure(persisted.message),
    ...(persisted.code !== undefined ? { code: persisted.code } : {}),
    ...(persisted.status !== undefined ? { status: persisted.status } : {}),
  });
  return error;
}

export function formatCourseGenerationErrorForTeacher(error: unknown): string {
  const record = errorRecord(error);
  const code = stringValue(record?.code);
  const name = error instanceof Error
    ? error.name
    : stringValue(record?.name);
  const message = errorMessage(error);
  if (
    code === "IMAGE_PROVIDER_NOT_CONFIGURED"
    || code === "VIDEO_PROVIDER_NOT_CONFIGURED"
    || code === COURSE_MEDIA_GENERATION_INCOMPLETE
  ) {
    return message;
  }
  if (
    name === "TimeoutError"
    || /Course model (?:request|stream).*(?:timed out|maximum duration)/i.test(message)
  ) {
    return "AI 页面生成在等待模型完整输出时超时；已经生成的页面均已保留，可从断点继续生成。";
  }
  if (isRetryableGenerationError(error)) {
    return "AI 页面生成服务连续多次未能完成最后的课堂页面；已经生成的页面均已保留，请稍后继续。";
  }
  return "课程生成遇到无法继续的系统错误；已经生成的页面均已保留，请稍后继续。";
}

export function formatPersistedCourseGenerationErrorForTeacher(value: string): string {
  return formatCourseGenerationErrorForTeacher(deserializeCourseGenerationFailure(value));
}
