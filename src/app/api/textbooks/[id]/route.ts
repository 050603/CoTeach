import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { textbookApiError } from "@/lib/textbook/http";
import { getTextbookDetails, updateTextbook } from "@/lib/textbook/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const PatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  author: z.string().trim().max(300).nullable().optional(),
  archived: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return new Response(null, { status: 404 });
  try {
    return Response.json(await getTextbookDetails(params.data.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_DETAIL_FAILED", "暂时无法读取教材详情。 ");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return new Response(null, { status: 404 });
  const body = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: "INVALID_TEXTBOOK_UPDATE", message: "教材修改内容无效。" }, { status: 400 });
  try {
    return Response.json({ textbook: await updateTextbook(params.data.id, auth.claims.sub!, body.data) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_UPDATE_FAILED", "暂时无法更新教材。 ");
  }
}
