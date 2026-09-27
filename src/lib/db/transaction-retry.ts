import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { courseAdmissionAttempts, courseAdmissionBackoff, courseAdmissionBusy, courseAdmissionTimeouts, courseAdmissionWaiting, courseAdmissionPipelineLockWaits } from "@/lib/observability/course-admission";

import { acquireLocalCourseSlot } from "./course-mutation-queue";
import { observeMutationPhase } from "@/lib/observability/mutation-timing";

const MAX_ATTEMPTS = 5;
const ADMISSION_BUDGET_MS = 10_000;
class CourseAdmissionContended extends Error {}
const admittedStatementBudgets = new WeakMap<Prisma.TransactionClient, () => number>();
const blockingCourseAdmissions = new WeakMap<Prisma.TransactionClient, string>();
const admissionNotifiers = new WeakMap<Prisma.TransactionClient, () => void>();
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

/** Heartbeat-only combination: MATERIALIZED evaluates the personal lock once;
 * CASE prevents acquiring course when personal is busy. Any busy result throws
 * out of the callback, rolling back BOTH xact locks and the LOCAL setting. */
export async function tryPersonalCourseMutationAdmission(tx: Prisma.TransactionClient, key: string, courseId: string) {
  const milliseconds = admittedStatementBudgets.get(tx)?.() ?? 1_000;
  courseAdmissionAttempts.inc();
  const [lock] = await tx.$queryRaw<Array<{ personal_acquired: boolean; acquired: boolean }>>`
    WITH personal AS MATERIALIZED (
      SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired
    ) SELECT personal.acquired AS personal_acquired,
      CASE WHEN personal.acquired THEN pg_try_advisory_xact_lock(hashtextextended(${`v2-course:${courseId}`}, 0)) ELSE false END AS acquired,
      set_config('statement_timeout', ${String(milliseconds)}, true) AS statement_budget
    FROM personal`;
  if (lock.personal_acquired) courseAdmissionAttempts.inc();
  if (!lock.personal_acquired || !lock.acquired) { courseAdmissionBusy.inc(); throw new CourseAdmissionContended(); }
  const locks = admittedCourseLocks.get(tx) ?? new Set<string>();
  locks.add(courseId);
  admittedCourseLocks.set(tx, locks);
}

export async function tryCourseMutationAdmission(tx: Prisma.TransactionClient, courseId: string) {
  if (blockingCourseAdmissions.get(tx) === courseId) return waitCourseMutationAdmission(tx, courseId);
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
  admissionNotifiers.get(tx)?.();
}

/** Experimental candidate only: lock_timeout starts when PostgreSQL waits for
 * the advisory lock. Ordered MATERIALIZED CTEs install it before lock acquisition
 * and restore the previous setting afterward. statement_timeout remains LOCAL
 * for later business statements; its current-statement behavior is not assumed.
 */
async function waitCourseMutationAdmission(tx: Prisma.TransactionClient, courseId: string) {
  const milliseconds = admittedStatementBudgets.get(tx)?.() ?? 1000;
  courseAdmissionAttempts.inc(); courseAdmissionPipelineLockWaits.inc();
  try {
    await tx.$queryRaw`WITH previous AS MATERIALIZED (
        SELECT current_setting('lock_timeout') AS lock_timeout
      ), settings AS MATERIALIZED (
        SELECT previous.lock_timeout,
          set_config('lock_timeout', ${String(milliseconds)}, true) AS lock_budget,
          set_config('statement_timeout', ${String(milliseconds)}, true) AS statement_budget
        FROM previous
      ), admitted AS MATERIALIZED (
        SELECT settings.lock_timeout, pg_advisory_xact_lock(hashtextextended(${`v2-course:${courseId}`}, 0))::text AS acquired
        FROM settings
      ) SELECT set_config('lock_timeout', admitted.lock_timeout, true) AS restored FROM admitted`;
  } catch (error) {
    // Only this lock admission statement can turn 55P03 into retryable busy.
    // A lock error raised by business SQL is propagated without replaying it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010" && String(error.meta?.code) === "55P03") {
      courseAdmissionBusy.inc(); throw new CourseAdmissionContended();
    }
    throw error;
  }
  const locks = admittedCourseLocks.get(tx) ?? new Set<string>();
  locks.add(courseId); admittedCourseLocks.set(tx, locks); admissionNotifiers.get(tx)?.();
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
  // The deadline starts BEFORE queueing. Default: one local writer per course.
  // Opt-in pipeline permits one bounded nondeferred candidate only after its
  // predecessor holds admission. Queued requests consume no DB connection.
  // Teachers bypass the local queue and retain the same PostgreSQL lock.
  const permit = options.lowPriorityCourseId
    ? await acquireLocalCourseSlot(options.lowPriorityCourseId, deadline!, timeoutError,
      () => options.admissionTimeoutError?.() ?? new CourseAdmissionTimeoutError(), !options.deferCourseAdmission)
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
      const transactionStarted = performance.now();
      let transactionFinished: number | undefined;
      let callbackStarted: number | undefined;
      let callbackFinished: number | undefined;
      let transactionOutcome: "success" | "error" = "error";
      try {
        const transactionResult = await prisma.$transaction(async tx => {
          callbackStarted = performance.now();
          try {
            if (options.lowPriorityCourseId) {
              if (permit?.blockingAdmission) blockingCourseAdmissions.set(tx, options.lowPriorityCourseId);
              if (permit) admissionNotifiers.set(tx, permit.admitted);
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
          } finally { callbackFinished = performance.now(); }
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait,
          timeout: transactionTimeout,
        });
        transactionFinished = performance.now();
        transactionOutcome = "success";
        return transactionResult;
      } catch (error) {
        transactionFinished = performance.now();
        permit?.attemptFinished();
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
      } finally {
        permit?.attemptFinished();
        const finished = transactionFinished ?? performance.now();
        const kind = options.lowPriorityCourseId ? "student" : "regular";
        observeMutationPhase(kind, "startup", transactionOutcome, (callbackStarted ?? finished) - transactionStarted);
        if (callbackStarted !== undefined && callbackFinished !== undefined) {
          observeMutationPhase(kind, "callback", transactionOutcome, callbackFinished - callbackStarted);
          observeMutationPhase(kind, "completion", transactionOutcome, finished - callbackFinished);
        }
      }
    }
  } finally { permit?.release(); }
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    // Prisma 6.19.3 delegates can wrap a real PostgreSQL deadlock in this Rust
    // ConnectorError diagnostic instead of P2034. Match only the outer first
    // server code at its complete diagnostic boundary, never arbitrary message
    // or user-controlled detail text. A changed format deliberately fails closed.
    const diagnostic = /(?:^|\n)Error occurred during query execution:\nConnectorError\(ConnectorError \{ user_facing_error: None, kind: QueryError\(PostgresError \{ code: "([0-9A-Z]{5})", message: [^\r\n]*\}\), transient: (?:false|true) \}\)(?:\n)?$/.exec(error.message);
    return diagnostic?.[1] === "40001" || diagnostic?.[1] === "40P01";
  }
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
