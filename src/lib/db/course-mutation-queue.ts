import { courseAdmissionQueued, courseAdmissionLocalActive, courseAdmissionQueueRejected, courseAdmissionQueueWait,
  courseAdmissionPipelineActive, courseAdmissionPipelineStarted } from '@/lib/observability/course-admission';

const MAX_LOCAL_WAITERS_PER_COURSE = 256;
const MAX_LOCAL_COURSES = 1024;
const MAX_PIPELINE_CANDIDATES = 4;
export type CourseMutationPermit = {
  blockingAdmission: boolean;
  admitted(): void;
  attemptFinished(): void;
  release(): void;
};
type ActivePermit = { eligible: boolean; admitted: boolean; experimental: boolean };
type LocalWaiter = {
  deadline: number; started: number; timer: ReturnType<typeof setTimeout>;
  resolve: (permit: CourseMutationPermit) => void; reject: (error: Error) => void;
  timeoutError: () => Error; eligible: boolean; experimental: boolean;
};
type CourseMutationQueue = { active: ActivePermit[]; waiters: LocalWaiter[] };
// Versioned globals never reuse or clear a live older boolean-based queue.
// Production rollout still requires a restart; PG locks serialize both generations.
declare global {
  var __openPblCourseMutationQueuesV2: Map<string, CourseMutationQueue> | undefined;
  var __openPblCourseMutationPipelineV2: { extraActive: number; candidates: Set<string>; pumping: boolean } | undefined;
}
const queues = globalThis.__openPblCourseMutationQueuesV2 ??= new Map<string, CourseMutationQueue>();
const pipeline = globalThis.__openPblCourseMutationPipelineV2 ??= { extraActive: 0, candidates: new Set<string>(), pumping: false };

/** Experiment is opt-in. Deferred personal-lock writers retain serial admission. */
export function acquireLocalCourseSlot(courseId: string, deadline: number, timeoutError: () => Error,
  busyError: () => Error, eligible: boolean): Promise<CourseMutationPermit> {
  let queue = queues.get(courseId);
  if ((!queue && queues.size >= MAX_LOCAL_COURSES) || (queue && queue.waiters.length >= MAX_LOCAL_WAITERS_PER_COURSE)) {
    courseAdmissionQueueRejected.inc(); return Promise.reject(busyError());
  }
  if (!queue) { queue = { active: [], waiters: [] }; queues.set(courseId, queue); }
  const current = queue;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const waiter: LocalWaiter = { deadline, started, resolve, reject, timeoutError, eligible,
      experimental: process.env.OPENPBL_COURSE_MUTATION_PIPELINE === '2',
      timer: setTimeout(() => {
        const index = current.waiters.indexOf(waiter);
        if (index === -1) return;
        current.waiters.splice(index, 1); finishWait(waiter); reject(timeoutError()); drain(courseId, current);
      }, Math.max(0, deadline - started)),
    };
    current.waiters.push(waiter); courseAdmissionQueued.inc(); drain(courseId, current);
  });
}
function finishWait(waiter: LocalWaiter) {
  clearTimeout(waiter.timer); courseAdmissionQueued.dec();
  courseAdmissionQueueWait.observe((performance.now() - waiter.started) / 1000);
}
function discardExpired(queue: CourseMutationQueue) {
  while (queue.waiters[0] && performance.now() >= queue.waiters[0].deadline) {
    const waiter = queue.waiters.shift()!; finishWait(waiter); waiter.reject(waiter.timeoutError());
  }
}
function eligibleCandidate(queue: CourseMutationQueue) {
  const previous = queue.active[0]; const next = queue.waiters[0];
  return queue.active.length === 1 && previous.admitted && previous.eligible && previous.experimental
    && next?.eligible && next.experimental;
}
function grant(courseId: string, queue: CourseMutationQueue, candidate: boolean) {
  const waiter = queue.waiters.shift()!; finishWait(waiter);
  const active: ActivePermit = { eligible: waiter.eligible, experimental: waiter.experimental, admitted: false };
  if (!queue.active.length) courseAdmissionLocalActive.inc();
  queue.active.push(active);
  if (candidate) { pipeline.extraActive++; courseAdmissionPipelineActive.inc(); courseAdmissionPipelineStarted.inc(); }
  let released = false;
  waiter.resolve({
    blockingAdmission: candidate,
    admitted() { if (!released) { active.admitted = true; drain(courseId, queue); } },
    attemptFinished() { if (!released) { active.admitted = false; drain(courseId, queue); } },
    release() {
      if (released) return; released = true;
      const wasPair = queue.active.length === 2;
      queue.active.splice(queue.active.indexOf(active), 1);
      if (!queue.active.length) courseAdmissionLocalActive.dec();
      if (wasPair) { pipeline.extraActive--; courseAdmissionPipelineActive.dec(); }
      drain(courseId, queue);
    },
  });
}
function drain(courseId: string, queue: CourseMutationQueue) {
  discardExpired(queue);
  if (!queue.active.length && queue.waiters.length) grant(courseId, queue, false);
  if (eligibleCandidate(queue)) pipeline.candidates.add(courseId);
  else pipeline.candidates.delete(courseId);
  if (!queue.active.length && !queue.waiters.length && queues.get(courseId) === queue) queues.delete(courseId);
  pumpCandidates();
}
function pumpCandidates() {
  if (pipeline.pumping) return;
  pipeline.pumping = true;
  try {
    while (pipeline.extraActive < MAX_PIPELINE_CANDIDATES && pipeline.candidates.size) {
      const courseId = pipeline.candidates.values().next().value!;
      pipeline.candidates.delete(courseId);
      const queue = queues.get(courseId);
      if (!queue) continue;
      discardExpired(queue);
      if (eligibleCandidate(queue)) grant(courseId, queue, true);
    }
  } finally { pipeline.pumping = false; }
}
