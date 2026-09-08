import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { enterClassroom, PlatformError } from "@/lib/platform/repository";
import { jsonError, studentCookieHeader } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf; const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  try {
    const result = await enterClassroom(auth.claims, (await context.params).instanceId);
    return Response.json({ instance: result.instance, participation: result.participation }, {
      headers: {
        "Set-Cookie": await studentCookieHeader({ userId: result.student.id, studentId: result.legacyStudentId, studentName: result.student.displayName, courseId: result.legacyCourseId ?? "", sessionVersion: result.student.sessionVersion }),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "CLASSROOM_ENTER_FAILED", "无法进入课堂", 503); }
}
