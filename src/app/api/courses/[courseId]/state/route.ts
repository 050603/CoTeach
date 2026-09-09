import { encodeEventCursor } from "@/lib/realtime/event-cursor";
import { resolveCourseEventScope } from "@/lib/realtime/course-event-scope";
import { prisma } from "@/lib/db/client";
import { loadCourse } from "@/lib/db/session-repository";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { scopeCourseForClaims } from "@/lib/auth/course-scope";
import { withHttpMetrics } from "@/lib/observability/http";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getCourseState(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) {
    return new Response(null, { status: 403 });
  }
  const scope = await resolveCourseEventScope(courseId);
  if (!scope) return new Response(null, { status: 404 });
  const latestEvent = await prisma.domainEvent.findFirst({ where: scope.where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
  const course = await loadCourse(courseId);
  if (!course) return new Response(null, { status: 404 });
  const scoped = scopeCourseForClaims(course, auth.claims);
  const etag = `W/"course-${courseId}-${course.version ?? 0}-${auth.claims.role}-${auth.claims.sub}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return Response.json(
    {
      course: scoped,
      courseVersion: course.version ?? 0,
      eventCursor: latestEvent ? encodeEventCursor(latestEvent) : "0",
    },
    {
      headers: {
        ETag: etag,
        "Cache-Control": "private, no-cache",
        Vary: "Cookie",
      },
    },
  );
}

export const GET = withHttpMetrics(
  "GET",
  "/api/courses/:courseId/state",
  getCourseState,
);
