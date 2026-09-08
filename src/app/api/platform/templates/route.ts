import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { createPrivateTemplate, importLegacyCourseTemplate, listPrivateTemplates, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  return Response.json({ templates: await listPrivateTemplates(auth.claims) }, { headers: { "Cache-Control": "private, no-store" } });
}

const schema = z.object({ title: z.string().trim().min(1).max(160), description: z.string().max(20_000).optional(), snapshot: z.unknown(), mediaRefs: z.unknown().optional() });
const importSchema = z.object({ courseId: z.string().trim().min(1), title: z.string().trim().max(160).optional() });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  const imported = importSchema.safeParse(body);
  try {
    if (parsed.success) return Response.json(await createPrivateTemplate(auth.claims, parsed.data), { status: 201 });
    if (imported.success) return Response.json(await importLegacyCourseTemplate(auth.claims, imported.data.courseId, imported.data.title), { status: 201 });
    return jsonError(request, "INVALID_INPUT", "模板信息无效", 400);
  } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "TEMPLATE_CREATE_FAILED", "无法创建模板", 503); }
}
