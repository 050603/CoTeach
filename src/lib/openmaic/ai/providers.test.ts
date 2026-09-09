import { describe, expect, it } from 'vitest';

import { getProvider } from './providers';

describe('OpenMAIC provider catalog synchronization', () => {
  it('keeps the current DeepSeek catalog and compatible endpoint support', () => {
    const provider = getProvider('deepseek');
    expect(provider).toMatchObject({
      type: 'openai',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
    });
    expect(provider?.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
      ]),
    );
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
