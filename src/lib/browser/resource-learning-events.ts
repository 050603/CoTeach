import type { LearningEvent } from '@/lib/session/types';
import { createLearningEvent, postLearningEvents, resourceEventIdempotencyKey } from '@/lib/learning-analytics/telemetry';
import { browserRandomUUID } from './random-uuid';
import { drainLearningWriteBatches, enqueueLearningWrite } from './learning-outbox';

/** A mounted reading session owns visits; the durable queue outlives that mount. */
export function createResourceLearningReporter({ courseId, studentId, stageKey }: { courseId: string; studentId: string; stageKey: string }) {
  const scope = `resource-events:${courseId}:${studentId}`;
  const visits = new Map<string, string>();
  const recorded = new Set<string>();
  const beginVisit = (resourceId: string) => { visits.set(resourceId, browserRandomUUID()); };
  const flush = () => drainLearningWriteBatches<LearningEvent>(scope, events => postLearningEvents({ courseId, studentId, events }));
  function record(resourceId: string, type: 'open' | 'progress' | 'complete', progressPercent?: number, milestone?: number, source: 'student' | 'teacher-projection' = 'student') {
    if (!visits.has(resourceId)) beginVisit(resourceId);
    const idempotencyKey = `${resourceEventIdempotencyKey(courseId, studentId, resourceId, type, milestone, source)}:${visits.get(resourceId)}`;
    if (recorded.has(idempotencyKey)) return;
    const progress = progressPercent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(progressPercent)));
    const event = createLearningEvent(type === 'open' ? 'resource-open' : type === 'complete' ? 'resource-complete' : 'resource-progress', {
      courseId, studentId, stageKey, sceneId: resourceId, idempotencyKey,
      progressMarker: type === 'complete' ? 'completed' : 'in-progress',
      metadata: { resourceId, ...(progress === undefined ? {} : { progressPercent: progress }), source },
    });
    // Persist the original ID, time and body before sending. Never recreate an
    // event after a lost ACK; a subsequent visit receives a different key.
    enqueueLearningWrite(scope, event, event.id);
    recorded.add(idempotencyKey);
  }
  return { beginVisit, record, flush };
}
