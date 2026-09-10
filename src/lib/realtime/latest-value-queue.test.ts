import { afterEach, describe, expect, it, vi } from "vitest";
import { LatestValueQueue } from "./latest-value-queue";

afterEach(() => vi.useRealTimers());

describe("LatestValueQueue", () => {
  it("coalesces rapid updates into the latest state", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const queue = new LatestValueQueue<number>(async (value) => {
      sent.push(value);
    }, 100, 400);
    queue.enqueue(1, false);
    queue.enqueue(2, false);
    queue.enqueue(3, false);
    await vi.advanceTimersByTimeAsync(100);
    await queue.whenIdle();
    expect(sent).toEqual([3]);
  });

  it("keeps one request in flight and sends only the newest queued state", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sent: number[] = [];
    const queue = new LatestValueQueue<number>(async (value) => {
      sent.push(value);
      if (value === 1) await first;
    }, 100, 400);
    queue.enqueue(1, true);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue(2, false);
    queue.enqueue(3, true);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await queue.whenIdle();
    expect(sent).toEqual([1, 3]);
  });

  it("does not restore a failed old state over a newer stop command", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const sent: string[] = [];
    const queue = new LatestValueQueue<string>(async (value) => {
      sent.push(value);
      if (value === "playing") await first;
    }, 100, 400);
    queue.enqueue("playing", true);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("stopped", true);
    rejectFirst(new Error("network"));
    await vi.advanceTimersByTimeAsync(0);
    await queue.whenIdle();
    expect(sent).toEqual(["playing", "stopped"]);
  });
});
