// @vitest-environment node
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: mock.transaction } }));
import { runMutationTransaction, tryCourseMutationAdmission } from './transaction-retry';
const deferred = () => Promise.withResolvers<void>();
const locked = () => new Prisma.PrismaClientKnownRequestError('lock timeout', { code: 'P2010', meta: { code: '55P03' }, clientVersion: 'test' });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); vi.stubEnv('OPENPBL_COURSE_MUTATION_PIPELINE', '2');
  mock.transaction.mockReset(); mock.query.mockReset();
  mock.transaction.mockImplementation(async callback => callback({ $queryRaw: mock.query }));
  mock.query.mockResolvedValue([{ acquired: true }]);
});
afterEach(() => {
  expect(globalThis.__openPblCourseMutationQueuesV2?.size).toBe(0);
  expect(globalThis.__openPblCourseMutationPipelineV2?.extraActive).toBe(0);
  vi.unstubAllEnvs(); vi.useRealTimers();
});
it('begins the candidate while predecessor commit delivery is pending, without releasing predecessor permit early', async () => {
  const commitDelivery = deferred(); const firstCallback = deferred(); let transactions = 0;
  mock.transaction.mockImplementation(async callback => {
    const number = ++transactions; const result = await callback({ $queryRaw: mock.query });
    if (number === 1) { firstCallback.resolve(); await commitDelivery.promise; }
    return result;
  });
  const first = runMutationTransaction(async () => 'first', { lowPriorityCourseId: 'course' });
  await firstCallback.promise;
  const second = runMutationTransaction(async () => 'second', { lowPriorityCourseId: 'course' });
  expect(await second).toBe('second');
  expect(globalThis.__openPblCourseMutationQueuesV2?.get('course')?.active).toHaveLength(1);
  const sql = mock.query.mock.calls[1][0].join('');
  expect(sql).toContain('WITH previous AS MATERIALIZED'); expect(sql).toContain("set_config('lock_timeout'");
  expect(sql).toContain('pg_advisory_xact_lock'); expect(sql).not.toContain('pg_try_advisory_xact_lock');
  expect(sql).toContain("set_config('lock_timeout', admitted.lock_timeout, true)");
  commitDelivery.resolve(); expect(await first).toBe('first');
});
it('retries 55P03 only from candidate admission, with real transaction ending before backoff', async () => {
  const hold = deferred(); const started = deferred(); let blocked = 0; let writes = 0;
  mock.query.mockImplementation(async (sql: TemplateStringsArray) => {
    if (sql.join('').includes('WITH previous AS MATERIALIZED') && blocked++ === 0) throw locked();
    return [{ acquired: true }];
  });
  const first = runMutationTransaction(async () => { started.resolve(); await hold.promise; }, { lowPriorityCourseId: 'course' });
  await started.promise;
  const second = runMutationTransaction(async () => { writes++; return 'saved'; }, { lowPriorityCourseId: 'course' });
  await vi.advanceTimersByTimeAsync(100); expect(await second).toBe('saved');
  expect(blocked).toBe(2); expect(writes).toBe(1);
  hold.resolve(); await first;
});
it('does not swallow a business SQL 55P03 or run it twice', async () => {
  const hold = deferred(); const started = deferred();
  const first = runMutationTransaction(async () => { started.resolve(); await hold.promise; }, { lowPriorityCourseId: 'course' }); await started.promise;
  const error = locked(); const writer = vi.fn().mockRejectedValue(error);
  await expect(runMutationTransaction(writer, { lowPriorityCourseId: 'course' })).rejects.toBe(error);
  expect(writer).toHaveBeenCalledTimes(1); hold.resolve(); await first;
});
it('retains candidate permit until rollback has actually completed on error', async () => {
  const firstGate = deferred(); const firstStarted = deferred(); const rollback = deferred(); const failed = deferred();
  let number = 0;
  mock.transaction.mockImplementation(async callback => {
    const index = ++number;
    try { return await callback({ $queryRaw: mock.query }); }
    catch (error) { if (index === 2) { failed.resolve(); await rollback.promise; } throw error; }
  });
  const first = runMutationTransaction(async () => { firstStarted.resolve(); await firstGate.promise; }, { lowPriorityCourseId: 'course' }); await firstStarted.promise;
  const second = runMutationTransaction(async () => { throw new Error('cancelled'); }, { lowPriorityCourseId: 'course' }).catch(error => error);
  await failed.promise; const thirdWrite = vi.fn(); const third = runMutationTransaction(thirdWrite, { lowPriorityCourseId: 'course' });
  await Promise.resolve(); expect(number).toBe(2); expect(thirdWrite).not.toHaveBeenCalled();
  rollback.resolve(); await second; await third; firstGate.resolve(); await first;
});
it('bounds repeated candidate lock timeouts by the original queue-inclusive deadline', async () => {
  const hold = deferred(); const started = deferred();
  mock.query.mockImplementation(async (sql: TemplateStringsArray) => { if (sql.join('').includes('WITH previous')) throw locked(); return [{ acquired: true }]; });
  const first = runMutationTransaction(async () => { started.resolve(); await hold.promise; }, { lowPriorityCourseId: 'course' }).catch(error => error); await started.promise;
  const writer = vi.fn(); const candidate = runMutationTransaction(writer, { lowPriorityCourseId: 'course' }).catch(error => error);
  await vi.advanceTimersByTimeAsync(10000); expect(await candidate).toMatchObject({ code: 'COURSE_BUSY' }); expect(writer).not.toHaveBeenCalled();
  expect(performance.now()).toBeLessThanOrEqual(10000); hold.resolve(); await first;
});

it('only the candidate course uses blocking admission; another course retains nonblocking try', async () => {
  const hold = deferred(); const started = deferred();
  const first = runMutationTransaction(async () => { started.resolve(); await hold.promise; }, { lowPriorityCourseId: 'course' }); await started.promise;
  await runMutationTransaction(async tx => { await tryCourseMutationAdmission(tx, 'other-course'); }, { lowPriorityCourseId: 'course' });
  const calls = mock.query.mock.calls;
  expect(calls[1][0].join('')).toContain('WITH previous AS MATERIALIZED');
  expect(calls[2][0].join('')).toContain('pg_try_advisory_xact_lock');
  expect(calls[2][1]).toBe('v2-course:other-course');
  hold.resolve(); await first;
});
