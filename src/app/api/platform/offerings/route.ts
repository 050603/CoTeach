import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { createOffering, listTeacherOfferings, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(20_000).optional(), term: z.string().max(80).optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(), legacyCourseId: z.string().trim().min(1).optional() });

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try { return Response.json({ offerings: await listTeacherOfferings(auth.claims) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "OFFERINGS_UNAVAILABLE", "无法加载教学班", 503); }
}

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查教学班信息", 400, parsed.error.flatten());
  try { return Response.json({ offering: await createOffering(auth.claims, parsed.data) }, { status: 201 }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "OFFERING_CREATE_FAILED", "无法创建教学班", 503); }
}

