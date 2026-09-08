import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { joinOffering, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ invitationCode: z.string().trim().min(4).max(32) });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  const limit = await checkDistributedRateLimit({ namespace: "platform-join", key: `${getClientIp(request)}:${auth.claims.sub}`, limit: 20, windowSeconds: 60 });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请输入邀请码", 400);
  try {
    const enrollment = await joinOffering(auth.claims, parsed.data.invitationCode);
    return Response.json({ enrollment }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    console.error("[platform/student-join] failed", error);
    return jsonError(request, "JOIN_FAILED", "暂时无法加入教学班", 503);
  }
}
