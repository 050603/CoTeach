import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClassroomAiCapacity, withBackgroundAiPriority, withClassroomAiStream, classroomAiCapacitySnapshot } from './classroom-capacity';

describe('classroom AI capacity', () => {
  afterEach(() => vi.useRealTimers());
  it('bounds concurrency, reserves interactive capacity and releases after failure', async () => {
    const gate = createClassroomAiCapacity(2, 1);
    let release!: () => void;
    const first = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    await expect(withBackgroundAiPriority(() => gate.run(async () => 'background'))).rejects.toThrow('课堂 AI');
    await expect(gate.run(async () => { throw new Error('provider'); })).rejects.toThrow('provider');
    expect(gate.snapshot().active).toBe(1);
    release(); await first;
    expect(gate.snapshot()).toEqual({ active: 0, pending: 0, limit: 2 });
  });
  it('removes aborted and expired requests without starting them', async () => {
    vi.useFakeTimers();
    const gate = createClassroomAiCapacity(1, 2, 100);
    let release!: () => void;
    const first = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const controller = new AbortController();
    const operation = vi.fn();
    const aborted = gate.run(operation, controller.signal);
    const abortedCheck = expect(aborted).rejects.toThrow();
    controller.abort(); await abortedCheck;
    const expired = gate.run(operation);
    const expiredCheck = expect(expired).rejects.toThrow('排队超时');
    await vi.advanceTimersByTimeAsync(101); await expiredCheck;
    release(); await first;
    expect(operation).not.toHaveBeenCalled();
    expect(gate.snapshot().pending).toBe(0);
  });
  it('holds a stream slot after the first chunk and cancels upstream on early return', async () => {
    const baseline = classroomAiCapacitySnapshot().active;
    let upstreamSignal: AbortSignal | undefined;
    let closed = false;
    const stream = withClassroomAiStream(async function* (signal) {
      upstreamSignal = signal;
      try { yield 'first'; yield 'second'; } finally { closed = true; }
    });
    expect((await stream.next()).value).toBe('first');
    expect(classroomAiCapacitySnapshot().active).toBe(baseline + 1);
    await stream.return(undefined);
    expect(closed).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(classroomAiCapacitySnapshot().active).toBe(baseline);
  });
  it('releases stream capacity on provider errors', async () => {
    const baseline = classroomAiCapacitySnapshot().active;
    const stream = withClassroomAiStream(async function* () { yield 'first'; throw new Error('provider interrupted'); });
    await stream.next();
    await expect(stream.next()).rejects.toThrow('provider interrupted');
    expect(classroomAiCapacitySnapshot().active).toBe(baseline);
  });
  it('aborts upstream before waiting for an SDK iterator cancellation', async () => {
    const baseline = classroomAiCapacitySnapshot().active;
    const stream = withClassroomAiStream(signal => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ value: 'chunk', done: false as const }),
          return: async () => {
            if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { value: undefined, done: true as const };
          },
        };
      },
    }));
    await stream.next();
    await stream.return(undefined);
    expect(classroomAiCapacitySnapshot().active).toBe(baseline);
  });
});
