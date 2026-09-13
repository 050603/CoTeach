import type { Course, CourseReflectionResponse, ExperienceSurveyResponse, ReflectionRecord } from "@/lib/session/types";
import { isReflectionSurveyScore, normalizeReflectionSurvey } from "@/lib/reflection-survey";

export const COURSE_REFLECTION_MAX_LENGTH = 4000;
export class CourseReflectionValidationError extends Error {}

export function courseQuestionSet(course: Pick<Course, "content">) {
  return course.content?.stagePlan?.reflectionQuestionSet;
}

export function validCourseReflection(value: CourseReflectionResponse | undefined): value is CourseReflectionResponse {
  return Boolean(value && value.schemaVersion === 1 && value.questionSetId && Number.isInteger(value.questionSetVersion)
    && Array.isArray(value.questions) && value.answers && typeof value.answers === "object" && value.questions.length && new Set(value.questions.map((q) => q?.id)).size === value.questions.length
    && value.questions.every((q) => q && typeof q.id === "string" && typeof q.prompt === "string" && q.id && q.prompt && (value.answers[q.id] === undefined || typeof value.answers[q.id] === "string") && (!q.required || value.answers[q.id]?.trim()) && (value.answers[q.id]?.length ?? 0) <= COURSE_REFLECTION_MAX_LENGTH)
    && Number.isFinite(Date.parse(value.submittedAt)));
}

export function latestCourseReflection(course: Course, studentId: string): ReflectionRecord | undefined {
  const set = courseQuestionSet(course);
  return [...(course.reflections ?? [])].filter((record) => record.studentId === studentId && validCourseReflection(record.courseReflection)
    && (!set || record.courseReflection.questionSetId === set.id && record.courseReflection.questionSetVersion === set.version))
    .sort((a, b) => Date.parse(b.courseReflection!.submittedAt) - Date.parse(a.courseReflection!.submittedAt))[0];
}

export function courseReflectionText(response: CourseReflectionResponse): string {
  return response.questions.map((question, index) => `${index + 1}. ${question.prompt}\n${response.answers[question.id] ?? ""}`).join("\n\n");
}

export function validExperienceSurvey(value: ExperienceSurveyResponse | undefined): value is ExperienceSurveyResponse {
  return Boolean(value?.schemaVersion === 1 && typeof value.systemReflection === "string" && value.systemReflection.trim() && value.systemReflection.length <= COURSE_REFLECTION_MAX_LENGTH
    && isReflectionSurveyScore(value.aiHelpfulness) && isReflectionSurveyScore(value.systemUsability) && isReflectionSurveyScore(value.reuseIntention) && Number.isFinite(Date.parse(value.submittedAt)));
}

export function latestExperienceSurvey(course: Course, studentId: string) {
  const records = [...(course.reflections ?? [])].filter((record) => record.studentId === studentId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const record of records) {
    if (validExperienceSurvey(record.experienceSurvey)) return record.experienceSurvey;
    const old = normalizeReflectionSurvey(record.survey);
    if (old) return { ...old, submittedAt: record.updatedAt };
  }
  return undefined;
}

export function validateReflectionForCourse(course: Course, record: ReflectionRecord): void {
  if (record.experienceSurvey && !validExperienceSurvey(record.experienceSurvey)) throw new CourseReflectionValidationError("请完整填写系统体验问卷。");
  if (!record.courseReflection) return;
  const previous = course.reflections?.find((item) => item.id === record.id)?.courseReflection;
  if (previous && (previous.questionSetId !== record.courseReflection.questionSetId || previous.questionSetVersion !== record.courseReflection.questionSetVersion)) throw new CourseReflectionValidationError("旧题集的回答须保留，请为当前题集建立新的反思记录。");
  const set = courseQuestionSet(course);
  if (!set || !validCourseReflection(record.courseReflection)
    || record.courseReflection.questionSetId !== set.id || record.courseReflection.questionSetVersion !== set.version
    || record.courseReflection.questions.length !== set.questions.length || set.questions.some((q, index) => { const actual = record.courseReflection!.questions[index]; return actual?.id !== q.id || actual.prompt !== q.prompt || actual.required !== q.required; })
    || Object.keys(record.courseReflection.answers).some((id) => !set.questions.some((q) => q.id === id))) throw new CourseReflectionValidationError("课程反思题集已变化或回答不完整，请按当前题目重新提交。");
}

/** Each independent form can update its own response without erasing the other form. */
export function mergeReflectionForCourse(course: Course, record: ReflectionRecord): ReflectionRecord {
  validateReflectionForCourse(course, record);
  const previous = course.reflections?.find((item) => item.id === record.id && item.studentId === record.studentId);
  if (!previous || !(record.courseReflection || record.experienceSurvey)) return record;
  const newest = <T extends { submittedAt: string }>(incoming: T | undefined, saved: T | undefined) => !incoming ? saved : saved && Date.parse(saved.submittedAt) > Date.parse(incoming.submittedAt) ? saved : incoming;
  const courseReflection = newest(record.courseReflection, previous.courseReflection);
  return { ...record, courseReflection, experienceSurvey: newest(record.experienceSurvey, previous.experienceSurvey),
    content: courseReflection ? courseReflectionText(courseReflection) : record.content, createdAt: previous.createdAt };
}
