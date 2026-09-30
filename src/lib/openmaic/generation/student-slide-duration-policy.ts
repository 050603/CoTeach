import type { SceneOutline } from "@openmaic/lib/types/generation";

export const MAX_STUDENT_SLIDE_SECONDS = 6 * 60;

/**
 * A single student-facing PPT page cannot carry an entire long knowledge block.
 * Split only student knowledge slides; teacher resources describe activity time
 * and therefore intentionally remain one concise resource.
 */
export function splitLongStudentSlides(
  outlines: ReadonlyArray<SceneOutline>,
  maxSeconds = MAX_STUDENT_SLIDE_SECONDS,
): SceneOutline[] {
  return outlines.flatMap((outline) => {
    const duration = outline.targetDurationSec ?? outline.estimatedDuration ?? 0;
    const shouldSplit = outline.type === "slide"
      && outline.audience === "student"
      && outline.stageKey === "ai-learning"
      && duration > maxSeconds;
    if (!shouldSplit) return [{ ...outline }];

    const count = Math.ceil(duration / maxSeconds);
    const baseSeconds = Math.floor(duration / count);
    const remainder = duration - baseSeconds * count;
    const keyPoints = outline.keyPoints.length ? outline.keyPoints : [outline.title];
    return Array.from({ length: count }, (_, index) => {
      const start = Math.floor((index * keyPoints.length) / count);
      const end = Math.max(start + 1, Math.floor(((index + 1) * keyPoints.length) / count));
      const pagePoints = keyPoints.slice(start, Math.min(keyPoints.length, end));
      const pageSeconds = baseSeconds + (index < remainder ? 1 : 0);
      return {
        ...outline,
        id: `${outline.id}-part-${index + 1}`,
        title: outline.title,
        description: `${outline.description} 本页聚焦：${pagePoints.join("、")}。`,
        keyPoints: pagePoints,
        targetDurationSec: pageSeconds,
        estimatedDuration: pageSeconds,
        segmentIndex: index,
        segmentCount: count,
        segmentRole: index === 0 ? "引入" : index === count - 1 ? "归纳" : "深化",
        segmentGroupId: outline.segmentGroupId ?? outline.id,
      };
    });
  }).map((outline, index) => ({ ...outline, order: index }));
}
