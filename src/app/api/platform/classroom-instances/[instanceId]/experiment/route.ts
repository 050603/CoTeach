import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { submitExperimentAssessment } from "@/lib/platform/experiment-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ phase: z.enum(["pretest", "posttest"]), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])) }).strict();

export async function POST(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查前后测作答内容", 400);
  try {
    const row = await submitExperimentAssessment(auth.claims, (await context.params).instanceId, parsed.data);
    return Response.json({ submission: { id: row.id, phase: row.phase, submittedAt: row.submittedAt } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_SUBMISSION_FAILED", "测验提交失败，请稍后重试", 503);
  }
}
