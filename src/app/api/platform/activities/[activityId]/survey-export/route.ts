import { authenticateRequest } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { PlatformError } from "@/lib/platform/repository";
import { createSurveyCsvExport } from "@/lib/platform/survey-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;

  try {
    const { activityId } = await context.params;
    const exported = await createSurveyCsvExport(auth.claims, activityId);
    return new Response(exported.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "SURVEY_EXPORT_FAILED", "暂时无法导出问卷数据", 503);
  }
}
