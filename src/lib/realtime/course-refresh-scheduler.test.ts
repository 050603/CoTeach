import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCourseRefreshScheduler } from "./course-refresh-scheduler";
const deferred = () => { let resolve!: (result: boolean) => void; let reject!: (error: Error) => void; const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const callbacks = () => ({ onRefreshed: vi.fn(), onError: vi.fn(), minimumIntervalMs: 750 });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("bounded course snapshot reconciliation", () => {
  it("does not postpone forever under continuous invalidations and retains the final cursor", async () => {
    const read = vi.fn(async () => true); const scheduler = createCourseRefreshScheduler({ ...callbacks(), read });
    for (let i = 1; i <= 40; i++) {
      expect(await scheduler.request(String(i), "standard", 750)).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenLastCalledWith("40");
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    scheduler.dispose();
  });
  it("allows only one read and never acknowledges a later cursor from an older response", async () => {
    const first = deferred(), last = deferred(); const reads: Array<string | undefined> = [];
    const scheduler = createCourseRefreshScheduler({ ...callbacks(), read: cursor => { reads.push(cursor); return reads.length === 1 ? first.promise : last.promise; } });
    const initial = scheduler.request("1");
    expect(await scheduler.request("3")).toBe(false);
    expect(await scheduler.request("2")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toEqual(["1"]);
    first.resolve(true); expect(await initial).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(["1", "3"]);
    last.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
  });
  it("honors teacher minimum spacing even for immediate polling calls", async () => {
    const starts: number[] = [];
    const scheduler = createCourseRefreshScheduler({ ...callbacks(), read: async () => { starts.push(Date.now()); return true; } });
    expect(await scheduler.request("1")).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await scheduler.request("2")).toBe(false);
    await vi.advanceTimersByTimeAsync(649); expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); expect(starts).toEqual([0, 750]);
    scheduler.dispose();
  });
  it("promotes classroom controls ahead of standard delay without losing the latest cursor", async () => {
    const read = vi.fn(async () => true); const scheduler = createCourseRefreshScheduler({ ...callbacks(), read });
    await scheduler.request("1");
    await scheduler.request("3", "standard", 750);
    await vi.advanceTimersByTimeAsync(100);
    await scheduler.request("2", "classroom-control", 50);
    await vi.advanceTimersByTimeAsync(49); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenLastCalledWith("3");
    scheduler.dispose();
  });
  it("retains an invalidation blocked by a local commit, without a busy retry loop", async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const scheduler = createCourseRefreshScheduler({ ...callbacks(), read });
    expect(await scheduler.request("5")).toBe(false);
    await vi.advanceTimersByTimeAsync(749); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("5");
    scheduler.dispose();
  });
  it("releases an errored or timed out read and executes pending work", async () => {
    const gate = deferred(); const errors = callbacks(); const read = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(true);
    const scheduler = createCourseRefreshScheduler({ ...errors, read });
    await scheduler.request("1", "standard", 50); await vi.advanceTimersByTimeAsync(50);
    await scheduler.request("2"); await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    gate.reject(new Error("request timeout")); await vi.advanceTimersByTimeAsync(0);
    expect(errors.onError).toHaveBeenCalledOnce(); expect(read).toHaveBeenLastCalledWith("2");
    scheduler.dispose();
  });
  it("disposes timers and ignores old responses after switching course/identity epoch", async () => {
    const gate = deferred(); const oldCallbacks = callbacks();
    const old = createCourseRefreshScheduler({ ...oldCallbacks, read: () => gate.promise });
    const initial = old.request("1"); await old.request("9"); old.dispose();
    const freshRead = vi.fn(async () => true); const fresh = createCourseRefreshScheduler({ ...callbacks(), read: freshRead });
    expect(await fresh.request("2")).toBe(true);
    gate.resolve(true); expect(await initial).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(oldCallbacks.onRefreshed).not.toHaveBeenCalled(); expect(freshRead).toHaveBeenCalledOnce();
    expect(await old.request("10")).toBe(false);
    fresh.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});
