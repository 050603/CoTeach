// Phase 2.9 PoC: 验证 OpenMAIC 核心算法测试可在 CoTeach 中跑通
// 迁移自 OpenMAIC-main/tests/utils/concurrency.test.ts
// 路径改写: @/lib/utils/concurrency → @openmaic/lib/utils/concurrency
import { describe, expect, it } from 'vitest';

import {
  lazyBoundedMap,
  mapWithConcurrency,
  mapWithConcurrencySettledOnError,
} from '@openmaic/lib/utils/concurrency';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve first, but results must stay aligned with input.
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await tick(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 9 }, (_, i) => i),
      3,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3); // never exceeds the pool
  });

  it('clamps the limit to the item count (no over-spawn)', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2], 100, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out).toEqual([1, 2]);
  });

  it('stops pulling new items once shouldContinue() turns false', async () => {
    const processed: number[] = [];
    let done = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        processed.push(n);
        done += 1;
        return n;
      },
      { shouldContinue: () => done < 3 },
    );
    // limit 1 + stop after 3 ⇒ items 4–6 are never started.
    expect(processed).toEqual([1, 2, 3]);
  });

  it('handles an empty list without spawning workers', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});

describe('lazyBoundedMap', () => {
  it('returns promises immediately and resolves them without a barrier', async () => {
    const started: number[] = [];
    const promises = lazyBoundedMap([0, 1, 2], 1, async (n) => {
      started.push(n);
      await tick();
      return n * 10;
    });
    expect(promises).toHaveLength(3); // the array of promises exists synchronously
    expect(await promises[0]).toBe(0); // the first resolves on its own…
    expect(started.length).toBeLessThan(3); // …without forcing the last item to run (no barrier)
    expect(await Promise.all(promises)).toEqual([0, 10, 20]); // order + values preserved
  });

  it('caps in-flight work at `limit`', async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      lazyBoundedMap(
        Array.from({ length: 8 }, (_, i) => i),
        3,
        async (n) => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
          return n;
        },
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('skips items via shouldContinue without running fn', async () => {
    const ran: number[] = [];
    let done = 0;
    const out = await Promise.all(
      lazyBoundedMap(
        [1, 2, 3, 4, 5],
        1,
        async (n) => {
          ran.push(n);
          done += 1;
          return n;
        },
        { shouldContinue: () => done < 2 },
      ),
    );
    expect(ran).toEqual([1, 2]); // fn ran only twice
    expect(out).toEqual([1, 2, undefined, undefined, undefined]); // skipped → undefined
  });
});

describe('mapWithConcurrencySettledOnError', () => {
  it('stops queued work and waits for already-running workers before rejecting', async () => {
    const started: number[] = [];
    let releaseInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    let rejected = false;

    const result = mapWithConcurrencySettledOnError(
      [0, 1, 2, 3],
      2,
      async (item) => {
        started.push(item);
        if (item === 0) throw new Error('first page failed');
        await inFlight;
        return item;
      },
    );
    void result.catch(() => {
      rejected = true;
    });

    await tick();
    expect(started).toEqual([0, 1]);
    expect(rejected).toBe(false);

    releaseInFlight();
    await expect(result).rejects.toThrow('first page failed');
    expect(started).toEqual([0, 1]);
  });
});
