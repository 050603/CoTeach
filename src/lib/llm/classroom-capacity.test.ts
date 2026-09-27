import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClassroomAiCapacity, withBackgroundAiPriority } from './classroom-capacity';

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
});
