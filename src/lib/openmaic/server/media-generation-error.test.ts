import { describe, expect, it } from 'vitest';
import { mediaGenerationErrorResponse } from './media-generation-error';
describe('media API fault metadata', () => {
  it('marks an invalid completed image as terminal', () => {
    expect(mediaGenerationErrorResponse(new Error('Image response missing URL')).headers.get('x-generation-retryable')).toBe('false');
  });
  it('preserves an upstream rate limit and Retry-After header', () => {
    const response = mediaGenerationErrorResponse({ statusCode: 429, responseHeaders: { 'Retry-After': '45' } });
    expect(response.headers.get('x-generation-retryable')).toBe('true');
    expect(response.headers.get('retry-after')).toBe('45');
  });
});
