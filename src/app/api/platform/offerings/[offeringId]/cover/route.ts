import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { generateOfferingCoverImage } from "@/lib/platform/offering-cover-server";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ offeringId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  try {
    const offering = await generateOfferingCoverImage(
      auth.claims,
      (await context.params).offeringId,
    );
    return Response.json(
      { offering },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof PlatformError) {
      return jsonError(request, error.code, error.message, error.status);
    }
    return jsonError(
      request,
      "OFFERING_COVER_GENERATION_FAILED",
      "课程封面生成失败，请稍后重试",
      503,
    );
  }
}
