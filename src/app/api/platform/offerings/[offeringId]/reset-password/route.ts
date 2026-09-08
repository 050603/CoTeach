import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { requestStudentPasswordReset, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const schema = z.object({ enrollmentId: z.string().trim().min(1) });

export async function POST(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const offeringId = (await context.params).offeringId;
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "缺少学生关系", 400);
  const enrollment = await prisma.enrollment.findFirst({ where: { offeringId, OR: [{ id: parsed.data.enrollmentId }, { userId: parsed.data.enrollmentId }] } });
  if (!enrollment) return jsonError(request, "NOT_FOUND", "学生关系不存在", 404);
  try { return Response.json(await requestStudentPasswordReset(auth.claims, enrollment.id), { status: 201 }); }
  catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "RESET_REQUEST_FAILED", "无法生成重置链接", 503); }
}
