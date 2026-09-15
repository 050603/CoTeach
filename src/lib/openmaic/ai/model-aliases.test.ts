import { describe, expect, it } from 'vitest';

import { findModelById, getCanonicalModelId, modelIdsMatch } from './model-aliases';

describe('model aliases', () => {
  it('canonicalizes GPT-5.6 Sol only for OpenAI', () => {
    expect(getCanonicalModelId('openai', 'gpt-5.6-sol')).toBe('gpt-5.6');
    expect(getCanonicalModelId('openrouter', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('maps the DeepSeek V4.1 release name to its public API model ID', () => {
    expect(getCanonicalModelId('deepseek', 'deepseek-v4.1-flash')).toBe('deepseek-flash');
    expect(modelIdsMatch('deepseek', 'deepseek-v4.1-flash', 'deepseek-flash')).toBe(true);
  });

  it('finds an alias through its canonical model ID', () => {
    const models = [
      { id: 'gpt-5.6-sol', vision: false },
      { id: 'gpt-5.6', vision: true },
    ];

    expect(modelIdsMatch('openai', 'gpt-5.6', 'gpt-5.6-sol')).toBe(true);
    expect(findModelById('openai', models, 'gpt-5.6-sol')).toBe(models[1]);
  });
});
