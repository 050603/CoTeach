import { authenticateRequest } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { PlatformError } from "@/lib/platform/repository";
import { getStudentActivitySubmissions } from "@/lib/platform/student-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ offeringId: string; enrollmentId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const url = new URL(request.url);
  const activityId = url.searchParams.get("activityId")?.trim();
  const page = Number(url.searchParams.get("page") ?? "1");
  if (!activityId) return jsonError(request, "INVALID_INPUT", "请选择学习活动", 400);
  if (!Number.isSafeInteger(page) || page < 1) return jsonError(request, "INVALID_INPUT", "页码无效", 400);
  try {
    const { offeringId, enrollmentId } = await context.params;
    return Response.json(await getStudentActivitySubmissions(auth.claims, offeringId, enrollmentId, activityId, page), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "SUBMISSIONS_UNAVAILABLE", "无法加载提交历史", 503);
  }
}
