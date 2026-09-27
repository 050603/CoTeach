// @vitest-environment node
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), execute: vi.fn(), active: 0, commits: 0 }));
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: mock.transaction } }));
import { CourseAdmissionTimeoutError, hasCourseMutationAdmission, runMutationTransaction, tryCourseMutationAdmission, tryPersonalMutationAdmission } from './transaction-retry';
import { lockProjectedCourse } from './session-repository';
import { courseAdmissionAttempts, courseAdmissionBusy, courseAdmissionWaiting, courseAdmissionQueued, courseAdmissionLocalActive, courseAdmissionQueueRejected } from '../observability/course-admission';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  mock.query.mockReset(); mock.execute.mockReset(); mock.transaction.mockReset(); mock.active = 0; mock.commits = 0;
  courseAdmissionAttempts.reset(); courseAdmissionBusy.reset(); courseAdmissionWaiting.set(0); courseAdmissionQueued.set(0); courseAdmissionLocalActive.set(0); courseAdmissionQueueRejected.reset();
  mock.transaction.mockImplementation(async callback => {
    mock.active++;
    try { const result = await callback({ $queryRaw: mock.query, $executeRaw: mock.execute }); mock.commits++; return result; }
    finally { mock.active--; }
  });
});
afterEach(() => { expect(globalThis.__openPblCourseMutationQueues?.size ?? 0).toBe(0); vi.useRealTimers(); });

it('leaves teacher and ordinary transactions on the original blocking-lock path', async () => {
  const operation = vi.fn().mockResolvedValue('teacher');
  expect(await runMutationTransaction(operation)).toBe('teacher');
  expect(mock.query).not.toHaveBeenCalled();
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ maxWait: 5000, timeout: 10000 }));
});

it('releases failed admissions and admits a writer after more than five contentions', async () => {
  let attempts = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++attempts > 7 }]);
  const operation = vi.fn().mockResolvedValue('saved');
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(attempts).toBe(8);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1);
  expect(mock.active).toBe(0);
  expect(mock.query.mock.calls[0][1]).toBe('v2-course:course');
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(8);
  expect((await courseAdmissionBusy.get()).values[0].value).toBe(7);
  expect((await courseAdmissionWaiting.get()).values[0].value).toBe(0);
});

it('does not consume deadlock retries while waiting for admission', async () => {
  let tries = 0; let writes = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++tries > 6 }]);
  const operation = vi.fn(async () => {
    if (++writes < 5) throw new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' });
    return 'saved';
  });
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(writes).toBe(5);
});

it('bounds continuous contention with one overall deadline and never invokes the writer', async () => {
  mock.query.mockResolvedValue([{ acquired: false }]);
  const operation = vi.fn();
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await task).toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(performance.now()).toBe(10000);
  expect(operation).not.toHaveBeenCalled();
  expect(mock.commits).toBe(0);
  const budgets = mock.transaction.mock.calls.map(call => call[1].timeout);
  expect(budgets.at(-1)).toBeLessThan(budgets[0]);
});

it('returns a domain timeout error and rolls back a callback that outlives its budget', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const error = new Error('retryable domain error');
  const task = runMutationTransaction(async () => {
    await new Promise(resolve => setTimeout(resolve, 10001));
    return 'late';
  }, { lowPriorityCourseId: 'course', admissionTimeoutError: () => error }).catch(value => value);
  await vi.runAllTimersAsync();
  expect(await task).toBe(error);
  expect(mock.commits).toBe(0);
});

it('preserves nonretryable CAS and ownership errors without replaying the writer', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const error = new Error('DRAFT_VERSION_CONFLICT');
  const operation = vi.fn().mockRejectedValue(error);
  await expect(runMutationTransaction(operation, { lowPriorityCourseId: 'course' })).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('lets deferred admission retain a pre-existing narrow-lock order and retries the entire preparation', async () => {
  let preparations = 0; let writes = 0;
  const acquisitions = [false, false, false, true];
  mock.query.mockImplementation(async () => [{ acquired: acquisitions.shift() }]);
  const task = runMutationTransaction(async tx => {
    preparations++;
    await tryCourseMutationAdmission(tx, 'course');
    writes++;
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(preparations).toBe(4);
  expect(writes).toBe(1);
  expect(mock.commits).toBe(1);
});

it('performs deferred preparation once per attempt without a separate preflight transaction', async () => {
  let attempts = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++attempts > 6 }]);
  const operation = vi.fn(async tx => { await tryCourseMutationAdmission(tx, 'course'); return 'saved'; });
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(mock.transaction).toHaveBeenCalledTimes(7);
  expect(mock.query).toHaveBeenCalledTimes(7);
  expect(operation).toHaveBeenCalledTimes(7);
});

it('includes pool wait and transaction execution in the same remaining deadline', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  await runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course' });
  const options = mock.transaction.mock.calls[0][1];
  expect(options.maxWait).toBeGreaterThan(0);
  expect(options.timeout).toBeGreaterThan(0);
  expect(options.maxWait + options.timeout).toBeLessThanOrEqual(10000);
});

it('maps Prisma pool or interactive-transaction timeouts to the caller retryable error', async () => {
  mock.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('transaction timeout', { code: 'P2028', clientVersion: 'test' }));
  const error = new Error('COURSE_BUSY');
  await expect(runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course', admissionTimeoutError: () => error })).rejects.toBe(error);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
});

it('sets a LOCAL SQL timeout with nonblocking admission before calling the writer', async () => {
  mock.query.mockResolvedValueOnce([{ acquired: false }]).mockResolvedValue([{ acquired: true }]);
  const operation = vi.fn().mockResolvedValue('saved');
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync(); await task;
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.query).toHaveBeenCalledTimes(2);
  for (const call of mock.query.mock.calls) {
    expect(call[0].join('')).toContain("set_config('statement_timeout', ");
    expect(call[0].join('')).toContain(', true)');
    expect(Number(call[2])).toBeLessThanOrEqual(1000);
  }
  expect(mock.query.mock.invocationCallOrder[1]).toBeLessThan(operation.mock.invocationCallOrder[0]);
});

it('maps server-side statement cancellation to retryable 503 without repeating an ambiguous business operation', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const operation = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('cancelled', { code: 'P2010', meta: { code: '57014' }, clientVersion: 'test' }));
  await expect(runMutationTransaction(operation, { lowPriorityCourseId: 'course' })).rejects.toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(0);
});

it('rolls back a busy personal try before attempting course admission or configuring SQL timeouts', async () => {
  mock.query.mockResolvedValueOnce([{ acquired: false }]).mockResolvedValue([{ acquired: true }]);
  const task = runMutationTransaction(async tx => {
    await tryPersonalMutationAdmission(tx, 'learning-events:course:student');
    await tryCourseMutationAdmission(tx, 'course');
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(mock.query.mock.calls.map(call => call[1])).toEqual(['learning-events:course:student', 'learning-events:course:student', 'v2-course:course']);
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.query.mock.calls.filter(call => call[0].join('').includes('set_config'))).toHaveLength(1);
  expect(mock.commits).toBe(1);
});

it('reuses only the same transaction and course advisory lock, while retaining the row lock', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  await runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(true);
    expect(hasCourseMutationAdmission(tx, 'other-course')).toBe(false);
    await lockProjectedCourse(tx, 'course');
  }, { lowPriorityCourseId: 'course' });
  const queries = mock.query.mock.calls.map(call => call[0].join(''));
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('pg_try_advisory_xact_lock');
  expect(queries[1]).toContain('FOR UPDATE');
  mock.query.mockClear();
  await runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await lockProjectedCourse(tx, 'course');
  });
  expect(mock.query.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
  expect(mock.query.mock.calls[1][0].join('')).toContain('FOR UPDATE');
});

it('admits 40 same-course student writes FIFO without opening transactions for queued requests', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let releaseFirst!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const order: number[] = [];
  const tasks = Array.from({ length: 40 }, (_, index) => runMutationTransaction(async () => {
    order.push(index);
    if (!index) { firstStarted(); await gate; }
    return index;
  }, { lowPriorityCourseId: 'fifo-course' }));
  await started;
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(39);
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(1);
  releaseFirst();
  expect(await Promise.all(tasks)).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(order).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(mock.query).toHaveBeenCalledTimes(40);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(0);
});

it('lets teachers and other courses proceed while a local student queue is occupied', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; }, { lowPriorityCourseId: 'course-a' });
  await started;
  expect(await runMutationTransaction(async () => 'teacher')).toBe('teacher');
  expect(await runMutationTransaction(async () => 'another course', { lowPriorityCourseId: 'course-b' })).toBe('another course');
  expect(mock.active).toBe(1);
  release(); await first;
});

it('counts local queue time in the same 10s deadline and removes expired waiters before they can write', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; }, { lowPriorityCourseId: 'course' }).catch(error => error);
  await started;
  const write = vi.fn();
  const queued = runMutationTransaction(write, { lowPriorityCourseId: 'course' }).catch(error => error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await queued).toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(write).not.toHaveBeenCalled();
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
  release(); expect(await first).toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(globalThis.__openPblCourseMutationQueues?.size).toBe(0);
  expect(await runMutationTransaction(async () => 'recovered', { lowPriorityCourseId: 'course' })).toBe('recovered');
});

it('rejects queue overflow explicitly without touching the database and cleans up after draining', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; return 'first'; }, { lowPriorityCourseId: 'course' });
  await started;
  const tasks = Array.from({ length: 258 }, () => runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course' }).catch(error => error));
  await Promise.resolve();
  expect((await courseAdmissionQueueRejected.get()).values[0].value).toBe(2);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(256);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  release(); await first;
  const results = await Promise.all(tasks);
  expect(results.filter(result => result === 'saved')).toHaveLength(256);
  expect(results.filter(result => result instanceof CourseAdmissionTimeoutError)).toHaveLength(2);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
});

it('releases a local permit after a nonretryable business failure so the next writer can run', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const first = runMutationTransaction(async () => { throw new Error('CAS_CONFLICT'); }, { lowPriorityCourseId: 'course' }).catch(error => error);
  const second = runMutationTransaction(async () => 'second', { lowPriorityCourseId: 'course' });
  expect(await first).toMatchObject({ message: 'CAS_CONFLICT' });
  expect(await second).toBe('second');
  expect(mock.commits).toBe(1);
});
