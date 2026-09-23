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
 * Recover the canonical full outline from the persisted generation request.
 * A completed test run intentionally exposes only its selected section on the
 * course preview, so the preview snapshot cannot be used as the promotion
 * source of truth.
 */
export function resolveFullCoursePromotionOutlines<T extends { id: string }>(input: {
  persistedOutlines: readonly T[] | undefined;
  expectedFullSceneCount: number | undefined;
  testLesson: TestLessonGenerationTarget | undefined;
}): T[] | null {
  const outlines = input.persistedOutlines ?? [];
  const testIds = input.testLesson?.sceneOutlineIds ?? [];
  if (!Number.isInteger(input.expectedFullSceneCount)
    || (input.expectedFullSceneCount ?? 0) <= testIds.length
    || outlines.length !== input.expectedFullSceneCount
    || new Set(outlines.map((outline) => outline.id)).size !== outlines.length
    || testIds.length === 0) return null;
  const fullIds = new Set(outlines.map((outline) => outline.id));
  if (new Set(testIds).size !== testIds.length || testIds.some((id) => !fullIds.has(id))) return null;
  return [...outlines];
}

/**
 * Test mode is a bounded selection over the confirmed production outline. It
 * deliberately does not create alternate prompts, page schemas, or a second
 * generator. The selected lesson is passed to the same classroom pipeline as
 * a full course.
 */
export function selectClassroomGenerationOutlines<
  T extends {
    id: string;
    type: OpenMaicSceneOutlineSnapshot["type"];
    title: string;
    description?: string;
    keyPoints?: readonly string[];
    teachingObjective?: string;
    lectureSectionId?: string;
    lectureSectionTitle?: string;
    targetDurationSec?: number;
    estimatedDuration?: number;
  },
>(
  outlines: readonly T[],
  scope: ClassroomGenerationScope,
  preferredFocus = "",
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
  const completeSections = [...sections.entries()].filter(([, scenes]) =>
    scenes.some((scene) => scene.type === "quiz")
    && scenes.some((scene) => scene.type !== "quiz"),
  );
  const normalizedFocus = preferredFocus.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const focusNgrams = new Set<string>();
  for (let size = 3; size <= Math.min(10, normalizedFocus.length); size += 1) {
    for (let index = 0; index + size <= normalizedFocus.length; index += 1) {
      focusNgrams.add(normalizedFocus.slice(index, index + size));
    }
  }
  const relevance = (scenes: readonly T[]): number => {
    if (!focusNgrams.size) return 0;
    const text = scenes.map((scene) => [
      scene.lectureSectionTitle,
      scene.title,
      scene.description,
      scene.teachingObjective,
      ...(scene.keyPoints ?? []),
    ].filter(Boolean).join(" ")).join(" ").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return [...focusNgrams].reduce((score, phrase) => (
      text.includes(phrase) ? score + phrase.length * phrase.length : score
    ), 0);
  };
  const selected = completeSections
    .map((entry, index) => ({ entry, index, score: relevance(entry[1]) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.entry;
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
