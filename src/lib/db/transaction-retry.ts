import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { courseAdmissionAttempts, courseAdmissionBackoff, courseAdmissionBusy, courseAdmissionTimeouts, courseAdmissionWaiting, courseAdmissionQueued, courseAdmissionLocalActive, courseAdmissionQueueRejected, courseAdmissionQueueWait } from "@/lib/observability/course-admission";

const MAX_ATTEMPTS = 5;
const ADMISSION_BUDGET_MS = 10_000;
const MAX_LOCAL_WAITERS_PER_COURSE = 256;
const MAX_LOCAL_COURSES = 1_024;

type LocalWaiter = {
  deadline: number;
  started: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timeoutError: () => Error;
};
type CourseMutationQueue = { active: boolean; waiters: LocalWaiter[] };
declare global {
  // Next server entry bundles must share one queue for the same course. This
  // is pressure control only: PostgreSQL remains the cross-process authority.
  var __openPblCourseMutationQueues: Map<string, CourseMutationQueue> | undefined;
}
const localCourseQueues = globalThis.__openPblCourseMutationQueues ??= new Map<string, CourseMutationQueue>();

function acquireLocalCourseSlot(courseId: string, deadline: number, timeoutError: () => Error, busyError: () => Error): Promise<() => void> {
  let queue = localCourseQueues.get(courseId);
  if ((!queue && localCourseQueues.size >= MAX_LOCAL_COURSES) || (queue && queue.waiters.length >= MAX_LOCAL_WAITERS_PER_COURSE)) {
    courseAdmissionQueueRejected.inc();
    return Promise.reject(busyError());
  }
  if (!queue) {
    queue = { active: false, waiters: [] };
    localCourseQueues.set(courseId, queue);
  }
  const current = queue;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const waiter: LocalWaiter = {
      deadline, started, resolve, reject, timeoutError,
      timer: setTimeout(() => {
        const index = current.waiters.indexOf(waiter);
        if (index === -1) return;
        current.waiters.splice(index, 1);
        finishLocalWait(waiter);
        reject(timeoutError());
        drainLocalCourseQueue(courseId, current);
      }, Math.max(0, deadline - started)),
    };
    current.waiters.push(waiter);
    courseAdmissionQueued.inc();
    drainLocalCourseQueue(courseId, current);
  });
}

function finishLocalWait(waiter: LocalWaiter) {
  clearTimeout(waiter.timer);
  courseAdmissionQueued.dec();
  courseAdmissionQueueWait.observe((performance.now() - waiter.started) / 1000);
}

function drainLocalCourseQueue(courseId: string, queue: CourseMutationQueue) {
  if (queue.active) return;
  for (let waiter = queue.waiters.shift(); waiter; waiter = queue.waiters.shift()) {
    finishLocalWait(waiter);
    if (performance.now() >= waiter.deadline) { waiter.reject(waiter.timeoutError()); continue; }
    queue.active = true;
    courseAdmissionLocalActive.inc();
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      queue.active = false;
      courseAdmissionLocalActive.dec();
      drainLocalCourseQueue(courseId, queue);
    });
    return;
  }
  if (localCourseQueues.get(courseId) === queue) localCourseQueues.delete(courseId);
}

class CourseAdmissionContended extends Error {}
const admittedStatementBudgets = new WeakMap<Prisma.TransactionClient, () => number>();
const admittedCourseLocks = new WeakMap<Prisma.TransactionClient, Set<string>>();

/** Only this exact transaction's successfully acquired xact locks qualify. */
export function hasCourseMutationAdmission(tx: Prisma.TransactionClient, courseId: string): boolean {
  return admittedCourseLocks.get(tx)?.has(courseId) ?? false;
}

export class CourseAdmissionTimeoutError extends Error {
  readonly code = "COURSE_BUSY";
  readonly status = 503;
  constructor() { super("课堂保存繁忙，请稍后重试"); this.name = "CourseAdmissionTimeoutError"; }
}

type MutationOptions = {
  /** Opt in only when every callback lock follows course advisory acquisition.
   * Keep the callback's existing course/row locks and fresh-state reads intact.
   */
  lowPriorityCourseId?: string;
  /** For writers that already take a narrower lock before course: explicitly
   * use tryPersonalMutationAdmission and then tryCourseMutationAdmission at
   * that original position, before any business SQL. A busy result
   * rolls back all preparation before the retry sleeps outside the transaction.
   */
  deferCourseAdmission?: boolean;
  admissionTimeoutError?: () => Error;
};

/** Deferred callers may acquire only NONBLOCKING narrower locks before course
 * admission. A busy result rolls the entire transaction back immediately. */
export async function tryPersonalMutationAdmission(tx: Prisma.TransactionClient, key: string) {
  courseAdmissionAttempts.inc();
  const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`;
  if (!lock.acquired) { courseAdmissionBusy.inc(); throw new CourseAdmissionContended(); }
}

export async function tryCourseMutationAdmission(tx: Prisma.TransactionClient, courseId: string) {
  // Acquire the nonblocking lock and set its local query budget in one trip.
  // A busy result immediately rolls back; LOCAL cannot leak into the pool.
  const milliseconds = admittedStatementBudgets.get(tx)?.() ?? 1_000;
  courseAdmissionAttempts.inc();
  const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`v2-course:${courseId}`}, 0)) AS acquired,
      set_config('statement_timeout', ${String(milliseconds)}, true) AS statement_budget`;
  if (!lock.acquired) { courseAdmissionBusy.inc(); throw new CourseAdmissionContended(); }
  const locks = admittedCourseLocks.get(tx) ?? new Set<string>();
  locks.add(courseId);
  admittedCourseLocks.set(tx, locks);
}

/**
 * Run a short PostgreSQL mutation transaction with bounded retries.
 *
 * Callers acquire a narrow advisory lock (course, invite code, or bootstrap)
 * as their first statement. READ COMMITTED then observes fresh data after a
 * waiter obtains that lock, while unique constraints and mutation receipts
 * preserve idempotency. Deadlocks and database serialization errors remain
 * retryable as a final safety net.
 */
export async function runMutationTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: MutationOptions = {},
): Promise<T> {
  const deadline = options.lowPriorityCourseId ? performance.now() + ADMISSION_BUDGET_MS : undefined;
  const timeoutError = () => { courseAdmissionTimeouts.inc(); return options.admissionTimeoutError?.() ?? new CourseAdmissionTimeoutError(); };
  const remaining = () => deadline === undefined ? ADMISSION_BUDGET_MS : Math.max(0, Math.ceil(deadline - performance.now()));
  // The deadline starts BEFORE queueing. At most one local student writer
  // enters/retries for a course; queued requests use no transaction or pool
  // connection. Teachers bypass this optimization and keep the original lock.
  const release = options.lowPriorityCourseId
    ? await acquireLocalCourseSlot(options.lowPriorityCourseId, deadline!, timeoutError,
      () => options.admissionTimeoutError?.() ?? new CourseAdmissionTimeoutError())
    : undefined;
  try {
    let failures = 0;
    let contention = 0;
    for (;;) {
      const budget = remaining();
      if (budget < (deadline === undefined ? 1 : 3)) throw timeoutError();
      // Prisma's acquisition wait and interactive timeout are consecutive.
      // Split the remaining budget so a congested pool cannot add a second
      // timeout window. Teachers retain their established 5s / 10s settings.
      const maxWait = deadline === undefined ? 5_000 : Math.max(1, Math.min(2_500, Math.floor(budget / 4)));
      const statementAllowance = Math.max(1, Math.min(1_000, Math.floor(budget / 5)));
      // Prisma expires the transaction but does not cancel an ongoing query.
      // Reserve a final statement window; PostgreSQL cancels it server-side.
      const transactionTimeout = deadline === undefined ? budget : Math.max(1, budget - maxWait - statementAllowance);
      try {
        return await prisma.$transaction(async tx => {
          if (options.lowPriorityCourseId) {
            admittedStatementBudgets.set(tx, () => Math.max(1, Math.min(statementAllowance, remaining())));
            if (!remaining()) throw timeoutError();
            // A failed admission does no domain reads/writes and releases its
            // connection before sleeping. Teachers continue to queue on the
            // exact same PostgreSQL lock, across processes and connection pools.
            if (!options.deferCourseAdmission) await tryCourseMutationAdmission(tx, options.lowPriorityCourseId);
            if (!remaining()) throw timeoutError();
          }
          const result = await operation(tx);
          // A request admitted near its deadline must not commit a late write.
          if (deadline !== undefined && !remaining()) throw timeoutError();
          return result;
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait,
          timeout: transactionTimeout,
        });
      } catch (error) {
        if (error instanceof CourseAdmissionContended) {
          if (!remaining()) throw timeoutError();
          contention++;
          const cap = Math.min(20 * 2 ** Math.min(contention - 1, 2), 50);
          const started = performance.now();
          courseAdmissionWaiting.inc();
          try { await delay(Math.min(remaining(), cap / 2 + Math.random() * cap / 2)); }
          finally { courseAdmissionWaiting.dec(); courseAdmissionBackoff.observe((performance.now() - started) / 1000); }
          continue;
        }
        if (deadline !== undefined
          && error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === "P2028" || (error.code === "P2010" && String(error.meta?.code) === "57014"))) throw timeoutError();
        if (!isRetryableTransactionError(error) || ++failures >= MAX_ATTEMPTS) {
          throw error;
        }
        await delay(Math.min(remaining(), retryDelayMs(failures)));
      }
    }
  } finally { release?.(); }
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;

  const databaseCode =
    error.meta && typeof error.meta === "object" && "code" in error.meta
      ? String(error.meta.code)
      : "";
  return databaseCode === "40001" || databaseCode === "40P01";
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(10 * 2 ** (attempt - 1), 80);
  return base + Math.floor(Math.random() * base);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
