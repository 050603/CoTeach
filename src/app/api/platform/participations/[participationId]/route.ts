import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { readClassroom, saveWorkspace } from "@/lib/platform/classroom";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ participationId: string }> };
export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  try { return Response.json(await readClassroom(auth.claims, (await context.params).participationId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(request, error); }
}
export async function PATCH(request: Request, context: Context) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  try { return Response.json(await saveWorkspace(auth.claims, (await context.params).participationId, await request.json().catch(() => null)), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(request, error); }
}
function failure(request: Request, error: unknown) {
  if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
  return jsonError(request, "CLASSROOM_FAILED", "无法保存或读取课堂，请重试", 503);
}
