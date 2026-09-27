import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceLearningReporter } from './resource-learning-events';
import type { LearningEvent } from '@/lib/session/types';

const input = { courseId: 'course', studentId: 'student', stageKey: 'launch' };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('resource telemetry durable visits', () => {
  it('replays the exact original event after a lost ACK and remount, then records a distinct new visit', async () => {
    const requests: LearningEvent[][] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)).events);
      if (requests.length === 1) throw new TypeError('Response lost after server commit');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const first = createResourceLearningReporter(input);
    first.record('resource', 'open');
    await expect(first.flush()).rejects.toThrow();
    first.record('resource', 'open'); // Repeated viewer callback is the same visit.
    const reloaded = createResourceLearningReporter(input);
    await reloaded.flush();
    expect(requests[1]).toEqual(requests[0]);
    expect(localStorage.length).toBe(0);
    reloaded.record('resource', 'open');
    await reloaded.flush();
    expect(requests[2][0].idempotencyKey).not.toBe(requests[0][0].idempotencyKey);
    expect(requests[2][0].id).not.toBe(requests[0][0].id);
    expect(localStorage.length).toBe(0);
  });

  it('keeps milestone bodies immutable across retries and separates repeated visits and identities', async () => {
    const requests: LearningEvent[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)).events);
      return new Response('{}', { status: requests.length === 1 ? 503 : 200 });
    }));
    const reporter = createResourceLearningReporter(input);
    reporter.record('resource', 'complete', 92, 90);
    await expect(reporter.flush()).rejects.toThrow();
    reporter.record('resource', 'complete', 99, 90);
    const otherStudent = createResourceLearningReporter({ ...input, studentId: 'other' });
    await otherStudent.flush();
    expect(requests).toHaveLength(1);
    await reporter.flush();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1][0].metadata?.progressPercent).toBe(92);
    reporter.beginVisit('resource');
    reporter.record('resource', 'complete', 100, 90);
    await reporter.flush();
    expect(requests[2][0].idempotencyKey).not.toBe(requests[0][0].idempotencyKey);
  });
});
