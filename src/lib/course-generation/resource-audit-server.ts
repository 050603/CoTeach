import { getCourse } from "@/lib/session/server-store";
import { readClassroom } from "@/lib/openmaic/server/classroom-storage";
import {
  findMissingTeachingToolResources,
  findMissingTtsResources,
} from "@/lib/course-generation/resource-readiness";
import { findUnresolvedClassroomMedia } from "@/lib/openmaic/server/classroom-media-generation";
import { resolveDurableCourseSceneOutlines } from "@/lib/course-generation/course-resource-outlines";
import { userFacingName } from "@/lib/user-facing-labels";

export type CourseResourceIssue = {
  id: string;
  type: "classroom" | "adaptive-resource" | "teaching-tool" | "tts" | "media" | "speech-sync";
  title: string;
  detail: string;
};

export async function auditCourseGeneratedResources(courseId: string): Promise<{
  classroomId?: string;
  issues: CourseResourceIssue[];
}> {
  const course = await getCourse(courseId);
  if (!course) return { issues: [] };
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const classroom = classroomId ? await readClassroom(classroomId) : null;
  const classroomIssues: CourseResourceIssue[] = classroomId && !classroom
    ? [{
        id: `classroom:${classroomId}`,
        type: "classroom",
        title: "课程课堂文件",
        detail: "课堂文件尚未持久化，需要自动恢复",
      }]
    : [];
  const outlines = await resolveDurableCourseSceneOutlines(
    courseId,
    course.content._openmaicSceneOutlines ?? [],
  );
  const toolIssues = classroom
    ? findMissingTeachingToolResources(outlines, classroom.scenes).map((issue) => ({
        id: `tool:${issue.outlineId}:${issue.tool}`,
        type: "teaching-tool" as const,
        title: userFacingName(issue.title, "课程教学工具"),
        detail: `${issue.tool === "whiteboard" ? "白板" : "教学工具"}计划动作未生成`,
      }))
    : [];
  const ttsIssues = classroom
    ? findMissingTtsResources(classroom.scenes).map((issue) => ({
        id: `tts:${issue.sceneId}:${issue.actionId}`,
        type: "tts" as const,
        title: userFacingName(issue.title, "课程讲解页面"),
        detail: "配置语音未生成",
      }))
    : [];
  const speechSyncIssues = classroom
    ? classroom.scenes.flatMap((scene) => {
        const speech = (scene.actions ?? []).filter((action) => (
          action.type === "speech" && Boolean(action.text.trim()) && Boolean(action.audioUrl)
        ));
        const unresolved = speech.filter((action) => (
          action.type === "speech" && (
            action.speechAlignment?.status !== "aligned" || Boolean(action.speechAlignment.error)
          )
        ));
        if (!unresolved.length) return [];
        const failed = unresolved.filter((action) => (
          action.type === "speech" && action.speechAlignment?.status === "failed"
        )).length;
        const bindingWarning = unresolved.find((action) => (
          action.type === "speech"
          && action.speechAlignment?.status === "aligned"
          && action.speechAlignment.error
        ));
        return [{
          id: `speech-sync:${scene.id}`,
          type: "speech-sync" as const,
          title: userFacingName(scene.title, "课程讲解页面"),
          detail: bindingWarning?.type === "speech" && bindingWarning.speechAlignment?.error
            ? bindingWarning.speechAlignment.error
            : failed > 0
            ? `${failed} 段语音对齐失败，按音频同步的字幕定位与指示动作已停用`
            : `${unresolved.length} 段语音尚未建立字幕与动作的音频时间线`,
        }];
      })
    : [];
  const adaptiveIssues = course.content.adaptiveLearningPlan?.enabled
    ? course.content.adaptiveLearningPlan.branches.flatMap((branch) =>
        branch.enabled !== false
        && branch.status === "teacher-confirmed"
        && (branch.preparedResource?.status !== "ready" || !branch.preparedResource.classroomId)
          ? [{
              id: `adaptive:${branch.id}`,
              type: "adaptive-resource" as const,
              title: userFacingName(branch.title, "个性化学习资源"),
              detail: branch.preparedResource?.status === "failed" ? "资源生成未完成，请重新生成" : "个性化学习资源尚未生成",
            }]
          : [],
      )
    : [];
  const recordedMediaFailures = classroom?.assetGeneration?.failures.filter((failure) =>
    failure.type === "image" || failure.type === "video"
  ) ?? [];
  const unresolvedMedia = classroom
    ? findUnresolvedClassroomMedia(outlines, classroom.scenes)
    : [];
  const mediaFailures = Array.from(new Map(
    // Deduplicate multiple diagnostics for the same generated media element.
    // Internal element ids and provider errors remain diagnostic-only.
    [...unresolvedMedia, ...recordedMediaFailures].map((failure) => [
      `${failure.type}:${failure.elementId}`,
      failure,
    ]),
  ).values());
  const mediaIssues = mediaFailures.flatMap((failure) =>
    failure.type === "image" || failure.type === "video"
      ? [{
          id: `media:${failure.type}:${failure.elementId}`,
          type: "media" as const,
          title: failure.type === "image" ? "课程图片" : "课程视频",
          detail: `${failure.type === "image" ? "图片" : "视频"}生成未完成，请重新生成`,
        }]
      : [],
  );
  return {
    classroomId,
    issues: [
      ...classroomIssues,
      ...adaptiveIssues,
      ...toolIssues,
      ...ttsIssues,
      ...speechSyncIssues,
      ...mediaIssues,
    ],
  };
}
