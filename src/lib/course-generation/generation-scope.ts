import type { OpenMaicSceneOutlineSnapshot } from "@/lib/session/types";

export type ClassroomGenerationScope = "full-course" | "test-lesson";

export type TestLessonGenerationTarget = {
  sectionId: string;
  sectionTitle: string;
  sceneOutlineIds: string[];
  durationSeconds: number;
};

export type ClassroomGenerationSelection<T> = {
  scope: ClassroomGenerationScope;
  outlines: T[];
  fullSceneCount: number;
  testLesson?: TestLessonGenerationTarget;
};

export function isTestLessonPromotion(
  previous: ClassroomGenerationScope | undefined,
  next: ClassroomGenerationScope,
): boolean {
  return previous === "test-lesson" && next === "full-course";
}

/**
 * Test mode is a bounded selection over the confirmed production outline. It
 * deliberately does not create alternate prompts, page schemas, or a second
 * generator. The selected lesson is passed to the same classroom pipeline as
 * a full course.
 */
export function selectClassroomGenerationOutlines<
  T extends Pick<
    OpenMaicSceneOutlineSnapshot,
    "id" | "type" | "title" | "lectureSectionId" | "lectureSectionTitle" | "targetDurationSec" | "estimatedDuration"
  >,
>(
  outlines: readonly T[],
  scope: ClassroomGenerationScope,
): ClassroomGenerationSelection<T> {
  if (scope === "full-course") {
    return { scope, outlines: [...outlines], fullSceneCount: outlines.length };
  }

  const sections = new Map<string, T[]>();
  for (const outline of outlines) {
    const sectionId = outline.lectureSectionId?.trim();
    if (!sectionId) continue;
    sections.set(sectionId, [...(sections.get(sectionId) ?? []), outline]);
  }
  const selected = [...sections.entries()].find(([, scenes]) =>
    scenes.some((scene) => scene.type === "quiz")
    && scenes.some((scene) => scene.type !== "quiz"),
  );
  if (!selected) {
    throw new Error("测试模式需要正式大纲中至少有一个包含讲授页面和节末检测的完整知识小节，请先检查课程大纲。");
  }

  const [sectionId, scenes] = selected;
  const durationSeconds = scenes.reduce(
    (sum, scene) => sum + Math.max(0, scene.targetDurationSec ?? scene.estimatedDuration ?? 0),
    0,
  );
  if (!durationSeconds || scenes.some((scene) => !(scene.targetDurationSec ?? scene.estimatedDuration))) {
    throw new Error("测试小节的正式页面时长不完整，请先修正课程大纲后再生成。");
  }

  return {
    scope,
    outlines: [...scenes],
    fullSceneCount: outlines.length,
    testLesson: {
      sectionId,
      sectionTitle: scenes[0]?.lectureSectionTitle?.trim() || scenes[0]?.title?.trim() || "第一知识小节",
      sceneOutlineIds: scenes.map((scene) => scene.id),
      durationSeconds,
    },
  };
}
