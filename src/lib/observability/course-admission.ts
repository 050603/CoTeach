import { Counter, Gauge, Histogram } from 'prom-client';
import { getOrCreateRegisteredMetric, register } from './metrics';

export const courseAdmissionAttempts = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_attempts_total', () => new Counter({
  name: 'openpbl_course_admission_attempts_total', help: 'Personal/course advisory-lock attempts across low-priority writers.',
}));
export const courseAdmissionBusy = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_busy_total', () => new Counter({
  name: 'openpbl_course_admission_busy_total', help: 'Busy personal/course lock admissions that roll back before retrying.',
}));
export const courseAdmissionTimeouts = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_timeouts_total', () => new Counter({
  name: 'openpbl_course_admission_timeouts_total', help: 'Low-priority writers rejected by their overall admission deadline.',
}));
export const courseAdmissionWaiting = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_waiting', () => new Gauge({
  name: 'openpbl_course_admission_waiting', help: 'Writers sleeping outside transactions after busy admission; these hold no database connection.',
}));
export const courseAdmissionBackoff = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_backoff_seconds', () => new Histogram({
  name: 'openpbl_course_admission_backoff_seconds', help: 'Actual duration of each admission retry sleep outside a transaction.',
  buckets: [.01, .025, .05, .1, .2, .5, 1],
}));

export const courseAdmissionQueued = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_queued', () => new Gauge({
  name: 'openpbl_course_admission_queued', help: 'Low-priority writers waiting in this process FIFO without a database connection.',
}));
export const courseAdmissionLocalActive = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_local_active', () => new Gauge({
  name: 'openpbl_course_admission_local_active', help: 'Courses with active local low-priority transactions, including retries and transaction completion.',
}));
export const courseAdmissionQueueRejected = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_queue_rejected_total', () => new Counter({
  name: 'openpbl_course_admission_queue_rejected_total', help: 'Low-priority requests rejected by the bounded local queue capacity.',
}));
export const courseAdmissionQueueWait = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_queue_wait_seconds', () => new Histogram({
  name: 'openpbl_course_admission_queue_wait_seconds', help: 'Local FIFO wait before admission or timeout; no database connection is held.',
  buckets: [.01, .05, .1, .25, .5, 1, 2, 5, 10],
}));

export const courseAdmissionPipelineActive = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_pipeline_active', () => new Gauge({
  name: 'openpbl_course_admission_pipeline_active', help: 'Opt-in extra local transaction permits above one per course; globally bounded at four.',
}));
export const courseAdmissionPipelineStarted = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_pipeline_started_total', () => new Counter({
  name: 'openpbl_course_admission_pipeline_started_total', help: 'Opt-in second permits started only after a same-course predecessor acquired admission.',
}));
export const courseAdmissionPipelineLockWaits = getOrCreateRegisteredMetric(register, 'openpbl_course_admission_pipeline_lock_waits_total', () => new Counter({
  name: 'openpbl_course_admission_pipeline_lock_waits_total', help: 'Bounded blocking advisory queries issued only by opt-in candidate transactions.',
}));
