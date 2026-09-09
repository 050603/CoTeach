import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { requireTeacherUser } from "@/lib/platform/access";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { savePblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { jsonError } from "@/lib/platform/http";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
const schema = z.object({ name: z.string().trim().min(1).max(160).default("未命名课程"), subject: z.string().trim().max(100).default(""), grade: z.string().trim().max(100).default(""), hours: z.number().positive().max(100).default(1) });
export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请填写有效的课程信息", 400);
  try {
    const teacher = await requireTeacherUser(auth.claims);
    const course = await savePblTemplateCourse(createPblTemplateCourse(randomUUID(), parsed.data), teacher.id);
    return Response.json({ templateId: course.id, course }, { status: 201 });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "TEMPLATE_CREATE_FAILED", "无法创建备课模板，请重试", 503);
  }
}
