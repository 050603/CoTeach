import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { updateOffering, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ outline: z.string().max(20000).optional(), referenceMaterials: z.string().max(20000).optional(), name: z.string().trim().min(1).max(160).optional(), description: z.string().max(20_000).optional(), term: z.string().max(80).optional(), status: z.enum(["draft", "open", "finished", "archived"]).optional(), startsAt: z.string().datetime().nullable().optional(), endsAt: z.string().datetime().nullable().optional(), coverImageUrl: z.string().url().nullable().optional(), version: z.number().int().positive().optional() });

export async function PATCH(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const { offeringId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查教学班信息", 400);
  try { return Response.json({ offering: await updateOffering(auth.claims, offeringId, parsed.data) }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "OFFERING_UPDATE_FAILED", "无法更新教学班", 503); }
}
