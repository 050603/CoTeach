import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import {
  generateOfferingCoverImage,
  uploadOfferingCoverImage,
} from "@/lib/platform/offering-cover-server";
import {
  CourseCoverGenerationError,
  CourseCoverProviderUnavailableError,
  CourseCoverUploadError,
  MAX_COURSE_COVER_UPLOAD_BYTES,
} from "@/lib/course-cover-server";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function coverError(request: Request, error: unknown) {
  if (error instanceof PlatformError) {
    return jsonError(request, error.code, error.message, error.status);
  }
  if (error instanceof CourseCoverUploadError) {
    return jsonError(request, error.code, error.message, error.status);
  }
  if (error instanceof CourseCoverProviderUnavailableError) {
    return jsonError(
      request,
      error.code,
      "尚未配置可用的图片生成服务，请先在教师设置中配置图片模型，或上传本地图片",
      503,
    );
  }
  if (error instanceof CourseCoverGenerationError) {
    console.error("[offering-cover] generation failed", {
      code: error.code,
      detail: error.message,
    });
    return jsonError(request, error.code, error.userMessage, error.status);
  }
  console.error("[offering-cover] operation failed", error);
  return jsonError(
    request,
    "OFFERING_COVER_GENERATION_FAILED",
    "图片生成服务暂时不可用，请稍后重试或上传本地图片",
    503,
  );
}

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
      request.signal,
    );
    return Response.json(
      { offering },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return coverError(request, error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ offeringId: string }> },
) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_COURSE_COVER_UPLOAD_BYTES + 256 * 1024) {
    return jsonError(request, "FILE_TOO_LARGE", "封面图片不能超过 10 MB", 413);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return jsonError(request, "INVALID_CONTENT_TYPE", "封面上传请求格式无效", 415);
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonError(request, "FILE_REQUIRED", "请选择一张封面图片", 400);
    }
    const offering = await uploadOfferingCoverImage(
      auth.claims,
      (await context.params).offeringId,
      file,
    );
    return Response.json(
      { offering },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return coverError(request, error);
  }
}
