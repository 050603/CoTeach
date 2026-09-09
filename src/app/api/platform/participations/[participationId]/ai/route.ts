import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { aiCommandSchema, mutateAiCollaboration, readAiCollaboration } from "@/lib/platform/ai-collaboration";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ participationId: string }> };
function failure(request: Request, error: unknown) {
  if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
  return jsonError(request, "AI_COLLABORATION_FAILED", "协作记录暂时不可用，请重试", 503);
}
export async function GET(request: Request, context: Context) {
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  try { return Response.json(await readAiCollaboration(auth.claims, (await context.params).participationId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return failure(request, error); }
}
export async function POST(request: Request, context: Context) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request); if ("response" in auth) return auth.response;
  const parsed = aiCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "AI 协作操作无效", 400);
  try {
    const limit = await checkDistributedRateLimit({ namespace: "v2-ai-collaboration", key: auth.claims.sub!, limit: 30, windowSeconds: 60 });
    if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
    return Response.json(await mutateAiCollaboration(auth.claims, (await context.params).participationId, parsed.data, request.signal), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(request, error); }
}
