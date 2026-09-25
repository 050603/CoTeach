import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { isDeepStrictEqual } from "node:util";
import { contentGenerationJobs } from "@/lib/course-generation/job-storage";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { readClassroom } from "@/lib/openmaic/server/classroom-storage";
import { remeasureClassroomSpeech } from "@/lib/openmaic/server/classroom-timing-audit";
import { summarizeTeachingTimingAudit } from "@/lib/openmaic/server/classroom-asset-generation";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ courseId: string }> };

class StaleTimingAuditError extends Error {}

export async function POST(request: Request, context: Context) {
  const { courseId } = await context.params;
  const teacher = await authorizeTemplateRequest(request, courseId);
  if (teacher instanceof Response) return teacher;

  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: "课程不存在" }, { status: 404 });
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId) return Response.json({ error: "学生 AI 课堂尚未生成" }, { status: 409 });
  const classroom = await readClassroom(classroomId);
  if (!classroom) return Response.json({ error: "当前课堂资源不存在，请返回编辑页检查" }, { status: 409 });
  if (classroom.assetGeneration?.status === "running") {
    return Response.json({ error: "音频仍在生成，请完成后重新核查" }, { status: 409 });
  }

  try {
    const job = await contentGenerationJobs.findUnique({ where: { courseId } });
    const hasSavedAudio = classroom.scenes.some((scene) => scene.actions?.some((action) =>
      action.type === "speech" && Boolean(action.audioUrl)));
    const enableTTS = hasSavedAudio || (job?.request as { enableTTS?: boolean } | null)?.enableTTS !== false;
    const scenes = enableTTS
      ? await remeasureClassroomSpeech(classroomId, classroom.scenes)
      : classroom.scenes;
    const audit = summarizeTeachingTimingAudit({
      outlines: (course.content._openmaicSceneOutlines ?? []) as SceneOutline[],
      studentScenes: scenes,
      enableTTS,
    });
    const latestClassroom = await readClassroom(classroomId);
    if (!latestClassroom || latestClassroom.revision !== classroom.revision) throw new StaleTimingAuditError();
    await updateCourse(courseId, (current) => {
      if ((current.aiLearningClassroomId || current.content._openmaicClassroomId) !== classroomId
        || !isDeepStrictEqual(current.content._openmaicSceneOutlines, course.content._openmaicSceneOutlines)
        || current.content.teachingRevisionState?.updatedAt !== course.content.teachingRevisionState?.updatedAt) {
        throw new StaleTimingAuditError();
      }
      const revisionState = current.content.teachingRevisionState;
      return {
        ...current,
        content: {
          ...current.content,
          teachingTimingAudit: audit,
          ...(revisionState ? {
            teachingRevisionState: {
              ...revisionState,
              classroomRevision: classroom.revision ?? revisionState.classroomRevision,
              invalidated: audit.complete
                ? revisionState.invalidated.filter((item) => item !== "timing-audit")
                : revisionState.invalidated,
            },
          } : {}),
        },
      };
    }, { actor: { id: teacher, role: "teacher" } });
    return Response.json({ audit });
  } catch (error) {
    if (error instanceof StaleTimingAuditError) {
      return Response.json({ error: "课堂在核查期间已修改，请重新核查最新版本" }, { status: 409 });
    }
    console.error("[timing-audit] Failed to check classroom audio", error);
    return Response.json({ error: "音频时长核查失败，请稍后重试" }, { status: 500 });
  }
}
