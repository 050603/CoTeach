import type { Course, Stage, TeacherResourceScene } from "@/lib/session/types";

export function resolveTeacherResourceStageKey(
  scene: TeacherResourceScene,
  stages: Stage[],
): string | undefined {
  if (scene.stageKey && stages.some((stage) => stage.key === scene.stageKey)) {
    return scene.stageKey;
  }

  const normalizedTitle = scene.title.toLowerCase();
  const titleMatch = stages.find(
    (stage) =>
      normalizedTitle.includes(stage.key.toLowerCase()) ||
      normalizedTitle.includes(stage.label.toLowerCase()),
  );
  if (titleMatch) return titleMatch.key;

  if (scene.role === "introduction" || scene.role === "pbl-topic") {
    return stages.find((stage) => stage.view === "project-launch")?.key ?? stages[0]?.key;
  }

  return stages[0]?.key;
}

export function getTeacherResourcesForStage(
  course: Pick<Course, "stages" | "content">,
  stageKey: string,
): TeacherResourceScene[] {
  return (course.content.teacherResources?.scenes ?? []).filter(
    (scene) => resolveTeacherResourceStageKey(scene, course.stages) === stageKey,
  );
}

export function teacherResourceTypeLabel(type: TeacherResourceScene["type"]): string {
  switch (type) {
    case "interactive":
      return "互动演示";
    case "quiz":
      return "课堂测验";
    case "pbl":
      return "PBL 项目演示";
    default:
      return "PPT 幻灯片";
  }
}
