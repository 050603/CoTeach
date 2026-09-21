import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { TeachingBrief } from "@/lib/course-quality-review/types";

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];

export function normalizeTeachingBrief(outline: SceneOutline): TeachingBrief {
  const raw = outline.teachingBrief;
  return {
    schemaVersion: 1,
    ...(raw?.designVersion ? { designVersion: raw.designVersion } : {}),
    ...(raw?.sharedContext ? { sharedContext: raw.sharedContext } : {}),
    ...(raw?.pageTask ? { pageTask: raw.pageTask } : {}),
    ...(raw?.teachingPlan ? { teachingPlan: raw.teachingPlan } : {}),
    explanation: typeof raw?.explanation === "string" && raw.explanation.trim() ? raw.explanation : outline.description,
    examples: strings(raw?.examples),
    conditions: strings(raw?.conditions),
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.filter((item) => item && typeof item.sourceId === "string" && typeof item.quote === "string" && item.quote.trim()) : [],
    assessmentFocus: typeof raw?.assessmentFocus === "string" ? raw.assessmentFocus : outline.teachingObjective ?? "",
    ...(raw?.understandingCriteria ? { understandingCriteria: raw.understandingCriteria } : {}),
    ...(raw?.resourceNeeds?.length ? { resourceNeeds: raw.resourceNeeds } : {}),
    ...(raw?.requirementIds?.length ? { requirementIds: strings(raw.requirementIds) } : {}),
    ...(raw?.difficultyStrategies?.length ? { difficultyStrategies: raw.difficultyStrategies } : {}),
    ...(raw?.reviewItems?.length ? { reviewItems: raw.reviewItems } : {}),
  };
}

export function formatTeachingBrief(outline: SceneOutline): string {
  return `本小节共享上下文与当前页面教学依据（课件、讲稿、互动和小测共同遵守；跨页保持案例原句、步骤名和术语一致；缺失证据保留未知，不编造）：\n${JSON.stringify(normalizeTeachingBrief(outline))}`;
}
