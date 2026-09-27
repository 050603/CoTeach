import { describe, expect, it } from 'vitest';
import { LlmTimeoutError } from '@/lib/llm/errors';
import { ProactiveReviewCapacityError } from './proactive-review-capacity';
import { documentReviewFailure } from './document-review-failure';

describe('document review failure classification', () => {
  it.each([new DOMException('expired', 'TimeoutError'), new LlmTimeoutError(40_000)])('classifies actual deadlines', error => {
    const result = documentReviewFailure(error, false, false);
    expect(result.code).toBe('AI_COLLABORATION_TIMEOUT');
    expect(result.error).toBeInstanceOf(LlmTimeoutError);
  });
  it('preserves a deadline even when the transport wraps its abort', () => {
    expect(documentReviewFailure(new Error('wrapped abort'), false, true).kind).toBe('timeout');
  });
  it('distinguishes user cancellation from a simultaneous deadline', () => {
    expect(documentReviewFailure(new Error('aborted'), true, true).code).toBe('REQUEST_ABORTED');
  });
  it('preserves bounded capacity and structure categories', () => {
    expect(documentReviewFailure(new ProactiveReviewCapacityError(1000), false, false).kind).toBe('capacity');
    expect(documentReviewFailure(new Error('AI_RESPONSE_INVALID_STRUCTURE'), false, false).code).toBe('AI_RESPONSE_INVALID_STRUCTURE');
  });
  it('never includes provider text in persisted failure categories', () => {
    const error = new Error('https://private-provider.invalid?token=secret');
    const result = documentReviewFailure(error, false, false);
    expect({ code: result.code, kind: result.kind }).toEqual({ code: 'AI_REVIEW_FAILED', kind: 'failed' });
    expect(result.error).toBe(error);
  });
});
