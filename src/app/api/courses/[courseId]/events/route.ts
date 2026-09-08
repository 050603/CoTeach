import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { withHttpMetrics } from "@/lib/observability/http";
import { shouldDeliverMutationToStudent } from "@/lib/realtime/event-visibility";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  after: z.string().max(20).regex(/^\d+$/).default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

async function getCourseEvents(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  if (auth.claims.role === "student" && auth.claims.courseId !== courseId) {
    return new Response(null, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) {
    return new Response(null, { status: 403 });
  }
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    after: url.searchParams.get("after") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      {
        code: "INVALID_CURSOR",
        message: "Event cursor is invalid.",
        requestId: request.headers.get("x-request-id") ?? "unknown",
      },
      { status: 400 },
    );
  }
  const [events, course, latestDurableEvent] = await Promise.all([
    prisma.courseEvent.findMany({
      where: { courseId, cursor: { gt: BigInt(parsed.data.after) } },
      orderBy: { cursor: "asc" },
      take: parsed.data.limit,
    }),
    prisma.course.findUnique({
      where: { id: courseId },
      select: { version: true },
    }),
    prisma.courseEvent.findFirst({
      where: { courseId },
      orderBy: { cursor: "desc" },
      select: { courseVersion: true },
    }),
  ]);
  if (!course) return new Response(null, { status: 404 });
  const authenticatedStudentId = auth.claims.role === "student"
    && typeof auth.claims.studentId === "string"
    ? auth.claims.studentId
    : undefined;
  const visibleEvents = authenticatedStudentId
    ? events.filter((event) => {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        return shouldDeliverMutationToStudent({
          actionType: event.type,
          scope: payload.scope === "student" ? "student" : "course",
          targetStudentId: typeof payload.studentId === "string" ? payload.studentId : undefined,
          actorId: event.actorId,
        }, authenticatedStudentId);
      })
    : events;
  return Response.json({
    events: visibleEvents.map((event) => ({
      cursor: event.cursor.toString(),
      type: event.type,
      courseVersion: event.courseVersion,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    })),
    // Advance over filtered peer-only events as well, otherwise every poll
    // would scan the same high-frequency rows again.
    nextCursor: events.at(-1)?.cursor.toString() ?? parsed.data.after,
    hasMore: events.length === parsed.data.limit,
    courseVersion: course.version,
    // A course write and its durable event are normally committed together or
    // immediately adjacent. If a legacy/direct write ever advances Course.version
    // without an event, instruct clients to refresh the canonical snapshot so
    // they cannot remain stale until a manual browser reload.
    requiresReconciliation:
      course.version > (latestDurableEvent?.courseVersion ?? 0),
  });
}

export const GET = withHttpMetrics(
  "GET",
  "/api/courses/:courseId/events",
  getCourseEvents,
);
