import { describe, expect, it } from 'vitest';

import { getModel, getModelInfo, getProvider } from './providers';

describe('OpenMAIC provider catalog synchronization', () => {
  it('keeps the current DeepSeek catalog and compatible endpoint support', () => {
    const provider = getProvider('deepseek');
    expect(provider).toMatchObject({
      type: 'openai',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
    });
    expect(provider?.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'deepseek-v4.1-flash',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
      ]),
    );

    expect(getModelInfo('deepseek', 'deepseek-v4.1-flash')).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1048576,
      outputWindow: 393216,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
  });

  it('accepts the V4.1 release name while calling DeepSeek with its API model ID', () => {
    const { model, modelInfo } = getModel({
      providerId: 'deepseek',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'test-key',
    });

    expect((model as { modelId: string }).modelId).toBe('deepseek-flash');
    expect(modelInfo?.id).toBe('deepseek-v4.1-flash');
  });

  it('preserves the configured model ID for a compatible DeepSeek gateway', () => {
    const { model } = getModel({
      providerId: 'deepseek',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'test-key',
      baseUrl: 'https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    });

    expect((model as { modelId: string }).modelId).toBe('deepseek-v4.1-flash');
  });

  it('registers the new Azure, Atlas Cloud, and Bedrock providers', () => {
    expect(getProvider('azure')).toMatchObject({ type: 'azure', requiresApiKey: true });
    expect(getProvider('atlascloud')).toMatchObject({
      type: 'openai',
      defaultBaseUrl: 'https://api.atlascloud.ai/v1',
    });
    expect(getProvider('bedrock')).toMatchObject({
      type: 'bedrock',
      requiresApiKey: false,
      icon: '/logos/bedrock.svg',
    });
  });

  it('includes current upstream model generations', () => {
    expect(getProvider('openai')?.models.some((model) => model.id === 'gpt-5.6')).toBe(true);
    expect(getProvider('anthropic')?.models.some((model) => model.id === 'claude-sonnet-5')).toBe(
      true,
    );
    expect(getProvider('google')?.models.some((model) => model.id === 'gemini-3.6-flash')).toBe(
      true,
    );
    expect(getProvider('kimi')?.models.some((model) => model.id === 'kimi-k3')).toBe(true);
  });
});
