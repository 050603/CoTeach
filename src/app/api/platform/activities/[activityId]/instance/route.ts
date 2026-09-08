import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { createClassroomInstance, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ templateVersionId: z.string().trim().min(1) });

export async function POST(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const { activityId } = await context.params; const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请选择课堂模板版本", 400);
  try { return Response.json({ instance: await createClassroomInstance(auth.claims, activityId, parsed.data.templateVersionId) }, { status: 201 }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "INSTANCE_CREATE_FAILED", "无法创建课堂实例", 503); }
}

