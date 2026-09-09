import { canAccessLegacyCourse } from "@/lib/platform/access";
import { randomUUID } from "node:crypto";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import {
  buildReflectionClassSummary,
} from "@/lib/teaching-ai/support-engine";
import {
  updateCourse,
  getCourse,
} from "@/lib/session/server-store";
import type {
  AiSupportRecord,
  Course,
} from "@/lib/session/types";
import {
  normalizeReflectionSurvey,
  latestReflectionByStudent,
} from "@/lib/reflection-survey";
import {
  reflectionSummaryMinimumSampleSize,
  type ReflectionSummaryTrigger,
} from "@/lib/reflection-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type SummaryRequest = { trigger?: ReflectionSummaryTrigger };

export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") return Response.json({ code: "FORBIDDEN" }, { status: 403 });

  const { courseId } = await context.params;
  if (!await canAccessLegacyCourse(auth.claims, courseId, "read")) return Response.json({ code: "FORBIDDEN", message: "无权访问该课堂的反思数据" }, { status: 403 });
  const parsedBody = await request.json().catch(() => ({}));
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as SummaryRequest
    : {};
  const trigger = body.trigger ?? "manual";
  if (trigger !== "threshold" && trigger !== "course-finished" && trigger !== "manual") {
    return Response.json({ code: "INVALID_TRIGGER", message: "反思摘要生成触发方式无效。" }, { status: 400 });
  }

  const limit = await checkDistributedRateLimit({
    namespace: "reflection-summary",
    key: `${auth.claims.sub}:${courseId}`,
    limit: 12,
    windowSeconds: 60 * 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  const course = await getCourse(courseId);
  if (!course) return Response.json({ code: "COURSE_NOT_FOUND" }, { status: 404 });

  const validResponseCount = countValidResponses(course);
  const minimumSampleSize = reflectionSummaryMinimumSampleSize(course.students.length);
  if (validResponseCount < minimumSampleSize) {
    return Response.json({
      code: "INSUFFICIENT_REFLECTIONS",
      message: `达到 ${minimumSampleSize} 份有效反思后自动生成。`,
      responseCount: validResponseCount,
      minimumSampleSize,
    }, { status: 409 });
  }

  try {
    const draft = await buildReflectionClassSummary({ course, trigger });
    const now = new Date().toISOString();
    const existing = (course.aiSupports ?? [])
      .filter((support) => support.kind === "reflection-class-summary" && support.targetType === "course")
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const support: AiSupportRecord = {
      ...draft,
      id: existing?.id ?? `reflection-class-summary-${course.id}-${randomUUID()}`,
      courseId: course.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await updateCourse(course.id, current => ({ ...current, aiSupports: [...(current.aiSupports ?? []).filter(item => item.id !== support.id), support] }), { actor: { id: auth.claims.sub!, role: auth.claims.role } });
    return Response.json({ support }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[reflection-summary] generation failed", {
      courseId,
      teacherId: auth.claims.sub,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({
      code: "SUMMARY_GENERATION_FAILED",
      message: "AI 课程总结生成失败，上一版内容仍然保留，请稍后重试。",
    }, { status: 502 });
  }
}

function countValidResponses(course: Course): number {
  const latest = latestReflectionByStudent(course.reflections);
  return course.students.filter((student) => normalizeReflectionSurvey(latest.get(student.id)?.survey)).length;
}
