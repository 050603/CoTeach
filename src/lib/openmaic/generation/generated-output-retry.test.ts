import { describe, expect, it, vi } from 'vitest';
import {
  invalidGeneratedOutput,
  withGeneratedOutputRetry,
} from './generated-output-retry';

describe('generated output retry policy', () => {
  it('retries malformed completed output and then returns the usable artifact', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(invalidGeneratedOutput(new Error('invalid JSON'), 'outline'))
      .mockResolvedValueOnce({ sections: [] });

    await expect(withGeneratedOutputRetry(operation, {
      label: 'outline',
      maxRetries: 2,
      sleep: async () => undefined,
      onRetry: () => undefined,
    })).resolves.toEqual({ sections: [] });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry semantic or quality findings', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('案例解释不够充分'));
    await expect(withGeneratedOutputRetry(operation, { label: 'outline' }))
      .rejects.toThrow('案例解释不够充分');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
