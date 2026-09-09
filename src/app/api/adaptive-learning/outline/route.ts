import { generateCourseEntryPackage } from "@/lib/course-entry-generation";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import type { KnowledgePoint, OpenMaicSceneOutlineSnapshot } from "@/lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    courseId?: string;
    knowledgePoints?: unknown;
    mainScenes?: unknown;
  } | null;
  if (!body?.courseId) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const authorized = await authorizeTemplateRequest(request, body.courseId);
  if (authorized instanceof Response) return authorized;
  const course = await getCourse(body.courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });

  const requestedKnowledgePoints = Array.isArray(body.knowledgePoints)
    ? body.knowledgePoints.filter((point): point is KnowledgePoint =>
        Boolean(
          point
          && typeof point === "object"
          && typeof (point as KnowledgePoint).id === "string"
          && typeof (point as KnowledgePoint).name === "string",
        ),
      )
    : [];
  const knowledgePoints = requestedKnowledgePoints.length
    ? requestedKnowledgePoints
    : course.content.knowledgePoints;
  const requestedMainScenes = Array.isArray(body.mainScenes)
    ? body.mainScenes.filter((scene): scene is OpenMaicSceneOutlineSnapshot =>
        Boolean(
          scene
          && typeof scene === "object"
          && typeof (scene as OpenMaicSceneOutlineSnapshot).id === "string"
          && typeof (scene as OpenMaicSceneOutlineSnapshot).title === "string",
        ),
      )
    : [];
  const sourceMainScenes = requestedMainScenes.length
    ? requestedMainScenes
    : course.content._openmaicSceneOutlines ?? [];
  try {
    const result = await generateCourseEntryPackage({
      course: {
        name: course.name,
        subject: course.subject,
        grade: course.grade,
        hours: course.hours,
        summary: course.summary,
        learningObjectives: course.learningObjectives,
        learnerProfile: course.learnerProfile,
        pblConfig: course.pblConfig,
      },
      knowledgePoints,
      knowledgeGraph: course.content.knowledgeGraph,
      mainScenes: sourceMainScenes,
    });
    const persisted = await updateCourse(course.id, (current) => ({
      ...current,
      content: {
        ...current.content,
        knowledgeGraph: result.knowledgeGraph,
        adaptiveLearningPlan: result.plan,
      },
    }), { actor: { id: authorized, role: "teacher" } });
    const savedCourse = persisted.courses.find((item) => item.id === course.id);
    if (!savedCourse?.content.adaptiveLearningPlan || !savedCourse.content.knowledgeGraph) {
      throw new Error("课程入口学习包已生成，但原子保存校验失败");
    }
    return Response.json({
      plan: savedCourse.content.adaptiveLearningPlan,
      knowledgeGraph: savedCourse.content.knowledgeGraph,
      reviewSummary: result.reviewSummary,
      persisted: true,
      warning: result.warnings.length
        ? `方案已通过课程级质量底线，另有 ${result.warnings.length} 项非阻断优化建议：${result.warnings.join("；")}`
        : undefined,
    });
  } catch (error) {
    console.error("[adaptive-learning] outline generation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "unknown failure",
    });
    return Response.json({
      error: error instanceof Error
        ? `课程入口学习包生成失败：${error.message}`
        : "课程入口学习包生成失败，原方案已保留。",
    }, { status: 503 });
  }
}
