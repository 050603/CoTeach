import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { createCourseGenerationAiCall } from './course-generation-ai-call';
import { withAuxiliaryAuthoring, type AuxiliaryAuthoringState, type AuxiliaryAuthoringHooks } from './auxiliary-authoring';
import { buildSearchQuery } from './search-query-builder';
const mocks = vi.hoisted(() => ({ stream: vi.fn(), call: vi.fn() }));
vi.mock('../ai/llm', () => ({ callStreamingLLMText: mocks.stream, callLLM: mocks.call }));
beforeEach(() => vi.clearAllMocks());
function store() {
  let state: AuxiliaryAuthoringState | null = null;
  const hooks: AuxiliaryAuthoringHooks = {
    loadAuxiliaryAuthoringState: vi.fn(() => state),
    onAuxiliaryAuthoringAttempt: vi.fn((input) => { state = { ...input }; }),
    onAuxiliaryAuthoringResponse: vi.fn((input) => { state = { ...input, attemptsStarted: state?.attemptsStarted ?? 1, rawResponse: input.text }; }),
  };
  return { hooks, state: () => state };
}
const adapter = (onResponse = vi.fn()) => createCourseGenerationAiCall({ model: {} as LanguageModel,
  vision: false, source: 'aux', streamResponse: true, onResponse, requireResponsePersistence: true });
describe('durable auxiliary first-pass authoring', () => {
  it('records one successful response and restores it across invocations without a provider request', async () => {
    const saved = store();
    const diagnostic = vi.fn();
    mocks.stream.mockResolvedValue('{"query":"source facts"}');
    const first = withAuxiliaryAuthoring(adapter(diagnostic), 'search-query', 'm', saved.hooks);
    expect(await first('system', 'prompt')).toBe('{"query":"source facts"}');
    const restored = withAuxiliaryAuthoring(adapter(diagnostic), 'search-query', 'm', saved.hooks);
    expect(await restored('system', 'prompt')).toBe('{"query":"source facts"}');
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(saved.hooks.onAuxiliaryAuthoringAttempt).toHaveBeenCalledOnce();
    expect(saved.hooks.onAuxiliaryAuthoringResponse).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledOnce();
  });
  it.each(['{"query":', '{"query":"complete-looking query"}'])('preserves truncated text and never parses it as a completed search: %s', async (rawResponse) => {
    const saved = store();
    mocks.stream.mockRejectedValue(Object.assign(new Error('truncated'), { code: 'LLM_STREAM_TRUNCATED', rawResponse, isRetryable: false }));
    const make = () => withAuxiliaryAuthoring(adapter(), 'search-query', 'm', saved.hooks);
    await expect(buildSearchQuery('教材主题', '原始资料', make())).rejects.toThrow('搜索查询首稿未通过验收');
    expect(saved.state()).toMatchObject({ rawResponse, complete: false });
    await expect(buildSearchQuery('教材主题', '原始资料', make())).rejects.toThrow('搜索查询首稿未通过验收');
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
  it('does not fall back or rewrite an invalid complete query response', async () => {
    const saved = store();
    mocks.stream.mockResolvedValue('{"query":""}');
    const make = () => withAuxiliaryAuthoring(adapter(), 'search-query', 'm', saved.hooks);
    for (let index = 0; index < 2; index += 1) {
      await expect(buildSearchQuery('教材主题', '原始资料', make())).rejects.toThrow('搜索查询首稿未通过验收');
    }
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
  it('stops on raw storage failure and keeps the spent attempt blocking another request', async () => {
    const saved = store();
    saved.hooks.onAuxiliaryAuthoringResponse = vi.fn(() => { throw new Error('storage unavailable'); });
    mocks.stream.mockResolvedValue('{"query":"source facts"}');
    const make = () => withAuxiliaryAuthoring(adapter(), 'search-query', 'm', saved.hooks);
    await expect(buildSearchQuery('教材主题', '原始资料', make())).rejects.toThrow();
    await expect(buildSearchQuery('教材主题', '原始资料', make())).rejects.toThrow();
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(saved.state()?.attemptsStarted).toBe(1);
  });
  it.each(['prompt', 'model'])('does not treat %s fingerprint drift as permission for another draft', async (changed) => {
    const saved = store();
    mocks.stream.mockResolvedValue('original');
    await withAuxiliaryAuthoring(adapter(), 'agent-profiles', 'm', saved.hooks)('system', 'prompt');
    const next = withAuxiliaryAuthoring(adapter(), 'agent-profiles', changed === 'model' ? 'other' : 'm', saved.hooks);
    await expect(next('system', changed === 'prompt' ? 'changed prompt' : 'prompt')).rejects.toThrow('已消耗首稿请求');
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
  it('does not call the provider when attempt persistence fails', async () => {
    const hooks = { onAuxiliaryAuthoringAttempt: vi.fn(() => { throw new Error('write unavailable'); }) };
    const call = withAuxiliaryAuthoring(adapter(), 'freeform-outlines', 'm', hooks);
    await expect(call('system', 'prompt')).rejects.toThrow('首稿未完成');
    await expect(call('system', 'prompt')).rejects.toThrow('已消耗首稿请求');
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('records plain offline adapters through the fallback boundary', async () => {
    const saved = store();
    const plain = vi.fn().mockResolvedValue('raw');
    const call = withAuxiliaryAuthoring(plain, 'freeform-outlines', 'm', saved.hooks);
    expect(await call('s', 'p')).toBe('raw');
    expect(await call('s', 'p')).toBe('raw');
    expect(plain).toHaveBeenCalledOnce();
    expect(saved.hooks.onAuxiliaryAuthoringResponse).toHaveBeenCalledOnce();
    expect(saved.state()?.complete).toBe(true);
  });
});
