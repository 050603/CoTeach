import { z } from "zod";
import { isDatabaseConfigured } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { validateInvitation } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(4).max(32) });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  if (!isDatabaseConfigured()) return jsonError(request, "DB_NOT_CONFIGURED", "数据库未配置", 503);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请输入邀请码", 400);
  const invitation = await validateInvitation(parsed.data.code);
  if (!invitation) return jsonError(request, "INVITE_CODE_INVALID", "课程邀请码无效、已停用或已过期", 404);
  return Response.json({ invitation }, { headers: { "Cache-Control": "no-store" } });
}

