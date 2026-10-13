import { isAuthConfigured } from './session';
import { authenticateRequest } from './request-guards';
import { checkDistributedRateLimit } from './distributed-rate-limit';
import { rateLimitedResponse } from './rate-limit';

/** A classroom commonly shares one NAT address; quotas belong to authenticated users. */
export async function checkMediaRateLimit(request: Request, kind: 'tts' | 'image'): Promise<Response | null> {
  if (!isAuthConfigured()) return null;
  const authentication = await authenticateRequest(request);
  if ('response' in authentication) return authentication.response;
  const result = await checkDistributedRateLimit({
    namespace: `media-${kind}`, key: authentication.claims.sub!,
    limit: kind === 'tts' ? 30 : 20, windowSeconds: 60,
  });
  return result.allowed ? null : rateLimitedResponse(result.retryAfterMs);
}
