import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { authenticateRequest } from '@/lib/auth/request-guards';
import { withHttpMetrics } from '@/lib/observability/http';
import { shouldDeliverMutationToStudent } from '@/lib/realtime/event-visibility';
import { canAccessLegacyCourse } from '@/lib/platform/access';
import { decodeEventCursor, encodeEventCursor } from '@/lib/realtime/event-cursor';
import { resolveCourseEventScope } from '@/lib/realtime/course-event-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const QuerySchema = z.object({
  after: z.string().max(80).refine((value) => value === '0' || Boolean(decodeEventCursor(value))).default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

async function getCourseEvents(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const auth = await authenticateRequest(request);
  if ('response' in auth) return auth.response;
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, 'read'))) return new Response(null, { status: 403 });
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ after: url.searchParams.get('after') ?? undefined, limit: url.searchParams.get('limit') ?? undefined });
  if (!parsed.success) return Response.json({ code: 'INVALID_CURSOR', message: 'Event cursor is invalid.' }, { status: 400 });
  const scope = await resolveCourseEventScope(courseId);
  if (!scope) return new Response(null, { status: 404 });
  const after = decodeEventCursor(parsed.data.after);
  const events = await prisma.domainEvent.findMany({
    where: { AND: [scope.where, ...(after ? [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] : [])] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: parsed.data.limit,
    include: { participation: { select: { enrollment: { select: { userId: true } } } } },
  });
  const eventInfo = (event: typeof events[number]) => {
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
    const studentId = event.participation?.enrollment.userId ?? (typeof payload.studentId === 'string' ? payload.studentId : undefined);
    return { payload, studentId, scope: studentId || payload.scope === 'student' ? 'student' as const : 'course' as const };
  };
  const visible = auth.claims.role === 'student' ? events.filter((event) => {
    const info = eventInfo(event);
    return shouldDeliverMutationToStudent({ actionType: event.eventType, scope: info.scope, targetStudentId: info.studentId, actorId: event.actorId ?? undefined }, auth.claims.sub ?? '');
  }) : events;
  return Response.json({
    events: visible.map((event) => {
      const info = eventInfo(event);
      return { cursor: encodeEventCursor(event), type: event.eventType, courseVersion: typeof info.payload.courseVersion === 'number' ? info.payload.courseVersion : scope.version,
        // The feed carries invalidation facts; canonical state supplies role-scoped content.
        payload: { scope: info.scope, ...(info.studentId ? { studentId: info.studentId } : {}), source: 'v2-domain-event' },
        createdAt: event.createdAt.toISOString() };
    }),
    nextCursor: events.length ? encodeEventCursor(events[events.length - 1]) : parsed.data.after,
    hasMore: events.length === parsed.data.limit, courseVersion: scope.version,
    // Client refreshes only when this canonical version exceeds its local snapshot.
    requiresReconciliation: true,
  });
}
export const GET = withHttpMetrics('GET', '/api/courses/:courseId/events', getCourseEvents);
