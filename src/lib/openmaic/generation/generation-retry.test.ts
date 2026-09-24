import { describe, expect, it, vi } from 'vitest';
import { LlmEmptyResponseError, LlmTimeoutError } from '@/lib/llm/errors';
import {
  contextualizeGenerationError,
  generationRetryAfterMs,
  isRetryableGenerationError,
  withGenerationRetry,
} from './generation-retry';

describe('withGenerationRetry', () => {
  it('honors AI SDK Retry-After response headers beyond the backoff cap', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockRejectedValueOnce({ statusCode: 429, responseHeaders: { 'retry-after': '45' } }).mockResolvedValue('ok');
    await withGenerationRetry(operation, { label: 'SDK', sleep, random: () => 0 });
    expect(sleep).toHaveBeenCalledWith(45_000, undefined);
  });
  it('caps fault retries at two even when callers request more', async () => {
    const operation = vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), { statusCode: 503 }));
    await expect(withGenerationRetry(operation, { label: 'test', maxRetries: 8, sleep: async () => {} })).rejects.toThrow('unavailable');
    expect(operation).toHaveBeenCalledTimes(3);
  });
  it('never retries a cancelled request', async () => {
    const operation = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    await expect(withGenerationRetry(operation, {
      label: 'cancelled course request',
      maxRetries: 2,
      sleep: async () => {},
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).toHaveBeenCalledOnce();
  });
  it('does not let result validation schedule another generation', async () => {
    const operation = vi.fn().mockResolvedValue(null);
    expect(await withGenerationRetry(operation, { label: 'test', shouldRetryResult: () => true })).toBeNull();
    expect(operation).toHaveBeenCalledOnce();
  });
  it.each([409, 425, 401, 403, 422, 501])('does not retry HTTP %s', (statusCode) => {
    expect(isRetryableGenerationError({ statusCode, isRetryable: true })).toBe(false);
  });
  it('honors an upstream retryAfterMs hint for throttled requests', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const throttled = Object.assign(new Error('rate limit exceeded'), {
      statusCode: 429,
      retryAfterMs: 45_000,
    });
    const operation = vi.fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValueOnce('ok');

    await expect(withGenerationRetry(operation, {
      label: 'qwen image',
      maxRetries: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      sleep,
      random: () => 0,
    })).resolves.toBe('ok');

    expect(sleep).toHaveBeenCalledWith(45_000, undefined);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries a course-generation LLM timeout without treating it as cancellation', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn()
      .mockRejectedValueOnce(new LlmTimeoutError(600_000))
      .mockResolvedValueOnce('complete outline');

    await expect(withGenerationRetry(operation, {
      label: 'course outline',
      maxRetries: 1,
      sleep,
      random: () => 0,
    })).resolves.toBe('complete outline');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error('terminated'),
    new Error('terminated', { cause: new Error('closed') }),
    new TypeError('terminated', { cause: new Error('closed') }),
    new Error('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9999'),
    new Error('Cannot connect to API: other side closed'),
    Object.assign(new Error('Cannot connect to API: other side closed'), {
      name: 'AI_APICallError', isRetryable: true,
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }),
    { cause: { code: 'UND_ERR_SOCKET' } },
  ])('waits for an interrupted local proxy transport to recover: %s', async (transportError) => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockRejectedValueOnce(transportError).mockResolvedValueOnce('complete');

    expect(isRetryableGenerationError(transportError)).toBe(true);
    expect(generationRetryAfterMs(transportError)).toBe(10_000);
    await expect(withGenerationRetry(operation, {
      label: 'proxied course generation', maxRetries: 1, sleep, random: () => 0,
    })).resolves.toBe('complete');
    expect(sleep).toHaveBeenCalledWith(10_000, undefined);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not regenerate an empty successful upstream response', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new LlmEmptyResponseError())
      .mockResolvedValueOnce('valid JSON');

    await expect(withGenerationRetry(operation, {
      label: 'course design JSON',
      maxRetries: 1,
      sleep: vi.fn().mockResolvedValue(undefined),
      random: () => 0,
    })).rejects.toBeInstanceOf(LlmEmptyResponseError);
    expect(operation).toHaveBeenCalledOnce();
  });

  it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET', 'EAI_AGAIN'])(
    'recognizes structured transport code %s through an SDK wrapper', (code) => {
      expect(isRetryableGenerationError({ isRetryable: true, cause: { code } })).toBe(true);
    },
  );

  it.each([
    { isRetryable: true, cause: { statusCode: 401 } },
    { isRetryable: true, cause: { isRetryable: false, code: 'UND_ERR_SOCKET' } },
    new TypeError('terminated', { cause: { statusCode: 401 } }),
    new TypeError('terminated', { cause: new Error('401 unauthorized') }),
    new TypeError('terminated', { cause: { isRetryable: false } }),
    new TypeError('terminated', { cause: { code: 'UND_ERR_INVALID_ARG' } }),
    { statusCode: 403, cause: { code: 'UND_ERR_SOCKET' } },
    { name: 'AbortError', cause: { code: 'UND_ERR_SOCKET' } },
    { code: 'UND_ERR_INVALID_ARG' },
  ])('keeps terminal errors authoritative: %j', (error) => {
    expect(isRetryableGenerationError(error)).toBe(false);
  });

  it('caps repeated SDK socket failures at the configured request budget', async () => {
    const error = Object.assign(new Error('Cannot connect to API: other side closed'), {
      isRetryable: true, cause: { code: 'UND_ERR_SOCKET' },
    });
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withGenerationRetry(operation, {
      label: 'scene-content', maxRetries: 1, sleep,
    })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000, undefined);
  });

  it('does not infer a network failure from an unknown finish reason', () => {
    expect(isRetryableGenerationError(new Error(
      'An error occurred in model serving, error message is: [Inference engine abort. Finish reason: [UNKNOWN].]',
    ))).toBe(false);
  });

  it.each(['AI_EmptyResponseBodyError', 'AI_NoOutputGeneratedError'])(
    'does not regenerate %s without an explicit transport failure',
    (name) => {
      const error = new Error('No output generated.');
      error.name = name;
      expect(isRetryableGenerationError(error)).toBe(false);
    },
  );

  it('keeps transient provider metadata when page context is added', () => {
    const providerError = Object.assign(new Error('model serving aborted'), {
      isRetryable: true,
      code: 'UPSTREAM_ABORT',
      statusCode: 503,
    });

    const contextualized = contextualizeGenerationError(providerError, 'Scene 1/8 failed');

    expect(contextualized.message).toContain('Scene 1/8 failed');
    expect(contextualized.cause).toBe(providerError);
    expect(contextualized).toMatchObject({
      isRetryable: true,
      code: 'UPSTREAM_ABORT',
      statusCode: 503,
    });
    expect(isRetryableGenerationError(contextualized)).toBe(true);
  });

  it('recognizes a provider InternalError retained inside an SDK validation error', () => {
    const sdkError = Object.assign(new Error('Type validation failed'), {
      value: {
        code: 'InternalError',
        message: 'Receive batching backend response failed!',
        request_id: 'request-123',
      },
    });
    expect(isRetryableGenerationError(sdkError)).toBe(true);
  });

  it('keeps exhausted request budgets terminal when page context is added', () => {
    const exhausted = Object.assign(new Error('upstream timeout'), { statusCode: 503, isRetryable: false });
    const contextualized = contextualizeGenerationError(exhausted, 'Scene 1/8 failed');
    expect(contextualized).toMatchObject({ statusCode: 503, isRetryable: false });
    expect(isRetryableGenerationError(contextualized)).toBe(false);
  });

  it('allows a caller to separate same-resource retries from regeneration', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const expiredUrl = Object.assign(new Error('signed URL expired'), {
      statusCode: 403,
      isRetryable: true,
    });
    const operation = vi.fn().mockRejectedValue(expiredUrl);

    await expect(withGenerationRetry(operation, {
      label: 'generated resource download',
      maxRetries: 3,
      shouldRetryError: (error) => !(error && typeof error === 'object' && 'statusCode' in error),
      sleep,
    })).rejects.toBe(expiredUrl);

    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
