import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { PlatformError, resetOfferingInvitation } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  expiresAt: z.string().datetime().nullable().optional(),
  disabled: z.boolean().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "邀请码设置无效", 400);
  try {
    const offeringId = (await context.params).offeringId;
    return Response.json({ invitation: await resetOfferingInvitation(auth.claims, offeringId, parsed.data) });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "INVITATION_UPDATE_FAILED", "无法更新邀请码", 503);
  }
}
