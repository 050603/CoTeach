// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { courseAdmissionLocalActive, courseAdmissionPipelineActive } from '@/lib/observability/course-admission';
import { acquireLocalCourseSlot, type CourseMutationPermit } from './course-mutation-queue';
const error = () => new Error('deadline');
const get = (course: string, eligible = true, deadline = performance.now() + 10000) => acquireLocalCourseSlot(course, deadline, error, error, eligible);
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); vi.stubEnv('OPENPBL_COURSE_MUTATION_PIPELINE', '2'); });
afterEach(() => {
  expect(globalThis.__openPblCourseMutationQueuesV2?.size).toBe(0);
  expect(globalThis.__openPblCourseMutationPipelineV2?.extraActive).toBe(0);
  expect(globalThis.__openPblCourseMutationPipelineV2?.candidates.size).toBe(0);
  vi.unstubAllEnvs(); vi.useRealTimers();
});
it('starts only one candidate after predecessor admission, and never a third permit', async () => {
  const first = await get('course'); let second: CourseMutationPermit | undefined; let third: CourseMutationPermit | undefined;
  const two = get('course').then(value => { second = value; });
  const three = get('course').then(value => { third = value; });
  await Promise.resolve(); expect(second).toBeUndefined();
  first.admitted(); await two; expect(second!.blockingAdmission).toBe(true);
  second!.admitted(); await Promise.resolve(); expect(third).toBeUndefined();
  first.release(); await three; expect(third!.blockingAdmission).toBe(true);
  second!.release(); third!.release();
});
it('defaults to one for unset, 1 and arbitrary configuration', async () => {
  for (const flag of [undefined, '1', '3']) {
    vi.stubEnv('OPENPBL_COURSE_MUTATION_PIPELINE', flag);
    const first = await get('default'); let opened = false;
    const pending = get('default').then(value => { opened = true; return value; });
    first.admitted(); await Promise.resolve(); expect(opened).toBe(false);
    first.release(); const second = await pending; expect(second.blockingAdmission).toBe(false); second.release();
  }
});
it('bounds extra global permits to four and serves other queued courses on release', async () => {
  const firsts = await Promise.all(Array.from({ length: 6 }, (_, i) => get(`c${i}`)));
  const seconds: Array<CourseMutationPermit | undefined> = [];
  const waits = firsts.map((_, i) => get(`c${i}`).then(value => { seconds[i] = value; }));
  firsts.forEach(first => first.admitted()); await Promise.resolve();
  expect(seconds.filter(Boolean)).toHaveLength(4); expect(globalThis.__openPblCourseMutationPipelineV2?.extraActive).toBe(4);
  firsts[0].release(); await waits[4]; expect(seconds[4]).toBeDefined(); expect(seconds[5]).toBeUndefined();
  firsts[1].release(); await waits[5];
  firsts.forEach(first => first.release()); seconds.forEach(second => second!.release()); await Promise.all(waits);
});
it('keeps deferred personal-lock writers serial and never skips them in FIFO', async () => {
  const first = await get('course'); first.admitted(); let deferred: CourseMutationPermit | undefined; let third: CourseMutationPermit | undefined;
  const two = get('course', false).then(value => { deferred = value; });
  const three = get('course').then(value => { third = value; });
  await Promise.resolve(); expect(deferred).toBeUndefined(); expect(third).toBeUndefined();
  first.release(); await two; deferred!.admitted(); await Promise.resolve();
  expect(third).toBeUndefined(); expect(deferred!.blockingAdmission).toBe(false);
  deferred!.release(); await three; expect(third!.blockingAdmission).toBe(false); third!.release();
});
it('withdraws eligibility after an attempt ends and reopens only after fresh admission', async () => {
  const first = await get('course'); first.admitted(); first.attemptFinished();
  let second: CourseMutationPermit | undefined; const pending = get('course').then(value => { second = value; });
  await Promise.resolve(); expect(second).toBeUndefined(); first.admitted(); await pending;
  first.release(); second!.release();
});
it('expires waiting candidates without granting a late permit and releases idempotently', async () => {
  const first = await get('course');
  const second = get('course', true, 100).catch(value => value);
  await vi.advanceTimersByTimeAsync(100); expect(await second).toMatchObject({ message: 'deadline' });
  first.admitted(); first.release(); first.release();
});

it('retains active-course metric semantics while separately counting one extra permit', async () => {
  const first = await get('course'); first.admitted(); const second = await get('course');
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(1);
  expect((await courseAdmissionPipelineActive.get()).values[0].value).toBe(1);
  first.release(); expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(1);
  expect((await courseAdmissionPipelineActive.get()).values[0].value).toBe(0); second.release();
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(0);
});
it('never reuses or clears an older live boolean-based global queue', async () => {
  const key = '__openPblCourseMutationQueues';
  const old = Reflect.get(globalThis, key);
  const legacy = new Map([['legacy-course', { active: true, waiters: ['still-running'] }]]);
  Reflect.set(globalThis, key, legacy);
  try {
    const current = await get('legacy-course'); current.admitted(); current.release();
    expect(Reflect.get(globalThis, key)).toBe(legacy);
    expect(legacy.get('legacy-course')).toEqual({ active: true, waiters: ['still-running'] });
  } finally {
    if (old === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, old);
  }
});
