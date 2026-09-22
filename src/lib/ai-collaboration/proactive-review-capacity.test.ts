import { describe, expect, it } from 'vitest';

import {
  createProactiveReviewCapacity,
  ProactiveReviewCapacityError,
} from './proactive-review-capacity';

describe('proactive document review capacity', () => {
  it('rejects overflow immediately and frees the slot after completion', async () => {
    const capacity = createProactiveReviewCapacity(1, 42_000);
    let release!: () => void;
    const first = capacity.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    await expect(capacity.run(async () => 'overflow')).rejects.toEqual(
      expect.objectContaining<Partial<ProactiveReviewCapacityError>>({
        name: 'ProactiveReviewCapacityError',
        retryAfterMs: 42_000,
      }),
    );
    expect(capacity.snapshot()).toEqual({ active: 1, limit: 1 });

    release();
    await first;
    await expect(capacity.run(async () => 'available')).resolves.toBe('available');
    expect(capacity.snapshot()).toEqual({ active: 0, limit: 1 });
  });
});
