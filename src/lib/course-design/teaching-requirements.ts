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

function teacherDirectiveApplicability(text: string): NonNullable<CourseTeachingRequirement["appliesTo"]> {
  const otherStage = /(?:项目实践|动手制作|成果展示|成果汇报|展示环节|反思评价|课后任务|第三阶段|第四阶段|第五阶段)/u.test(text);
  const knowledgeTeaching = /(?:知识讲授|解释|讲解|定义|概念|原理|案例|例子|类比|课件|PPT|讲稿|小测)/iu.test(text);
  return otherStage && !knowledgeTeaching ? "other-stage" : "ai-learning";
}

function teacherPackageConflicts(teacherBrief: string, resourcePackage?: CourseResourcePackage): CourseTeachingRequirements["conflicts"] {
  const draft = resourcePackage?.draft;
  if (!teacherBrief || !draft) return [];
  const conflicts: CourseTeachingRequirements["conflicts"] = [];
  const requestedMinutes = teacherBrief.match(/(?:整课|课程|总时长)[^\d]{0,8}(\d{1,4})\s*分钟/u)?.[1];
  if (requestedMinutes && draft.totalMinutes && Number(requestedMinutes) !== draft.totalMinutes) conflicts.push({
    id: "teacher-total-minutes",
    summary: "教师补充的整课时长与已确认资源包不同",
    detail: `教师补充：${requestedMinutes} 分钟；资源包：${draft.totalMinutes} 分钟。请在现有设计确认流程中选择采用哪一项。`,
    source: "teacher",
  });
  const requestedAudience = teacherBrief.match(/(?:面向|适合|授课对象(?:为)?)[：:\s]*([^，。；;\n]{2,24})/u)?.[1]?.trim();
  if (requestedAudience && draft.grade && !normalized(requestedAudience).includes(normalized(draft.grade))
    && !normalized(draft.grade).includes(normalized(requestedAudience))) conflicts.push({
    id: "teacher-audience",
    summary: "教师补充的授课对象与已确认资源包不同",
    detail: `教师补充：${requestedAudience}；资源包：${draft.grade}。请先确认实际授课对象。`,
    source: "teacher",
  });
  if (/(?:真人|学生)\s*(?:小组|分组)|(?:两|三|四|五|六|\d+)人小组/u.test(teacherBrief)) conflicts.push({
    id: "teacher-organization",
    summary: "教师补充要求真人分组，与当前个人 AI 伙伴课程组织冲突",
    detail: "当前系统按每位学生与 AI 伙伴完成个人项目生成，请在设计确认流程中调整组织方式或删除该补充。",
    source: "teacher",
  });
  return conflicts;
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
  const teacherDirectives = teacherBrief.split(/\r?\n/u).map((text) => text.trim()).filter(Boolean);
  const records: Array<Pick<CourseTeachingRequirement, "kind" | "source" | "text" | "sourceEvidence" | "appliesTo">> = [
    ...teacherDirectives.map((text) => ({ kind: "teacher-directive" as const, source: "teacher" as const, text, appliesTo: teacherDirectiveApplicability(text) })),
    ...(draft?.teachingHighlights ?? []).map((text) => ({ kind: "highlight" as const, source: "resource-package" as const, text, appliesTo: "ai-learning" as const, sourceEvidence: draft?.sourceEvidence?.teachingHighlights })),
    ...(draft?.teachingDifficulties ?? []).map((text) => ({ kind: "difficulty" as const, source: "resource-package" as const, text, appliesTo: "ai-learning" as const, sourceEvidence: draft?.sourceEvidence?.teachingDifficulties })),
    ...[aiStage?.aiActions, aiStage?.requirements]
      .map((text) => text?.trim() ?? "")
      .filter(Boolean)
      .map((text) => ({ kind: "stage-requirement" as const, source: "resource-package" as const, text, appliesTo: "ai-learning" as const })),
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
    conflicts: [
      ...(input.resourcePackage?.conflicts ?? []).map((conflict) => ({
        id: conflict.id,
        summary: conflict.summary,
        detail: [conflict.reason, conflict.suggestion].filter(Boolean).join("；"),
        source: "resource-package" as const,
      })),
      ...teacherPackageConflicts(teacherBrief, input.resourcePackage),
    ],
  };
}

export function formatCourseTeachingRequirements(requirements?: CourseTeachingRequirements): string {
  if (!requirements?.items.length && !requirements?.conflicts.length) return "";
  return [
    "统一教学要求（教师补充、资源包重点难点和知识讲授阶段要求共同遵守；不得静默忽略）：",
    JSON.stringify(requirements),
  ].join("\n");
}
