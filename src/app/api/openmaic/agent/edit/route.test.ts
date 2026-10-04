import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SceneContext } from '@openmaic/lib/agent/tools/regenerate-scene-actions';
import type { ToolsetDeps } from '@openmaic/lib/agent/tools/registry';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), load: vi.fn(), resolve: vi.fn(), call: vi.fn(), toolset: vi.fn(),
  agent: { subscribe: vi.fn(), prompt: vi.fn(), waitForIdle: vi.fn(), abort: vi.fn() } }));
vi.mock('@/lib/platform/template-access', () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock('@/lib/platform/pbl-template-repository', () => ({ loadPblTemplateCourse: mocks.load }));
vi.mock('@openmaic/lib/server/resolve-model', () => ({ resolveModelFromRequest: mocks.resolve }));
vi.mock('@openmaic/lib/ai/llm', () => ({ callLLM: mocks.call }));
vi.mock('@openmaic/lib/config/feature-flags', () => ({ isMaicEditorEnabled: () => true }));
vi.mock('@openmaic/lib/agent/runtime/stream-fn', () => ({ createCallLlmStreamFn: vi.fn() }));
vi.mock('@openmaic/lib/agent/tools/registry', () => ({ buildToolset: mocks.toolset }));
vi.mock('@openmaic/lib/agent/runtime/build-agent', () => ({ buildAgent: () => mocks.agent, buildSystemPrompt: () => 'editor prompt' }));
import { POST } from './route';

const privateSource = '服务端教材完整原文，不向编辑器的工具结果泄露整个教材。';
const course = { content: { courseEvidence: { schemaVersion: 2, version: 4, fingerprint: 'authorized-current-source',
  items: [{ id: 'evidence', content: privateSource }], mappings: [], selections: [] }, knowledgePoints: [] } };
const context = { stageId: 'stage', outline: { id: 'page', type: 'slide', keyPoints: ['已保存页面职责'] }, allOutlines: [],
  content: { type: 'slide', canvas: { elements: [] } }, actions: [{ id: 'speech', type: 'speech', text: '当前手改讲稿', audioUrl: '/saved.wav' }],
  sourceEvidence: { fingerprint: 'client-stale' } } as unknown as SceneContext;
const request = (courseId = 'course') => new Request('http://localhost/api/openmaic/agent/edit', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '仅重绘PPT，保留讲稿', courseId,
    scene: { id: 'scene', title: '概念' }, sceneContextMap: { scene: context } }) }) as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue('owner');
  mocks.load.mockResolvedValue(course);
  mocks.resolve.mockResolvedValue({ model: {}, modelString: 'test', modelInfo: { outputWindow: 16000, capabilities: { vision: false } } });
  mocks.call.mockResolvedValue({ text: 'native response' });
  mocks.toolset.mockReturnValue([]);
  mocks.agent.subscribe.mockReturnValue(() => {});
  mocks.agent.prompt.mockResolvedValue(undefined);
  mocks.agent.waitForIdle.mockResolvedValue(undefined);
});

describe('authorized PPT redraw source loading', () => {
  it('loads authoritative source facts after ownership authorization, keeping teacher edits and source data server-only', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
    expect(mocks.load).toHaveBeenCalledWith('course');
    const deps = mocks.toolset.mock.calls[0][0] as ToolsetDeps;
    const loaded = deps.getSceneContext('scene');
    expect(loaded?.sourceEvidence).toBe(course.content.courseEvidence);
    expect(loaded?.outline).toEqual(context.outline);
    expect(loaded?.actions).toEqual(context.actions);
    expect(await deps.assertCurrentSources?.()).toBe(true);
    mocks.load.mockResolvedValue({ content: { ...course.content, courseEvidence: { ...course.content.courseEvidence, fingerprint: 'changed-in-flight' } } });
    expect(await deps.assertCurrentSources?.()).toBe(false);
    expect(await response.text()).not.toContain(privateSource);
  });

  it('never loads private course evidence or starts a model when authorization fails', async () => {
    mocks.authorize.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.toolset).not.toHaveBeenCalled();
  });

  it('does not silently use client evidence when an authorized design is missing', async () => {
    mocks.load.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.toolset).not.toHaveBeenCalled();
  });

  it('preserves standalone editing and only adds actual supported image inputs to the stage model call', async () => {
    const response = await POST(request(''));
    await response.text();
    expect(mocks.load).not.toHaveBeenCalled();
    const deps = mocks.toolset.mock.calls[0][0] as ToolsetDeps;
    await deps.aiCall('scene-content:slide', 'system', 'prompt', undefined, [{ id: 'figure', src: 'https://example.com/source.png' }]);
    expect(mocks.call.mock.calls[0][0]).toMatchObject({ system: 'system', messages: [{ role: 'user', content: 'prompt' }], maxOutputTokens: 16000 });
    mocks.resolve.mockResolvedValue({ model: {}, modelInfo: { outputWindow: 16000, capabilities: { vision: true } } });
    const next = await POST(request('')); await next.text();
    const visionDeps = mocks.toolset.mock.calls[1][0] as ToolsetDeps;
    await visionDeps.aiCall('scene-content:slide', 'system', 'prompt', undefined, [{ id: 'figure', src: 'https://example.com/source.png' }]);
    expect(mocks.call.mock.calls[1][0]).toMatchObject({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'prompt' }, { type: 'text', text: 'Image reference: figure' },
      { type: 'file', data: 'https://example.com/source.png', mediaType: 'image/*' },
    ] }] });
  });
});
