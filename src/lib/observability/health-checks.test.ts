// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ websocket: vi.fn(), query: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query }, isDatabaseConfigured: () => true }));
vi.mock('@/lib/redis/client', () => ({ getRedisClient: async () => ({ ping: async () => 'PONG' }) }));
vi.mock('@/lib/project-practice/document-conversion-pool', () => ({ documentConversionHealth: () => ({ ok: true }) }));
vi.mock('@/lib/realtime/websocket-lifecycle', () => ({ webSocketReadiness: mocks.websocket }));
vi.mock('@openmaic/lib/server/provider-config', () => ({ getServerProviders: () => ({ test: {} }), resolveBaseUrl: () => null }));
vi.mock('node:fs/promises', () => ({ open: async () => ({ writeFile: async () => {}, sync: async () => {}, close: async () => {} }), unlink: async () => {} }));
import { runReadinessChecks } from './health-checks';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('ENABLE_WEBSOCKET', 'true'); });
afterEach(() => vi.unstubAllEnvs());
it('does not report ready while enabled websocket is still binding or failed', async () => {
  mocks.websocket.mockReturnValue({ ok: false, error: 'websocket_not_listening' });
  expect(await runReadinessChecks()).toMatchObject({ ok: false, dependencies: { db: { ok: true }, websocket: { ok: false } } });
});
it('requires actual websocket listening in addition to the other dependencies', async () => {
  mocks.websocket.mockReturnValue({ ok: true });
  expect(await runReadinessChecks()).toMatchObject({ ok: true, dependencies: { websocket: { ok: true } } });
});
it('does not require a websocket listener when the feature is disabled', async () => {
  vi.stubEnv('ENABLE_WEBSOCKET', 'false');
  const result = await runReadinessChecks();
  expect(result.ok).toBe(true); expect(result.dependencies).not.toHaveProperty('websocket'); expect(mocks.websocket).not.toHaveBeenCalled();
});
