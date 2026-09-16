import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
}));

vi.mock('@/lib/auth/request-guards', () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock('@openmaic/lib/server/provider-config', () => ({
  initializeServerProviderConfig: vi.fn(),
  getServerProviders: () => ({ qwen: { models: ['qwen-plus'] } }),
  getServerTTSProviders: () => ({ 'qwen-tts': { defaultModel: 'qwen3-tts-flash' } }),
  getServerASRProviders: () => ({ 'qwen-asr': { defaultModel: 'qwen3-asr-flash' } }),
  getServerPDFProviders: () => ({}),
  getServerImageProviders: () => ({}),
  getServerVideoProviders: () => ({}),
  getServerWebSearchProviders: () => ({}),
  getClassroomSceneConcurrency: () => 1,
  getParallelSceneConcurrency: () => 2,
}));

import { GET } from './route';

describe('GET /api/server-providers', () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockReset();
  });

  it('allows an authenticated student to read redacted provider capabilities', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      claims: { role: 'student', sub: 'student-1' },
    });
    const request = new Request('http://localhost/api/server-providers', {
      headers: { 'x-openpbl-role': 'student' },
    });

    const response = await GET(request);
    const body = await response.json();

    expect(mocks.authenticateRequest).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(body.asr).toEqual({ 'qwen-asr': { defaultModel: 'qwen3-asr-flash' } });
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(JSON.stringify(body)).not.toContain('baseUrl');
  });

  it('keeps rejecting unauthenticated requests', async () => {
    mocks.authenticateRequest.mockResolvedValue({
      response: Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
    });

    const response = await GET(new Request('http://localhost/api/server-providers'));

    expect(response.status).toBe(401);
  });
});
