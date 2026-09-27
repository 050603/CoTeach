// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('./client', () => ({ prisma: { $transaction: mocks.transaction } }));
import { runMutationTransaction } from './transaction-retry';
import { mutationPhaseDuration } from '../observability/mutation-timing';

afterEach(() => vi.restoreAllMocks());
describe('transaction attempt timing', () => {
  it.each(['success', 'callback-error', 'commit-error', 'startup-error'])('measures %s without changing its result', async mode => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observe = vi.spyOn(mutationPhaseDuration, 'observe').mockImplementation(() => {});
    const failure = new Error(mode);
    mocks.transaction.mockImplementation(async (callback: (tx: object) => Promise<unknown>) => {
      now = 10;
      if (mode === 'startup-error') throw failure;
      try {
        const result = await callback({});
        now = 60;
        if (mode === 'commit-error') throw failure;
        return result;
      } catch (error) { now = 60; throw error; }
    });
    const operation = runMutationTransaction(async () => {
      now = 30;
      if (mode === 'callback-error') throw failure;
      return 'saved';
    });
    if (mode === 'success') await expect(operation).resolves.toBe('saved');
    else await expect(operation).rejects.toBe(failure);
    const outcome = mode === 'success' ? 'success' : 'error';
    expect(observe).toHaveBeenCalledWith({ kind: 'regular', phase: 'startup', outcome }, .01);
    if (mode === 'startup-error') expect(observe).toHaveBeenCalledTimes(1);
    else {
      expect(observe).toHaveBeenCalledWith({ kind: 'regular', phase: 'callback', outcome }, .02);
      expect(observe).toHaveBeenCalledWith({ kind: 'regular', phase: 'completion', outcome }, .03);
    }
  });
  it.each([false, true])('metric failure preserves application outcome (failure=%s)', async failing => {
    vi.spyOn(mutationPhaseDuration, 'observe').mockImplementation(() => { throw new Error('metric failed'); });
    mocks.transaction.mockImplementation((callback: (tx: object) => Promise<unknown>) => callback({}));
    const original = new Error('original');
    const result = runMutationTransaction(async () => { if (failing) throw original; return 42; });
    if (failing) await expect(result).rejects.toBe(original);
    else await expect(result).resolves.toBe(42);
  });
});
