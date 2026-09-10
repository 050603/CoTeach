export class LatestValueQueue<T> {
  private pending: T | undefined;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly coalesceMs: number,
    private readonly retryMs: number,
    private readonly onError?: (error: unknown) => void,
  ) {}

  enqueue(value: T, immediate: boolean): void {
    this.pending = value;
    if (immediate) this.schedule(0, true);
    else if (!this.timer) this.schedule(this.coalesceMs, false);
  }

  hasWork(): boolean {
    return this.inFlight || this.pending !== undefined || this.timer !== undefined;
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }

  whenIdle(): Promise<void> {
    if (!this.hasWork()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.resolveIdle();
  }

  private schedule(delayMs: number, replaceTimer: boolean): void {
    if (replaceTimer && this.timer) clearTimeout(this.timer);
    if (this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.inFlight || this.pending === undefined) return;
    const value = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    let retryFailedValue = false;
    try {
      await this.send(value);
    } catch (error) {
      if (this.pending === undefined) {
        this.pending = value;
        retryFailedValue = true;
      }
      this.onError?.(error);
    } finally {
      this.inFlight = false;
      if (this.pending !== undefined) {
        this.schedule(retryFailedValue ? this.retryMs : 0, false);
      }
      else this.resolveIdle();
    }
  }

  private resolveIdle(): void {
    if (this.hasWork()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
