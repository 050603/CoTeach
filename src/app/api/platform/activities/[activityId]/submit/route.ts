import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { submissionSchema, submitActivity } from "@/lib/platform/submissions";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ activityId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = submissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "提交内容无效", 400);
  try { return Response.json({ progress: await submitActivity(auth.claims, (await context.params).activityId, parsed.data) }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "SUBMIT_FAILED", "提交失败，请重试", 503); }
}
