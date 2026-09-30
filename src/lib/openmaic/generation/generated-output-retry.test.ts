import { describe, expect, it, vi } from 'vitest';
import {
  invalidGeneratedOutput,
  withGeneratedOutputRetry,
} from './generated-output-retry';

describe('generated output retry policy', () => {
  it('keeps malformed first output as a failure without a second authoring call', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(invalidGeneratedOutput(new Error('invalid JSON'), 'outline'))
      .mockResolvedValueOnce({ sections: [] });

    await expect(withGeneratedOutputRetry(operation, {
      label: 'outline',
      maxRetries: 2,
      sleep: async () => undefined,
      onRetry: () => undefined,
    })).rejects.toThrow('invalid JSON');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry semantic or quality findings', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('案例解释不够充分'));
    await expect(withGeneratedOutputRetry(operation, { label: 'outline' }))
      .rejects.toThrow('案例解释不够充分');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
