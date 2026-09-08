import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { finishClassroomInstance, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf; const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json({ instance: await finishClassroomInstance(auth.claims, (await context.params).instanceId) }); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "INSTANCE_FINISH_FAILED", "无法结束课堂", 503); }
}

