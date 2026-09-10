import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), access: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: async () => ({ claims: { role: 'student', sub: 'student-2', studentId: 'stale' } }) }));
vi.mock('@/lib/platform/access', () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock('@/lib/realtime/course-event-scope', () => ({ resolveCourseEventScope: mocks.scope }));
vi.mock('@/lib/db/client', () => ({ prisma: { domainEvent: { findMany: mocks.findMany } } }));
vi.mock('@/lib/observability/http', () => ({ withHttpMetrics: (_a: string, _b: string, handler: unknown) => handler }));
import { GET } from './route';
const id = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-09-08T00:00:00.000Z';
const context = { params: Promise.resolve({ courseId: 'instance' }) };
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue(true); mocks.scope.mockResolvedValue({ where: { classroomInstanceId: 'instance' }, version: 2 }); });
it('advances across filtered peer events while delivering only scoped invalidations', async () => {
  mocks.findMany.mockResolvedValue([
    { id, createdAt: new Date(timestamp), eventType: 'UPDATE_STUDENT_PROGRESS', actorId: 'student-1', participation: { enrollment: { userId: 'student-1' } }, payload: { answer: 'private' } },
    { id: id.replace(/^1/, '2'), createdAt: new Date(timestamp), eventType: 'SET_STAGE', actorId: 'teacher', participation: null, payload: { stage: 2, secretTeacherNote: 'private' } },
  ]);
  const response = await GET(new Request('http://localhost/api/courses/instance/events?after=0'), context);
  const body = await response.json();
  expect(body.events).toHaveLength(1); expect(body.events[0].type).toBe('SET_STAGE');
  expect(JSON.stringify(body)).not.toContain('private'); expect(body.nextCursor).toBe(`${timestamp}~${id.replace(/^1/, '2')}`);
});
it('uses a timestamp and ID seek predicate for equal-time events', async () => {
  mocks.findMany.mockResolvedValue([]);
  const cursor = `${timestamp}~${id}`;
  const response = await GET(new Request(`http://localhost/api/courses/instance/events?after=${encodeURIComponent(cursor)}`), context);
  expect(response.status).toBe(200);
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ classroomInstanceId: 'instance' }, { OR: [{ createdAt: { gt: new Date(timestamp) } }, { createdAt: new Date(timestamp), id: { gt: id } }] }] } }));
});
it('delivers the compact projection payload for direct client application', async () => {
  mocks.findMany.mockResolvedValue([{
    id,
    createdAt: new Date(timestamp),
    eventType: 'projection-changed',
    actorId: 'teacher',
    participation: null,
    payload: {
      fingerprint: 'private',
      ack: { requestId: 'private' },
      courseVersion: 5,
      projection: {
        courseId: 'instance',
        courseVersion: 5,
        projectionVersion: 3,
        projectionUpdatedAt: timestamp,
        serverTime: timestamp,
        resourceProjection: null,
        teacherResourceProjection: null,
      },
    },
  }]);
  const body = await (await GET(
    new Request('http://localhost/api/courses/instance/events?after=0'),
    context,
  )).json();
  expect(body.events[0]).toMatchObject({
    type: 'projection-changed',
    payload: { projectionVersion: 3, resourceProjection: null },
  });
  expect(JSON.stringify(body)).not.toContain('fingerprint');
  expect(JSON.stringify(body)).not.toContain('requestId');
});
it('rejects malformed legacy numeric cursors and denied access before data reads', async () => {
  expect((await GET(new Request('http://localhost/api/courses/instance/events?after=99'), context)).status).toBe(400);
  mocks.access.mockResolvedValue(false);
  expect((await GET(new Request('http://localhost/api/courses/instance/events'), context)).status).toBe(403);
  expect(mocks.findMany).not.toHaveBeenCalled();
});
