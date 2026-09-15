import { apiError } from './api-response';
import { generationRetryAfterMs, isRetryableGenerationError } from '../generation/generation-retry';

/** Keep structural/provider failures distinct when crossing the browser API boundary. */
export function mediaGenerationErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const response = apiError('GENERATION_FAILED', 500, message);
  response.headers.set('x-generation-retryable', String(isRetryableGenerationError(error)));
  const delay = generationRetryAfterMs(error);
  if (delay !== undefined) response.headers.set('Retry-After', String(Math.ceil(delay / 1000)));
  return response;
}
