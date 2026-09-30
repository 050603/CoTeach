/** Shared by every authoring stage; changing this invalidates authoring inputs. */
export const COURSE_FIRST_PASS_CONTRACT_VERSION = "course-first-pass-v1";
export const MAX_FIRST_PASS_TRANSPORT_RETRIES = 1;

// These responses explicitly refuse work. A gateway timeout, broken socket or
// an unstructured "retryable" error cannot establish whether work was started.
const REJECTED_TEMPORARY_STATUSES = new Set([429, 503]);
const TERMINAL_CODES = new Set([
  "LLM_STREAM_TRUNCATED", "LLM_STREAM_INCOMPLETE", "LLM_EXECUTION_BUDGET_EXCEEDED",
  "LLM_RESPONSE_PERSISTENCE_FAILED", "COURSE_TOKEN_USAGE_PERSISTENCE_FAILED",
]);

function records(error: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const record = error as Record<string, unknown>;
  const nested = [record.cause, record.lastError, record.value,
    ...(Array.isArray(record.errors) ? record.errors : [])];
  return [record, ...nested.flatMap((value) => records(value, seen))];
}

/** Retry only an explicit provider refusal, before any reasoning or text output. */
export function isFirstPassProviderRejection(error: unknown, outputStarted = false): boolean {
  if (outputStarted) return false;
  const chain = records(error);
  if (!chain.length) return false;
  if (chain.some((record) => record.isRetryable === false
    || record.name === "AbortError" || record.name === "TimeoutError"
    || TERMINAL_CODES.has(String(record.code ?? ""))
    || record.outputStarted === true || record.hasOutput === true
    || (typeof record.rawResponse === "string" && record.rawResponse.length > 0)
    || (typeof record.textCharacters === "number" && record.textCharacters > 0)
    || (typeof record.reasoningCharacters === "number" && record.reasoningCharacters > 0))) return false;

  const statuses = chain.flatMap((record) => [record.statusCode, record.status, record.status_code])
    .map((value) => typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN)
    .filter(Number.isFinite);
  return statuses.length > 0 && statuses.every((status) => REJECTED_TEMPORARY_STATUSES.has(status));
}
