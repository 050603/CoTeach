// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ws: vi.fn(), audit: vi.fn(), eventBus: vi.fn(), archive: vi.fn(), shutdown: vi.fn() }));
vi.mock('@/lib/config/env', () => ({ assertProductionEnvironment: () => {} }));
vi.mock('@/lib/network/environment-http-proxy', () => ({ installEnvironmentHttpProxy: () => {} }));
vi.mock('@/lib/openmaic/server/provider-config', () => ({ initializeServerProviderConfig: async () => {} }));
vi.mock('@/lib/project-practice/document-archive', () => ({ initializeProjectDocumentArchive: mocks.archive }));
vi.mock('@/lib/project-practice/document-conversion-pool', () => ({ stopDocumentConversionPool: async () => {} }));
vi.mock('@/lib/runtime/lifecycle', () => ({ registerShutdownHook: mocks.shutdown, SHUTDOWN_TIMEOUT_MS: 10000, beginShutdown: async () => {} }));
vi.mock('@/lib/observability/metrics', () => ({}));
vi.mock('@/lib/course-generation/capability', () => ({ isBackgroundCourseGenerationEnabled: () => false }));
vi.mock('@/lib/realtime/event-bus', () => ({ initializeEventBus: mocks.eventBus }));
vi.mock('@/lib/realtime/websocket-server', () => ({ startWebSocketServer: mocks.ws }));
vi.mock('@/lib/ai-collaboration/audit-outbox', () => ({ startAiAuditOutbox: mocks.audit }));
vi.mock('@/lib/observability/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.ws.mockReset();
  vi.stubEnv('ENABLE_WEBSOCKET', 'true'); vi.stubEnv('ENABLE_TLDRAW_SYNC', 'false');
  vi.spyOn(process, 'on').mockReturnValue(process);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('awaits WS listening before registration finishes and shares concurrent registration', async () => {
  let ready!: () => void;
  mocks.ws.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  const { register } = await import('./instrumentation-node');
  const startup = register(); expect(register()).toBe(startup);
  await vi.waitFor(() => expect(mocks.ws).toHaveBeenCalledOnce());
  expect(mocks.audit).not.toHaveBeenCalled();
  ready(); await startup;
  expect(mocks.audit).toHaveBeenCalledOnce();
  await register(); expect(mocks.ws).toHaveBeenCalledOnce();
});
it('propagates bind errors instead of marking registration complete and permits retry', async () => {
  mocks.ws.mockRejectedValueOnce(Error('EADDRINUSE')).mockResolvedValueOnce({});
  const { register } = await import('./instrumentation-node');
  await expect(register()).rejects.toThrow('EADDRINUSE'); expect(mocks.audit).not.toHaveBeenCalled();
  await register(); expect(mocks.ws).toHaveBeenCalledTimes(2); expect(mocks.audit).toHaveBeenCalledOnce();
});
it('does not start a websocket listener when disabled', async () => {
  vi.stubEnv('ENABLE_WEBSOCKET', 'false');
  const { register } = await import('./instrumentation-node'); await register();
  expect(mocks.ws).not.toHaveBeenCalled(); expect(mocks.audit).toHaveBeenCalledOnce();
});
