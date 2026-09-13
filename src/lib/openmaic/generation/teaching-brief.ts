import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { TeachingBrief } from "@/lib/course-quality-review/types";

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];

export function normalizeTeachingBrief(outline: SceneOutline): TeachingBrief {
  const raw = outline.teachingBrief;
  return {
    schemaVersion: 1,
    explanation: typeof raw?.explanation === "string" && raw.explanation.trim() ? raw.explanation : outline.description,
    examples: strings(raw?.examples),
    conditions: strings(raw?.conditions),
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.filter((item) => item && typeof item.sourceId === "string" && typeof item.quote === "string" && item.quote.trim()) : [],
    assessmentFocus: typeof raw?.assessmentFocus === "string" ? raw.assessmentFocus : outline.teachingObjective ?? "",
  };
}

export function formatTeachingBrief(outline: SceneOutline): string {
  return `同一页面的教学依据（讲授、互动、讲稿和小测共同遵守；缺失证据保留未知，不编造）：\n${JSON.stringify(normalizeTeachingBrief(outline))}`;
}
