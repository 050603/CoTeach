import { getThinkingMode } from '@openmaic/lib/ai/thinking-config';
import type { ThinkingConfig } from '@openmaic/lib/types/provider';

export const COURSE_OUTPUT_BUDGET_VERSION = 'course-output-budget-v2';

export type CourseOutputResource =
  | 'search-query'
  | 'planning'
  | 'teaching-design'
  | 'narration'
  | 'interactive'
  | 'slide'
  | 'actions'
  | 'agent-profiles';

// These are generous output allowances, not required content lengths. In
// particular, slide DSL and executable widgets need more room than prose.
// Input-dependent growth below accommodates larger courses and repair drafts.
const VISIBLE_OUTPUT_ALLOWANCE: Record<CourseOutputResource, number> = {
  'search-query': 1_024,
  planning: 16_384,
  'teaching-design': 16_384,
  narration: 8_192,
  interactive: 32_768,
  slide: 24_576,
  actions: 16_384,
  'agent-profiles': 8_192,
};

/**
 * Allocate work for one request independently of the model's capacity.
 *
 * This is a conservative heuristic, not a tokenizer or an instruction to the
 * model to shorten its teaching. Half the prompt's UTF-8 byte count is used as
 * an input-size allowance so multilingual text and JSON both contribute. It
 * also includes system/schema instructions, whose complexity affects output.
 *
 * Reasoning and visible output can share max_tokens. Keep separate headroom
 * for them, including when the provider's default thinking mode is unknown.
 * An explicit thinking budget is respected; no thinking setting is changed.
 * A total token limit cannot force an unfinished reasoning stream to produce
 * valid JSON: callers must still reject length-truncated responses.
 */
export function createCourseOutputBudget(options: {
  resource: CourseOutputResource;
  modelOutputWindow?: number;
  thinking?: ThinkingConfig;
}): (system: string, prompt: string) => number {
  return (system, prompt) => {
    const inputAllowance = Math.ceil(
      new TextEncoder().encode(`${system}\n${prompt}`).byteLength / 2,
    );
    const visibleAllowance = VISIBLE_OUTPUT_ALLOWANCE[options.resource] + inputAllowance;
    const mode = getThinkingMode(options.thinking);
    const thinkingDisabled = mode === 'disabled'
      || (mode === undefined && options.thinking?.effort === 'none');
    const configuredBudget = options.thinking?.budgetTokens;
    // Effort controls reasoning work, not the visible teaching length. Reserve
    // space for the selected teacher setting without rewriting that setting.
    const depth = options.thinking?.effort ?? options.thinking?.level;
    const effortMultiplier = depth === 'max' || depth === 'xhigh' ? 4
      : depth === 'high' ? 3 : depth === 'medium' ? 2 : 1;
    const reasoningAllowance = thinkingDisabled ? 0
      : typeof configuredBudget === 'number' && Number.isFinite(configuredBudget)
          && configuredBudget > 0
        ? Math.ceil(configuredBudget)
        : Math.max(16_384, visibleAllowance) * effortMultiplier;
    const requested = Math.ceil((visibleAllowance + reasoningAllowance) / 1024) * 1024;
    const capacity = options.modelOutputWindow;
    return typeof capacity === 'number' && Number.isFinite(capacity) && capacity >= 1
      ? Math.min(requested, Math.floor(capacity))
      : requested;
  };
}

export const COURSE_EXECUTION_BUDGET_VERSION = 'course-execution-budget-v1';

export type CourseExecutionBudgetOptions = {
  /** Conservative planning estimate, not a claim about provider throughput. */
  minTokensPerSecond: number;
  startupAllowanceMs: number;
  /** Independent operator safety ceiling; never increased by stream activity. */
  maxDurationMs: number;
};

/** Operators can calibrate this estimate for their selected provider/model. */
export function resolveCourseExecutionBudgetOptions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CourseExecutionBudgetOptions {
  const positive = (raw: string | undefined, fallback: number, maximum: number) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
  };
  return {
    minTokensPerSecond: positive(environment.OPENPBL_COURSE_MIN_TOKENS_PER_SECOND, 20, 10_000),
    startupAllowanceMs: positive(environment.OPENPBL_COURSE_STARTUP_ALLOWANCE_MS, 120_000, 3_600_000),
    maxDurationMs: positive(
      environment.OPENPBL_COURSE_EXECUTION_MAX_DURATION_MS
        ?? environment.OPENPBL_LLM_STREAM_MAX_DURATION_MS,
      7_200_000,
      86_400_000,
    ),
  };
}

/** Schedule time against allocated work; idle detection remains independent. */
export function calculateCourseExecutionDurationMs(
  maxOutputTokens: number | undefined,
  idleTimeoutMs: number,
  policy: CourseExecutionBudgetOptions,
): number {
  if (!(policy.minTokensPerSecond > 0) || !Number.isFinite(policy.minTokensPerSecond)
    || !(policy.maxDurationMs > 0) || !Number.isFinite(policy.maxDurationMs)
    || !(policy.startupAllowanceMs >= 0) || !Number.isFinite(policy.startupAllowanceMs)) {
    throw new Error('Invalid course execution budget configuration');
  }
  const allocatedTokens = typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens)
    ? Math.max(0, maxOutputTokens) : 0;
  return Math.ceil(Math.min(policy.maxDurationMs, Math.max(
    idleTimeoutMs,
    policy.startupAllowanceMs + allocatedTokens / policy.minTokensPerSecond * 1000,
  )));
}
