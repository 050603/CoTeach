import type { Course } from "@/lib/session/types";
import {
  DEFAULT_PBL_EVIDENCE_REQUIREMENTS,
  DEFAULT_PBL_OUTCOME,
  normalizePblCourseConfig,
} from "@/lib/pbl-course-config";

export const DEFAULT_NEW_COURSE_SUBJECT = "人工智能通识课程";
export const DEFAULT_NEW_COURSE_HOURS = 2;

export type CourseBasicsDraft = {
  name: string;
  subject: string;
  grade: string;
  hours: number;
  /** Resource-package minutes stay authoritative when editing unrelated basics. */
  resourcePackageTotalMinutes?: number;
  learningObjectivesText: string;
  summary: string;
  priorKnowledge: string;
  learningNeeds: string;
  familiarContexts: string;
  drivingQuestions: string[];
  outcomeArtifact: string;
  outcomePresentation: string;
  outcomeReflection: string;
};

export type CourseBasicsSuggestionPart =
  | "learningObjectives"
  | "summary"
  | "learnerProfile"
  | "drivingQuestions";

export function getEmptyCourseBasicsSuggestionParts(
  draft: CourseBasicsDraft,
): CourseBasicsSuggestionPart[] {
  const parts: CourseBasicsSuggestionPart[] = [];
  if (!draft.learningObjectivesText.trim()) parts.push("learningObjectives");
  if (!draft.summary.trim()) parts.push("summary");
  if (!draft.drivingQuestions.some((question) => question.trim())) parts.push("drivingQuestions");
  return parts;
}

export function createCourseBasicsDraft(course: Course): CourseBasicsDraft {
  return {
    name: course.name,
    subject: course.subject,
    grade: course.grade,
    hours: course.content.stagePlan ? course.content.stagePlan.totalMinutes / 60 : course.hours,
    ...(course.content.stagePlan ? { resourcePackageTotalMinutes: course.content.stagePlan.totalMinutes } : {}),
    learningObjectivesText: (course.learningObjectives ?? []).join("\n"),
    summary: course.summary,
    priorKnowledge: course.learnerProfile?.priorKnowledge ?? "",
    learningNeeds: course.learnerProfile?.learningNeeds ?? "",
    familiarContexts: course.learnerProfile?.familiarContexts ?? "",
    drivingQuestions: [course.drivingQuestion || course.pblConfig?.inquiryQuestions?.[0] || ""],
    outcomeArtifact: course.pblConfig?.outcome.artifact ?? DEFAULT_PBL_OUTCOME.artifact,
    outcomePresentation:
      course.pblConfig?.outcome.presentation ?? DEFAULT_PBL_OUTCOME.presentation,
    outcomeReflection:
      course.pblConfig?.outcome.reflection ?? DEFAULT_PBL_OUTCOME.reflection,
  };
}

export function parseLearningObjectives(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildCourseBasicsPatch(course: Course, draft: CourseBasicsDraft) {
  const drivingQuestions = Array.from(
    new Set(draft.drivingQuestions.map((question) => question.trim()).filter(Boolean)),
  );
  return {
    name: draft.name.trim(),
    subject: draft.subject.trim(),
    grade: draft.grade.trim(),
    hours: course.content.stagePlan
      ? course.content.stagePlan.totalMinutes / 60
      : Math.min(5, Math.max(1, Math.round(draft.hours) || 1)),
    learningObjectives: parseLearningObjectives(draft.learningObjectivesText),
    summary: draft.summary.trim(),
    learnerProfile: {
      priorKnowledge: draft.priorKnowledge.trim(),
      learningNeeds: draft.learningNeeds.trim(),
      familiarContexts: draft.familiarContexts.trim(),
    },
    drivingQuestion: drivingQuestions[0] ?? "",
    pblConfig: normalizePblCourseConfig({
      ...course.pblConfig,
      inquiryQuestions: drivingQuestions.slice(0, 1),
      evidenceRequirements:
        course.pblConfig?.evidenceRequirements ??
        DEFAULT_PBL_EVIDENCE_REQUIREMENTS.filter((item) => item.required),
      outcome: {
        artifact: draft.outcomeArtifact,
        presentation: draft.outcomePresentation,
        reflection: draft.outcomeReflection,
      },
    }),
  } satisfies Partial<Course>;
}

export function validateCourseBasicsDraft(draft: CourseBasicsDraft): string | null {
  if (!draft.name.trim()) return "请填写课程名称";
  if (!draft.subject.trim()) return "请填写学科";
  if (!draft.grade.trim()) return "请填写年级";
  if (draft.resourcePackageTotalMinutes !== undefined) {
    if (!Number.isInteger(draft.resourcePackageTotalMinutes) || draft.resourcePackageTotalMinutes <= 0) return "请在资源包教案中确认有效的总分钟数";
  } else {
    if (!Number.isFinite(draft.hours) || draft.hours < 1) return "预计课时不能少于 1";
    if (draft.hours > 5) return "人工智能通识课程预计课时请设置为 1–5 课时";
  }
  if (!draft.drivingQuestions.some((question) => question.trim())) {
    return "请至少设置一个项目启发问题";
  }
  return null;
}
