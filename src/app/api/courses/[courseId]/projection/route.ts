import { authenticateRequest } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { withHttpMetrics } from "@/lib/observability/http";
import { projectionSnapshotFromUiState } from "@/lib/realtime/projection-state";
import type { CourseUiState } from "@/lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getProjectionState(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  const instance = await prisma.classroomInstance.findFirst({
    where: {
      id: courseId,
      ...(auth.claims.role === "teacher"
        ? {
            activity: {
              chapter: {
                offering: { teachers: { some: { userId: auth.claims.sub } } },
              },
            },
          }
        : {
            participations: {
              some: {
                enrollment: {
                  userId: auth.claims.sub,
                  status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
                },
              },
            },
          }),
    },
    select: { runtimeConfig: true },
  });
  if (!instance) return new Response(null, { status: 403 });
  const runtime = asRecord(instance.runtimeConfig);
  const uiState = asRecord(runtime.uiState) as CourseUiState;
  const courseVersion = finiteVersion(runtime.version, 1);
  return Response.json(
    projectionSnapshotFromUiState({ courseId, courseVersion, uiState }),
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteVersion(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export const GET = withHttpMetrics(
  "GET",
  "/api/courses/:courseId/projection",
  getProjectionState,
);
