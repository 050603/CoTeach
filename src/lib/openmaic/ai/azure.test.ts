import { describe, expect, it } from 'vitest';

import { normalizeAzureBaseUrl } from './azure';

describe('normalizeAzureBaseUrl', () => {
  it('normalizes portal deployment and operation URLs', () => {
    expect(
      normalizeAzureBaseUrl(
        'https://school.openai.azure.com/openai/deployments/course/chat/completions?api-version=2025-01-01',
      ),
    ).toBe('https://school.openai.azure.com/openai');
  });

  it('leaves compatible Azure base paths intact', () => {
    expect(normalizeAzureBaseUrl('https://example.test/azure/v1/')).toBe(
      'https://example.test/azure/v1',
    );
  });
});
