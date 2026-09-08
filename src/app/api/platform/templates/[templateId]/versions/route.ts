import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { archivePrivateTemplate, createTemplateVersion, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const schema = z.object({ snapshot: z.unknown(), mediaRefs: z.unknown().optional() });
export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }) { const csrf = requireSameOrigin(request); if (csrf) return csrf; const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response; const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "模板快照无效", 400); try { return Response.json({ version: await createTemplateVersion(auth.claims, (await context.params).templateId, parsed.data) }, { status: 201 }); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "TEMPLATE_VERSION_FAILED", "无法发布模板版本", 503); } }

export async function DELETE(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json({ template: await archivePrivateTemplate(auth.claims, (await context.params).templateId) }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "TEMPLATE_ARCHIVE_FAILED", "无法归档模板", 503); }
}
