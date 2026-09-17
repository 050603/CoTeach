import type { Course, CourseContent, CourseResource } from "@/lib/session/types";
import { DEFAULT_EVALUATION_FLOWS } from "@/lib/session/types";
import { getStagesForSystemMode } from "@/lib/system-mode";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";

const designFields = ["name", "subject", "grade", "hours", "summary", "drivingQuestion", "learningObjectives", "expectedOutcome", "learnerProfile", "stages", "pblConfig", "stageWorkspacePolicies", "coverImageUrl", "aiLearningClassroomId", "teacherClassroomId"] as const;
const resourceFields = ["id", "title", "type", "size", "description", "stageKey", "url", "previewUrl", "previewType", "displayMode"] as const;
const contentFields = ["resourcePackage", "stagePlan", "qualityReviewRequired", "qualityReview", "renderReview", "teacherReview", "pblOutline", "teacherRequiredKnowledgePoints", "knowledgePoints", "knowledgeGroups", "knowledgeGraph", "teachingBlueprint", "teachingTimingAudit", "projectMainline", "teachingOutline", "lessonOutline", "knowledgeLectureSections", "evaluationPlan", "_openmaicClassroomId", "_openmaicScenesCount", "_openmaicSceneOutlines", "moduleTimingPlan", "teacherResources", "teacherClassroomId", "adaptiveLearningPlan", "designGenerationTrace"] as const;
export type PblTemplateDesign = Pick<Course, typeof designFields[number]> & { content: Omit<CourseContent, "courseSummaryPresentation">; resources?: Omit<CourseResource, "downloadedBy">[] };
export type PblTemplateSnapshot = { schemaVersion: 2; kind: "pbl-course"; design: PblTemplateDesign };
function pick<T, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as Pick<T, K>;
}
/** Explicit authoring whitelist: never persist students or classroom evidence in templates. */
export function encodePblTemplate(course: Course): PblTemplateSnapshot {
  return { schemaVersion: 2, kind: "pbl-course", design: { ...pick(course, designFields), content: pick(course.content, contentFields), resources: (course.resources ?? []).map((resource) => pick(resource, resourceFields)) } };
}
export function decodePblTemplate(snapshot: unknown): PblTemplateDesign | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Partial<PblTemplateSnapshot>;
  if (value.schemaVersion !== 2 || value.kind !== "pbl-course" || !value.design || typeof value.design !== "object") return null;
  const design = value.design;
  if (typeof design.name !== "string" || !design.content || typeof design.content !== "object" || !Array.isArray(design.stages)) return null;
  return { ...pick(design, designFields), content: pick(design.content, contentFields), resources: (design.resources ?? []).map((resource) => pick(resource, resourceFields)) };
}
export function createPblTemplateCourse(id: string, input: Partial<PblTemplateDesign> = {}, timestamps?: { createdAt: string; updatedAt: string }): Course {
  const now = new Date().toISOString();
  return {
    id, name: input.name ?? "未命名课程", subject: input.subject ?? "", grade: input.grade ?? "", hours: input.hours ?? 1,
    summary: input.summary ?? "", drivingQuestion: input.drivingQuestion ?? "", status: "draft", stages: input.stages ?? getStagesForSystemMode(),
    currentStageIndex: 0, students: [], resources: (input.resources ?? []).map((resource) => ({ ...resource, downloadedBy: [] })), pblConfig: normalizePblCourseConfig(input.pblConfig),
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "", flows: DEFAULT_EVALUATION_FLOWS.map((flow) => ({ ...flow, evidenceRequirements: [...flow.evidenceRequirements] })) }, ...input.content },
    ...pick(input, designFields), createdAt: timestamps?.createdAt ?? now, updatedAt: timestamps?.updatedAt ?? now,
  };
}
