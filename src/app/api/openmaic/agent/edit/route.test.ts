// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), enabled: vi.fn(), hydrate: vi.fn(), model: vi.fn(), tools: vi.fn(),
  agent: vi.fn(), stream: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@openmaic/lib/config/feature-flags', () => ({ isMaicEditorEnabled: mocks.enabled }));
vi.mock('@openmaic/lib/agent/server/teaching-source-context', () => ({ hydrateAgentTeachingSourceContexts: mocks.hydrate }));
vi.mock('@openmaic/lib/server/resolve-model', () => ({ resolveModelFromRequest: mocks.model }));
vi.mock('@openmaic/lib/agent/runtime/stream-fn', () => ({ createCallLlmStreamFn: mocks.stream }));
vi.mock('@openmaic/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.agent, buildSystemPrompt: () => 'system' }));
vi.mock('@openmaic/lib/agent/tools/registry', () => ({ buildToolset: mocks.tools }));
vi.mock('@openmaic/lib/ai/llm', () => ({ callLLM: mocks.call }));
vi.mock('@openmaic/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
import { POST } from './route';
const request = (body: Record<string, unknown>) => new Request('http://localhost/api/openmaic/agent/edit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}) as NextRequest;
beforeEach(() => {
  vi.clearAllMocks(); mocks.authorize.mockResolvedValue('teacher'); mocks.enabled.mockReturnValue(false);
  mocks.model.mockResolvedValue({ model: {}, modelString: 'test' }); mocks.hydrate.mockResolvedValue({});
  mocks.agent.mockReturnValue({ subscribe: () => () => {}, prompt: async () => {}, waitForIdle: async () => {}, abort: vi.fn() });
});
describe('agent edit trusted course context', () => {
  it('rejects an unauthorized course before any source read or model resolution', async () => {
    mocks.authorize.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const response = await POST(request({ courseId: 'foreign', message: '重设计这页' }));
    expect(response.status).toBe(403); expect(mocks.hydrate).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
  });
  it('passes only the authorized course to hydration and exposes its server result to tools', async () => {
    const client = { scene: { teachingSources: { forged: true } } };
    const server = { scene: { teachingSourceDiagnostic: '缺少原来源，保留现有页面' } };
    mocks.hydrate.mockResolvedValue(server);
    const response = await POST(request({ courseId: ' course ', message: '重设计这页', sceneContextMap: client }));
    await response.text();
    expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Request), 'course');
    expect(mocks.hydrate).toHaveBeenCalledWith({ authorizedCourseId: 'course', sceneContextMap: client });
    expect(mocks.tools.mock.calls[0]![0].getSceneContext('scene')).toEqual(server.scene);
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.hydrate.mock.invocationCallOrder[0]!);
    expect(mocks.hydrate.mock.invocationCallOrder[0]).toBeLessThan(mocks.model.mock.invocationCallOrder[0]!);
  });
  it('does not infer a course scope for enabled standalone editing', async () => {
    mocks.enabled.mockReturnValue(true);
    const response = await POST(request({ message: '查看这页', sceneContextMap: {} })); await response.text();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.hydrate).toHaveBeenCalledWith({ authorizedCourseId: undefined, sceneContextMap: {} });
    expect(response.status).toBe(200);
  });
});
