import { authenticateRequest } from "@/lib/auth/request-guards";
import { getClassroomExperimentResults } from "@/lib/platform/experiment-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try {
    const result = await getClassroomExperimentResults(auth.claims, (await context.params).instanceId);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_RESULTS_FAILED", "无法读取实验测验记录", 503);
  }
}
