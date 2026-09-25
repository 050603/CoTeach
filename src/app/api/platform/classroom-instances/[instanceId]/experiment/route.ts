import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getStudentExperimentAssessment, saveExperimentAssessmentDraft, submitExperimentAssessment } from "@/lib/platform/experiment-service";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ phase: z.enum(["pretest", "posttest"]), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])) }).strict();
const draftSchema = bodySchema.extend({ currentPage: z.number().int().min(0).max(100), version: z.number().int().min(0) });

export async function GET(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const phase = new URL(request.url).searchParams.get("phase");
  if (phase !== "pretest" && phase !== "posttest") return jsonError(request, "INVALID_INPUT", "请选择前测或后测", 400);
  try {
    const result = await getStudentExperimentAssessment(auth.claims, (await context.params).instanceId, phase);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_READ_FAILED", "无法读取测验", 503);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = draftSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请检查草稿内容", 400);
  try {
    const result = await saveExperimentAssessmentDraft(auth.claims, (await context.params).instanceId, parsed.data);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "EXPERIMENT_DRAFT_FAILED", "草稿保存失败，请重试", 503);
  }
}

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
