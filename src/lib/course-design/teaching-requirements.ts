import { createHash } from "node:crypto";
import type { CourseTeachingRequirement, CourseTeachingRequirements } from "@/lib/session/types";
import type { CourseResourcePackage } from "@/lib/resource-package/types";
import { resourcePackageTeachingPoints } from "./resource-package-knowledge";

function normalized(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").trim().toLocaleLowerCase("zh-CN");
}

function stableId(kind: CourseTeachingRequirement["kind"], text: string): string {
  return `requirement-${kind}-${createHash("sha256").update(normalized(text)).digest("hex").slice(0, 12)}`;
}

/** Keep the most complete teacher submission when the UI sent the same brief twice. */
export function mergeTeacherRequirementBriefs(values: readonly (string | null | undefined)[]): string {
  const candidates = [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
  return candidates.filter((candidate, index) => {
    const candidateKey = normalized(candidate);
    return !candidates.some((other, otherIndex) => (
      otherIndex !== index
      && other.length >= candidate.length
      && normalized(other).includes(candidateKey)
    ));
  }).join("\n");
}

function relatedPointIds(text: string, resourcePackage?: CourseResourcePackage): string[] {
  const haystack = normalized(text);
  const points = resourcePackageTeachingPoints(resourcePackage);
  const matches = (value?: string) => {
    const needle = normalized(value ?? "");
    return needle.length >= 2 && haystack.includes(needle);
  };
  const directMatches = points.filter((point) => matches(point.name));
  if (directMatches.length) return directMatches.map((point) => point.id);
  return points.filter((point) => matches(point.groupName)).map((point) => point.id);
}

export function buildCourseTeachingRequirements(input: {
  resourcePackage?: CourseResourcePackage;
  teacherBrief?: string;
}): CourseTeachingRequirements {
  const draft = input.resourcePackage?.draft;
  const aiStage = draft?.stages.find((stage) => stage.key === "ai-learning");
  const teacherBrief = input.teacherBrief?.trim() ?? "";
  const records: Array<Pick<CourseTeachingRequirement, "kind" | "source" | "text">> = [
    ...(teacherBrief ? [{ kind: "teacher-directive" as const, source: "teacher" as const, text: teacherBrief }] : []),
    ...(draft?.teachingHighlights ?? []).map((text) => ({ kind: "highlight" as const, source: "resource-package" as const, text })),
    ...(draft?.teachingDifficulties ?? []).map((text) => ({ kind: "difficulty" as const, source: "resource-package" as const, text })),
    ...[aiStage?.aiActions, aiStage?.requirements]
      .map((text) => text?.trim() ?? "")
      .filter(Boolean)
      .map((text) => ({ kind: "stage-requirement" as const, source: "resource-package" as const, text })),
  ];
  const items = [...new Map(records.map((item) => {
    const id = stableId(item.kind, item.text);
    return [id, {
      ...item,
      id,
      sourceKnowledgePointIds: relatedPointIds(item.text, input.resourcePackage),
    } satisfies CourseTeachingRequirement];
  })).values()];
  return {
    schemaVersion: 1,
    items,
    conflicts: (input.resourcePackage?.conflicts ?? []).map((conflict) => ({
      id: conflict.id,
      summary: conflict.summary,
      detail: [conflict.reason, conflict.suggestion].filter(Boolean).join("；"),
      source: "resource-package" as const,
    })),
  };
}

export function formatCourseTeachingRequirements(requirements?: CourseTeachingRequirements): string {
  if (!requirements?.items.length && !requirements?.conflicts.length) return "";
  return [
    "统一教学要求（教师补充、资源包重点难点和知识讲授阶段要求共同遵守；不得静默忽略）：",
    JSON.stringify(requirements),
  ].join("\n");
}
