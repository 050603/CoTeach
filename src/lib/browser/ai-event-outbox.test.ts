import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushAiInteractionEvents, queueAiInteractionEvent } from './ai-event-outbox';
import { readLearningWrites } from './learning-outbox';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it('replays a decision with the same request id after response loss without losing another learner’s pending event', async () => {
  queueAiInteractionEvent('course:student-a', { courseId: 'course', studentId: 'student-a', eventType: 'decision' });
  queueAiInteractionEvent('course:student-b', { courseId: 'course', studentId: 'student-b', eventType: 'undo' });
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('response lost')).mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  await expect(flushAiInteractionEvents('course:student-a')).rejects.toThrow('response lost');
  expect(readLearningWrites('ai-interactions:course:student-a')).toHaveLength(1);
  await flushAiInteractionEvents('course:student-a');
  const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(requests[0].requestId).toBeTruthy();
  expect(Number.isFinite(Date.parse(requests[0].createdAt))).toBe(true);
  expect(requests[1]).toEqual(requests[0]);
  expect(readLearningWrites('ai-interactions:course:student-a')).toEqual([]);
  expect(readLearningWrites('ai-interactions:course:student-b')).toHaveLength(1);
});
