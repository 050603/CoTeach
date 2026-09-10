import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import {
  ActionEnvelopeSchema,
  actionCourseId,
  type ActionEnvelope,
} from "@/lib/courses/contracts";
import { CourseActionError, executeCourseAction } from "@/lib/courses/action-service";
import { withHttpMetrics } from "@/lib/observability/http";
import { isProjectionOnlyAction } from "@/lib/realtime/projection-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function postCourseAction(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;

  const parsed = ActionEnvelopeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(request, "INVALID_ACTION", "Action envelope is invalid.", 400, parsed.error.flatten());
  }
  const envelope = parsed.data as unknown as ActionEnvelope;
  if (actionCourseId(envelope.action) !== courseId) {
    return apiError(request, "COURSE_MISMATCH", "Action course does not match the route.", 400);
  }
  const projectionControl = auth.claims.role === "teacher"
    && isProjectionOnlyAction(envelope.action);
  const limit = await checkDistributedRateLimit({
    namespace: projectionControl ? "course-projection" : "course-action",
    key: `${auth.claims.sub}:${courseId}`,
    // A two-second fixed window permits a short burst of 20 control updates
    // while keeping sustained projection traffic at 10 updates/second.
    limit: projectionControl ? 20 : auth.claims.role === "teacher" ? 120 : 90,
    windowSeconds: projectionControl ? 2 : 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  try {
    return Response.json(await executeCourseAction(courseId, envelope, auth.claims));
  } catch (error) {
    if (error instanceof CourseActionError) {
      return apiError(request, error.code, error.message, error.status, error.details);
    }
    console.error("[course-actions] action failed", {
      requestId: envelope.requestId,
      courseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError(request, "ACTION_FAILED", "The action could not be completed.", 500);
  }
}

export const POST = withHttpMetrics(
  "POST",
  "/api/courses/:courseId/actions",
  postCourseAction,
);

function apiError(
  request: Request,
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return Response.json(
    {
      code,
      message,
      requestId: request.headers.get("x-request-id") ?? "unknown",
      ...(details === undefined ? {} : { details }),
    },
    { status },
  );
}
