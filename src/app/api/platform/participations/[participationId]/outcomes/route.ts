import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { classroomOutcomeSchema, getClassroomOutcomes, saveClassroomOutcome } from "@/lib/platform/classroom-outcomes";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ participationId: string }> };
function failure(request: Request, error: unknown) {
  if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
  return jsonError(request, "OUTCOMES_FAILED", "课堂成果操作失败，请重试", 503);
}
export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  try { return Response.json(await getClassroomOutcomes(auth.claims, (await context.params).participationId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(request, error); }
}
export async function POST(request: Request, context: Context) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const parsed = classroomOutcomeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "提交内容无效", 400);
  try { return Response.json({ outcome: await saveClassroomOutcome(auth.claims, (await context.params).participationId, parsed.data) }); }
  catch (error) { return failure(request, error); }
}
