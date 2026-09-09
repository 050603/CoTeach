import { randomUUID } from "node:crypto";
import {
  CourseCoverGenerationError,
  CourseCoverProviderUnavailableError,
  CourseCoverUploadError,
  generateCourseCoverImageOnServer,
  MAX_COURSE_COVER_UPLOAD_BYTES,
  persistUploadedCourseCover,
} from "@/lib/course-cover-server";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { jsonError } from "@/lib/platform/http";
import { TEMPLATE_COVER_MEDIA_PREFIX } from "@/lib/platform/classroom-cover";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type CoverContext = { params: Promise<{ courseId: string }> };

function coverError(request: Request, error: unknown) {
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
    console.error("[classroom-cover] generation failed", {
      code: error.code,
      detail: error.message,
    });
    return jsonError(request, error.code, error.userMessage, error.status);
  }
  console.error("[classroom-cover] operation failed", error);
  return jsonError(
    request,
    "CLASSROOM_COVER_OPERATION_FAILED",
    "课堂封面处理失败，请稍后重试或上传本地图片",
    503,
  );
}

async function persistCover(courseId: string, ownerId: string, coverImageUrl: string) {
  await updateCourse(
    courseId,
    (course) => ({ ...course, coverImageUrl }),
    { actor: { id: ownerId, role: "teacher" } },
  );
  return coverImageUrl;
}

export async function POST(request: Request, context: CoverContext) {
  const { courseId } = await context.params;
  const ownerId = await authorizeTemplateRequest(request, courseId);
  if (ownerId instanceof Response) return ownerId;
  try {
    const course = await getCourse(courseId);
    if (!course) return jsonError(request, "NOT_FOUND", "课堂不存在", 404);
    const coverImageUrl = await generateCourseCoverImageOnServer(
      course,
      `${TEMPLATE_COVER_MEDIA_PREFIX}${courseId}`,
      request.signal,
      `classroom-cover-v${course.version ?? 0}-${randomUUID()}`,
    );
    return Response.json(
      { coverImageUrl: await persistCover(courseId, ownerId, coverImageUrl) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return coverError(request, error);
  }
}

export async function PUT(request: Request, context: CoverContext) {
  const { courseId } = await context.params;
  const ownerId = await authorizeTemplateRequest(request, courseId);
  if (ownerId instanceof Response) return ownerId;
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
    const course = await getCourse(courseId);
    if (!course) return jsonError(request, "NOT_FOUND", "课堂不存在", 404);
    const coverImageUrl = await persistUploadedCourseCover(
      file,
      `${TEMPLATE_COVER_MEDIA_PREFIX}${courseId}`,
      `classroom-cover-upload-v${course.version ?? 0}-${randomUUID()}`,
    );
    return Response.json(
      { coverImageUrl: await persistCover(courseId, ownerId, coverImageUrl) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return coverError(request, error);
  }
}
