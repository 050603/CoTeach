import type { OpenMaicSceneOutlineSnapshot } from "@/lib/session/types";

export type GenerationPlanIdentity = {
  id: string;
  type?: string;
  spatialParentId?: string;
  sourcePageIds?: readonly string[];
  sectionPlanVersion?: string;
  lectureSectionId?: string;
  targetDurationSec?: number;
  estimatedDuration?: number;
  plannedTiming?: { narrationSec: number; learnerActivitySec: number; transitionSec: number };
};

/** Source IDs remain stable when a section redistributes content across pages. */
export function getOutlineSourcePageIds(outline: GenerationPlanIdentity): readonly string[] {
  return outline.sourcePageIds ?? [outline.spatialParentId ?? outline.id];
}

export function isOutlineWithinSourceSelection(
  outline: GenerationPlanIdentity,
  selectedIds: ReadonlySet<string>,
): boolean {
  const sources = getOutlineSourcePageIds(outline);
  return sources.length > 0 && sources.every((id) => selectedIds.has(id));
}

/** Select the current pages of stable source IDs, including every measured
 * sibling. Explicit physical page IDs remain supported for legacy callers. */
export function resolveGenerationOutlineSelection<T extends GenerationPlanIdentity>(
  outlines: readonly T[], requestedIds?: readonly string[],
): T[] | null {
  if (requestedIds === undefined) return [...outlines];
  const requested = new Set(requestedIds);
  if (!requested.size || requested.size !== requestedIds.length
    || requestedIds.some((id) => !id.trim())) return null;
  const selected = outlines.filter((page) => requested.has(page.id)
    || getOutlineSourcePageIds(page).some((id) => requested.has(id)));
  if (!selected.length || new Set(selected.map((page) => page.id)).size !== selected.length
    || requestedIds.some((id) => !selected.some((page) => page.id === id
      || getOutlineSourcePageIds(page).includes(id)))
    || selected.some((page) => !requested.has(page.id)
      && !isOutlineWithinSourceSelection(page, requested))) return null;
  return selected;
}

/** Shared source coverage alone cannot prove that all adopted siblings exist.
 * An older physical page may expand again through the spatial compiler. */
export function hasCompleteGenerationOutlineCoverage(
  expected: readonly GenerationPlanIdentity[], actual: readonly GenerationPlanIdentity[],
): boolean {
  const expectedIds = new Set(expected.map((page) => page.id));
  return expected.length > 0 && new Set(actual.map((page) => page.id)).size === actual.length
    && expected.every((page) => actual.some((candidate) => (candidate.id === page.id
      || candidate.spatialParentId === page.id && !expectedIds.has(candidate.id))
      && candidate.lectureSectionId === page.lectureSectionId
      && (page.sectionPlanVersion === undefined || candidate.sectionPlanVersion === page.sectionPlanVersion)));
}

/** Replanning may redistribute time only inside one explicitly versioned section. */
export function hasCompatibleOutlinePlan(
  expected: readonly GenerationPlanIdentity[],
  actual: readonly GenerationPlanIdentity[],
): boolean {
  if (!expected.length || !actual.length
    || new Set(actual.map((page) => page.id)).size !== actual.length) return false;
  const sources = (pages: readonly GenerationPlanIdentity[]) => new Set(pages.flatMap((page) => [...getOutlineSourcePageIds(page)]));
  const expectedSources = sources(expected);
  const actualSources = sources(actual);
  if (actualSources.size !== expectedSources.size || [...actualSources].some((id) => !expectedSources.has(id))) return false;
  const sourceSections = new Map<string, string | undefined>();
  const sourceTypes = new Map<string, string | undefined>();
  for (const page of expected) {
    for (const id of getOutlineSourcePageIds(page)) {
      if (sourceSections.has(id) && sourceSections.get(id) !== page.lectureSectionId) return false;
      sourceSections.set(id, page.lectureSectionId);
      sourceTypes.set(id, page.type);
    }
  }
  const versions = new Map<string, string>();
  for (const page of actual) {
    const ids = getOutlineSourcePageIds(page);
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !id.trim()
      || sourceSections.get(id) !== page.lectureSectionId
      || sourceTypes.get(id) !== page.type)) return false;
    if (page.sectionPlanVersion !== undefined) {
      if (!page.sectionPlanVersion.trim() || !page.lectureSectionId) return false;
      const version = versions.get(page.lectureSectionId);
      if (version && version !== page.sectionPlanVersion) return false;
      versions.set(page.lectureSectionId, page.sectionPlanVersion);
    } else if (ids.length > 1) return false;
  }
  // Unversioned assessment pages can coexist with a revised teaching plan.
  const group = (page: GenerationPlanIdentity) => page.type !== 'quiz'
    && page.lectureSectionId && versions.has(page.lectureSectionId)
    ? `section:${page.lectureSectionId}` : `page:${getOutlineSourcePageIds(page)[0]}`;
  const totals = (pages: readonly GenerationPlanIdentity[]) => {
    const result = new Map<string, number[]>();
    for (const page of pages) {
      const key = group(page);
      const previous = result.get(key) ?? [0, 0, 0, 0];
      const timing = page.plannedTiming;
      result.set(key, [
        previous[0]! + (page.targetDurationSec ?? page.estimatedDuration ?? 0),
        previous[1]! + (timing?.narrationSec ?? 0),
        previous[2]! + (timing?.learnerActivitySec ?? 0),
        previous[3]! + (timing?.transitionSec ?? 0),
      ]);
    }
    return result;
  };
  const expectedTotals = totals(expected);
  const actualTotals = totals(actual);
  return expectedTotals.size === actualTotals.size && [...expectedTotals].every(([key, values]) => {
    const other = actualTotals.get(key);
    return other && values.every((value, index) => Math.abs(value - other[index]!) <= 0.001);
  });
}

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
export function resolveFullCoursePromotionOutlines<T extends GenerationPlanIdentity>(input: {
  persistedOutlines: readonly T[] | undefined;
  acceptedTestOutlines?: readonly T[];
  expectedFullSceneCount: number | undefined;
  testLesson: TestLessonGenerationTarget | undefined;
}): T[] | null {
  const outlines = input.persistedOutlines ?? [];
  const testIds = input.testLesson?.sceneOutlineIds ?? [];
  const fullIds = new Set(outlines.flatMap((outline) => [...getOutlineSourcePageIds(outline)]));
  if (!Number.isInteger(input.expectedFullSceneCount)
    || (input.expectedFullSceneCount ?? 0) <= testIds.length
    || fullIds.size !== input.expectedFullSceneCount
    || new Set(outlines.map((outline) => outline.id)).size !== outlines.length
    || testIds.length === 0) return null;
  if (new Set(testIds).size !== testIds.length || testIds.some((id) => !fullIds.has(id))) return null;
  const selectedIds = new Set(testIds);
  const overlapsSelection = (page: T) => getOutlineSourcePageIds(page).some((id) => selectedIds.has(id));
  if (outlines.some((page) => overlapsSelection(page) && !isOutlineWithinSourceSelection(page, selectedIds))) return null;
  if (!input.acceptedTestOutlines?.length) return [...outlines];
  const accepted = input.acceptedTestOutlines;
  if (!accepted.every((page) => isOutlineWithinSourceSelection(page, selectedIds))
    || !hasCompatibleOutlinePlan(outlines.filter(overlapsSelection), accepted)) return null;
  let emitted = false;
  const promoted = outlines.flatMap((outline) => {
    if (!overlapsSelection(outline)) return [outline];
    if (emitted) return [];
    emitted = true;
    return [...accepted];
  });
  return new Set(promoted.map((outline) => outline.id)).size === promoted.length ? promoted : null;
}

/**
 * Test mode is a bounded selection over the confirmed production outline. It
 * deliberately does not create alternate prompts, page schemas, or a second
 * generator. The selected lesson is passed to the same classroom pipeline as
 * a full course.
 */
export function selectClassroomGenerationOutlines<
  T extends GenerationPlanIdentity & {
    id: string;
    spatialParentId?: string;
    type?: OpenMaicSceneOutlineSnapshot["type"];
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
  selectedSectionId?: string,
): ClassroomGenerationSelection<T> {
  if (outlines.length && !hasCompatibleOutlinePlan(outlines, outlines)) {
    throw new Error("页面来源或小节规划版本不一致，不能确定安全的生成范围，请重新检查课程大纲。");
  }
  if (scope === "full-course") {
    return { scope, outlines: [...outlines], fullSceneCount: new Set(outlines.flatMap((outline) => [...getOutlineSourcePageIds(outline)])).size };
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
  const selected = selectedSectionId
    ? completeSections.find(([sectionId]) => sectionId === selectedSectionId)
    : completeSections
      .map((entry, index) => ({ entry, index, score: relevance(entry[1]) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.entry;
  if (!selected) {
    throw new Error(selectedSectionId
      ? "所选测试小节不在当前大纲中，或缺少讲授页面和节末检测，请重新选择。"
      : "测试模式需要正式大纲中至少有一个包含讲授页面和节末检测的完整知识小节，请先检查课程大纲。");
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
    fullSceneCount: new Set(outlines.flatMap((outline) => [...getOutlineSourcePageIds(outline)])).size,
    testLesson: {
      sectionId,
      sectionTitle: scenes[0]?.lectureSectionTitle?.trim() || scenes[0]?.title?.trim() || "第一知识小节",
      sceneOutlineIds: [...new Set(scenes.flatMap((scene) => [...getOutlineSourcePageIds(scene)]))],
      durationSeconds,
    },
  };
}
