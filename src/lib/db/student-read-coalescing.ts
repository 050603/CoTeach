import { prisma } from "./client";

const MAX_PENDING_READS = 512;
const MAX_JOIN_AGE_MS = 2_000;
const pending = new Map<string, Promise<unknown>>();

/** Coalesce only identical, currently running public-data queries on the default
 * student's read connection. Never reuse a settled value, an authorization
 * result, or a transaction snapshot. Clone per caller so projections cannot
 * mutate another request's objects (including dates/JSON fields).
 */
export async function readStudentCourseCommon<T>(
  db: object,
  studentId: string | undefined,
  courseId: string,
  operation: string,
  parameters: unknown,
  query: () => PromiseLike<T>,
): Promise<T> {
  if (!studentId || db !== prisma) return query();
  const key = JSON.stringify([courseId, operation, parameters]);
  let running = pending.get(key) as Promise<T> | undefined;
  if (!running) {
    // Bound memory during multi-course bursts; independent execution preserves
    // correctness when all slots are occupied. This is not an admission queue.
    if (pending.size >= MAX_PENDING_READS) return query();
    running = Promise.resolve().then(query);
    pending.set(key, running);
    const cleanup = () => { if (pending.get(key) === running) pending.delete(key); };
    // A hung database call must not capture every later retry forever. Expiry
    // only stops new callers joining it; it does not cancel the original query.
    const expiry = setTimeout(cleanup, MAX_JOIN_AGE_MS);
    expiry.unref?.();
    const settled = () => { clearTimeout(expiry); cleanup(); };
    // Handle both outcomes without creating an unobserved rejected finally().
    void running.then(settled, settled);
  }
  return structuredClone(await running);
}
