import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  scenarioThinking: vi.fn(),
}));

vi.mock('@openmaic/lib/ai/providers', () => ({
  parseModelString: () => ({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash' }),
  getModel: () => ({ model: { provider: 'deepseek', modelId: 'deepseek-v4.1-flash' }, modelInfo: null }),
}));

vi.mock('@openmaic/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => true,
  resolveApiKey: () => 'test-key',
  resolveBaseUrl: () => 'https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  resolveProxy: () => undefined,
  findServerDefaultModelString: () => 'deepseek:deepseek-v4.1-flash',
  resolveServerThinkingConfig: mocks.scenarioThinking,
}));

vi.mock('@openmaic/lib/server/model-routes', () => ({
  getStageRoute: mocks.route,
}));

vi.mock('@openmaic/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: vi.fn() }));

import { resolveModel } from './resolve-model';

describe('model thinking precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.mockReturnValue(undefined);
    mocks.scenarioThinking.mockReturnValue(undefined);
  });

  it('lets a teacher scenario override a per-request choice', async () => {
    mocks.scenarioThinking.mockReturnValue({ mode: 'enabled', effort: 'max' });

    const resolved = await resolveModel({
      stage: 'scene-content',
      thinkingConfig: { mode: 'enabled', effort: 'low' },
    });

    expect(resolved.thinkingConfig).toEqual({ mode: 'enabled', effort: 'max' });
  });

  it('keeps an explicit operator route above the teacher scenario', async () => {
    mocks.route.mockReturnValue({
      model: 'deepseek:deepseek-v4.1-flash',
      thinking: { mode: 'enabled', effort: 'high' },
    });
    mocks.scenarioThinking.mockReturnValue({ mode: 'enabled', effort: 'max' });

    const resolved = await resolveModel({ stage: 'scene-content' });

    expect(resolved.thinkingConfig).toEqual({ mode: 'enabled', effort: 'high' });
  });

  it('preserves the old baseline when no scenario override exists', async () => {
    const requestThinking = { mode: 'enabled' as const, effort: 'low' as const };
    const resolved = await resolveModel({
      stage: 'scene-content',
      thinkingConfig: requestThinking,
    });

    expect(resolved.thinkingConfig).toEqual(requestThinking);
  });
});
