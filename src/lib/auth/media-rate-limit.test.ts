import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), check: vi.fn() }));
vi.mock('./session', () => ({ isAuthConfigured: () => true }));
vi.mock('./request-guards', () => ({ authenticateRequest: mocks.authenticate }));
vi.mock('./distributed-rate-limit', () => ({ checkDistributedRateLimit: mocks.check }));
import { checkMediaRateLimit } from './media-rate-limit';

describe('campus media quotas', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('keeps thirty students on the same campus IP in independent buckets', async () => {
    const counts = new Map<string, number>();
    mocks.authenticate.mockImplementation(async (request: Request) => ({ claims: { sub: request.headers.get('test-user') } }));
    mocks.check.mockImplementation(async ({ key, limit }: { key: string; limit: number }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { allowed: counts.get(key)! <= limit, retryAfterMs: 10_000 };
    });
    const request = (user: string) => new Request('http://localhost/api/openmaic/generate/tts', {
      headers: { 'x-real-ip': '10.0.0.1', 'test-user': user },
    });
    for (let user = 0; user < 30; user++) {
      for (let turn = 0; turn < 2; turn++) expect(await checkMediaRateLimit(request(`student-${user}`), 'tts')).toBeNull();
    }
    expect(counts.size).toBe(30);
    for (let turn = 0; turn < 28; turn++) await checkMediaRateLimit(request('student-0'), 'tts');
    expect((await checkMediaRateLimit(request('student-0'), 'tts'))?.status).toBe(429);
    expect(await checkMediaRateLimit(request('student-1'), 'tts')).toBeNull();
  });
  it('rejects expired identities before using a media quota', async () => {
    mocks.authenticate.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await checkMediaRateLimit(new Request('http://localhost'), 'image'))?.status).toBe(401);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
