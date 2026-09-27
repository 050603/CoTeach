import { latestEventCursor } from "./sync-policy";

type Priority = "standard" | "classroom-control";
type Request = { cursor?: string; priority: Priority; dueAt: number };
type Options = {
  read: (cursor?: string) => Promise<boolean>;
  minimumIntervalMs: number;
  onRefreshed: () => void;
  onError: (error: unknown) => void;
};

/** One course/identity epoch. Later invalidations cannot be acknowledged by a
 * snapshot whose request already started. They retain their cursor in one
 * trailing request. Callers that only queued work get false, not a stale ACK.
 */
export function createCourseRefreshScheduler(options: Options) {
  let pending: Request | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let disposed = false;
  let lastStarted = Number.NEGATIVE_INFINITY;

  function merge(request: Request) {
    pending = pending ? {
      cursor: latestEventCursor(pending.cursor, request.cursor),
      priority: pending.priority === "classroom-control" || request.priority === "classroom-control" ? "classroom-control" : "standard",
      // Continuous events never postpone the first scheduled refresh.
      dueAt: Math.min(pending.dueAt, request.dueAt),
    } : request;
  }
  function dueAt() {
    if (!pending) return Infinity;
    return Math.max(pending.dueAt, pending.priority === "classroom-control" ? 0 : lastStarted + options.minimumIntervalMs);
  }
  function schedule() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || running || !pending) return;
    timer = setTimeout(() => {
      timer = undefined;
      void execute().catch(error => { if (!disposed) options.onError(error); });
    }, Math.max(0, dueAt() - Date.now()));
  }
  async function execute(): Promise<boolean> {
    if (disposed || running || !pending) return false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const captured = pending;
    pending = undefined;
    running = true;
    lastStarted = Date.now();
    try {
      const refreshed = await options.read(captured.cursor);
      if (disposed) return false;
      if (refreshed) options.onRefreshed();
      // Optimistic local writes or a newer local version can make a response
      // unusable. Keep the invalidation, with a bounded retry cadence.
      else merge({ ...captured, dueAt: Date.now() + 750 });
      return refreshed;
    } catch (error) {
      if (disposed) return false;
      throw error;
    } finally {
      running = false;
      schedule();
    }
  }
  return {
    request(cursor?: string, priority: Priority = "standard", delayMs = 0): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      merge({ cursor, priority, dueAt: Date.now() + delayMs });
      if (!running && dueAt() <= Date.now()) return execute();
      schedule();
      return Promise.resolve(false);
    },
    dispose() {
      disposed = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
