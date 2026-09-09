import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { deleteArchivedPrivateTemplate, PlatformError, restorePrivateTemplate } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("restore") });

export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "课程恢复操作无效", 400);
  try {
    return Response.json({ template: await restorePrivateTemplate(auth.claims, (await context.params).templateId) });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "TEMPLATE_RESTORE_FAILED", "无法恢复课程", 503);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try {
    return Response.json({ template: await deleteArchivedPrivateTemplate(auth.claims, (await context.params).templateId) });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "TEMPLATE_DELETE_FAILED", "无法删除课程", 503);
  }
}
