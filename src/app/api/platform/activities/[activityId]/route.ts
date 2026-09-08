import { authenticateRequest } from "@/lib/auth/request-guards";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { archiveActivity, getStudentActivity, updateActivity, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
import { z } from "zod";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  try {
    const activity = await getStudentActivity(auth.claims, (await context.params).activityId);
    return Response.json({ activity }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "ACTIVITY_UNAVAILABLE", "无法加载活动", 503); }
}

const manageSchema = z.object({ title: z.string().trim().min(1).max(160).optional(), description: z.string().max(20_000).optional(), isOpen: z.boolean().optional(), opensAt: z.string().datetime().nullable().optional(), position: z.number().int().min(0).optional(), config: z.unknown().optional(), version: z.number().int().positive().optional() });

export async function PATCH(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const parsed = manageSchema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "活动信息无效", 400);
  try { return Response.json({ activity: await updateActivity(auth.claims, (await context.params).activityId, parsed.data) }); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "ACTIVITY_UPDATE_FAILED", "无法更新活动", 503); }
}

export async function DELETE(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json({ activity: await archiveActivity(auth.claims, (await context.params).activityId) }); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "ACTIVITY_ARCHIVE_FAILED", "无法归档活动", 503); }
}
