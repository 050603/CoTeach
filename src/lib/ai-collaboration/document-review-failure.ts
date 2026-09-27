import { LlmTimeoutError } from '@/lib/llm/errors';
import { ProactiveReviewCapacityError } from './proactive-review-capacity';

/** Persist only bounded categories, never provider messages, URLs or credentials. */
export function documentReviewFailure(error: unknown, cancelled: boolean, deadlineExpired: boolean) {
  if (cancelled) return { code: 'REQUEST_ABORTED', kind: 'cancelled', error };
  if (deadlineExpired || error instanceof LlmTimeoutError
    || ((error instanceof Error || error instanceof DOMException) && error.name === 'TimeoutError')) {
    return { code: 'AI_COLLABORATION_TIMEOUT', kind: 'timeout', error: new LlmTimeoutError(40_000) };
  }
  if (error instanceof ProactiveReviewCapacityError) {
    return { code: 'AI_PROACTIVE_REVIEW_BUSY', kind: 'capacity', error };
  }
  if (error instanceof Error && ['AI_REVIEW_INVALID_STRUCTURE', 'AI_RESPONSE_INVALID_STRUCTURE'].includes(error.message)) {
    return { code: error.message, kind: 'invalid-output', error };
  }
  return { code: 'AI_REVIEW_FAILED', kind: 'failed', error };
}
