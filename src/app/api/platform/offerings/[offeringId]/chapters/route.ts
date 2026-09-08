import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { createChapter, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ title: z.string().trim().min(1).max(160), description: z.string().max(20_000).optional(), position: z.number().int().min(0).optional() });

export async function POST(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const { offeringId } = await context.params; const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查章节信息", 400);
  try { return Response.json({ chapter: await createChapter(auth.claims, offeringId, parsed.data) }, { status: 201 }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "CHAPTER_CREATE_FAILED", "无法创建章节", 503); }
}

