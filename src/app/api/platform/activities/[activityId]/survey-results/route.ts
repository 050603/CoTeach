import { authenticateRequest } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { getSurveyAnalytics, PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try {
    const result = await getSurveyAnalytics(auth.claims, (await context.params).activityId);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "SURVEY_RESULTS_UNAVAILABLE", "暂时无法加载问卷数据", 503);
  }
}
