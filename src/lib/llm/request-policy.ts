import type { LlmCallRequest } from "@/lib/llm/types";

export type LlmRequestClass = "standard" | "page-generation" | "quality-review" | "long-generation";

// Durable background generation can safely repeat a request because no stage
// is persisted until a complete, validated response is received. Four retries
// span short proxy/provider disruptions without creating an unbounded loop.
export const DURABLE_GENERATION_TRANSIENT_RETRIES = 4;

const STANDARD_TIMEOUT_MS = 180_000;
const PAGE_GENERATION_TIMEOUT_MS = 180_000;
// Deep-reasoning reviewers often spend substantial time evaluating a dense
// curriculum graph before emitting a relatively small JSON verdict. A short
// output is not necessarily a short inference, so keep a conservative five-
// minute default while retaining an independent operator override.
const QUALITY_REVIEW_TIMEOUT_MS = 300_000;
const LONG_GENERATION_TIMEOUT_MS = 600_000;
const STREAM_MAX_DURATION_MS = 1_800_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 1_800_000;

type TimeoutEnvironment = Readonly<Record<string, string | undefined>>;

function boundedTimeout(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

export function resolveLlmRequestTimeoutMs(
  requestClass: LlmRequestClass,
  environment: TimeoutEnvironment = process.env,
): number {
  if (requestClass === "long-generation") {
    return boundedTimeout(
        environment.OPENPBL_LLM_LONG_REQUEST_TIMEOUT_MS,
        LONG_GENERATION_TIMEOUT_MS,
      );
  }
  if (requestClass === "quality-review") {
    return boundedTimeout(
      environment.OPENPBL_LLM_QUALITY_REVIEW_TIMEOUT_MS,
      QUALITY_REVIEW_TIMEOUT_MS,
    );
  }
  if (requestClass === "page-generation") {
    return boundedTimeout(
      environment.OPENPBL_LLM_PAGE_REQUEST_TIMEOUT_MS,
      PAGE_GENERATION_TIMEOUT_MS,
    );
  }
  return boundedTimeout(
    environment.OPENPBL_LLM_REQUEST_TIMEOUT_MS,
    STANDARD_TIMEOUT_MS,
  );
}

/**
 * Active model streams use the ordinary request timeout as an inactivity
 * deadline. This independent ceiling prevents an upstream that keeps sending
 * empty/control events from occupying a course-generation slot forever.
 */
export function resolveLlmStreamMaxDurationMs(
  environment: TimeoutEnvironment = process.env,
): number {
  return boundedTimeout(
    environment.OPENPBL_LLM_STREAM_MAX_DURATION_MS,
    STREAM_MAX_DURATION_MS,
  );
}

export function requestClassForCourseContentAction(
  action: LlmCallRequest["action"],
): LlmRequestClass {
  return action === "knowledgeGraph"
    || action === "teachingOutline"
    || action === "lessonOutline"
    || action === "fullCourse"
    ? "long-generation"
    : "standard";
}
