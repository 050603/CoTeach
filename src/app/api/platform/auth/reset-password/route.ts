import { z } from "zod";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { resetStudentPassword, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const schema = z.object({ token: z.string().trim().min(20), password: z.string().min(8).max(256) });
export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf; const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查重置链接和新密码", 400);
  try { return Response.json(await resetStudentPassword(parsed.data.token, parsed.data.password)); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "RESET_FAILED", "无法重置密码", 503); }
}

