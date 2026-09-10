import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { PlatformError } from "@/lib/platform/repository";
import { getOfferingStudentDetail, withdrawOfferingStudent } from "@/lib/platform/student-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ offeringId: string; enrollmentId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try {
    const { offeringId, enrollmentId } = await context.params;
    return Response.json(await getOfferingStudentDetail(auth.claims, offeringId, enrollmentId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "STUDENT_RECORD_UNAVAILABLE", "无法加载学生学习档案", 503);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ offeringId: string; enrollmentId: string }> }) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try {
    const { offeringId, enrollmentId } = await context.params;
    return Response.json(await withdrawOfferingStudent(auth.claims, offeringId, enrollmentId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "STUDENT_WITHDRAW_FAILED", "无法将学生移出教学班", 503);
  }
}
