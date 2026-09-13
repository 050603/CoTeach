import { describe, expect, it } from "vitest";
import type { Course, CourseReflectionResponse, ReflectionRecord } from "@/lib/session/types";
import { latestCourseReflection, mergeReflectionForCourse, validateReflectionForCourse } from "./course-reflection";
import { latestReflectionSurveyEntries, reflectionSummaryCoverage } from "./reflection-summary";
import { buildReflectionPresentation } from "./classroom/reflection-presentation";
import { deriveReflectionDashboardMetrics } from "./classroom/teacher-dashboard-metrics";

const set = { id: "set-1", version: 2, questions: [{ id: "why", prompt: "哪次修改体现了你的判断？", required: true }, { id: "how", prompt: "理论如何指导设计？", required: true }] };
const response: CourseReflectionResponse = { schemaVersion: 1, questionSetId: set.id, questionSetVersion: set.version, questions: set.questions, answers: { why: "发现AI误用理论后重新核对。", how: "按认知负荷安排任务。" }, submittedAt: "2026-09-12T10:00:00Z" };
function fixture(): Course {
  return { id: "course", students: [{ id: "student", name: "学生" }], content: { stagePlan: { reflectionQuestionSet: set } }, reflections: [] } as unknown as Course;
}
function record(extra: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return { id: "reflection", courseId: "course", studentId: "student", studentName: "学生", content: "", createdAt: response.submittedAt, updatedAt: response.submittedAt, courseReflection: response, ...extra };
}
describe("resource package course reflection", () => {
  it("checks required questions and rejects a forged or stale confirmed question set", () => {
    const course = fixture();
    expect(() => validateReflectionForCourse(course, record())).not.toThrow();
    expect(() => validateReflectionForCourse(course, record({ courseReflection: { ...response, answers: { why: "只有一题" } } }))).toThrow();
    expect(() => validateReflectionForCourse(course, record({ courseReflection: { ...response, questionSetVersion: 1 } }))).toThrow();
    expect(() => validateReflectionForCourse(course, record({ courseReflection: { ...response, questions: [{ ...set.questions[0], prompt: "自行改题" }, set.questions[1]] } }))).toThrow();
  });
  it("counts course answers without requiring experience scores, preserves old versions separately", () => {
    const course = fixture();
    course.reflections = [record(), record({ id: "older", courseReflection: { ...response, questionSetVersion: 1 }, updatedAt: "2026-09-12T11:00:00Z" })];
    expect(latestCourseReflection(course, "student")?.id).toBe("reflection");
    expect(reflectionSummaryCoverage(course).responseCount).toBe(1);
    expect(latestReflectionSurveyEntries(course)[0].survey.learningReflection).toContain("理论如何指导设计？");
    expect(latestReflectionSurveyEntries(course)[0].survey.aiHelpfulness).toBeUndefined();
    const projection = buildReflectionPresentation(course);
    expect(projection.map((question) => question.title)).toEqual(set.questions.map((question) => question.prompt));
    expect(projection[1].answers[0].value).toBe(response.answers.how);
  });
  it("does not mark a standalone experience survey as a completed course reflection", () => {
    const course = fixture();
    course.reflections = [record({ courseReflection: undefined, experienceSurvey: { schemaVersion: 1, systemReflection: "操作清楚", aiHelpfulness: 4, systemUsability: 5, reuseIntention: 4, submittedAt: response.submittedAt } })];
    expect(reflectionSummaryCoverage(course).responseCount).toBe(0);
    expect(buildReflectionPresentation(course)[0].responseCount).toBe(0);
    const metrics = deriveReflectionDashboardMetrics(course);
    expect(metrics.submittedCount).toBe(0);
    expect(metrics.pendingStudents.map((student) => student.id)).toEqual(["student"]);
    expect(metrics.averages).toMatchObject({ aiHelpfulness: 4, systemUsability: 5, reuseIntention: 4 });
  });
  it("preserves independently saved answers and rejects overwriting a historical question version", () => {
    const course = fixture();
    const experience = { schemaVersion: 1 as const, systemReflection: "操作清楚", aiHelpfulness: 4 as const, systemUsability: 5 as const, reuseIntention: 4 as const, submittedAt: response.submittedAt };
    course.reflections = [record()];
    const merged = mergeReflectionForCourse(course, record({ courseReflection: undefined, experienceSurvey: experience }));
    expect(merged.courseReflection).toEqual(response);
    course.reflections = [merged];
    expect(mergeReflectionForCourse(course, record()).experienceSurvey).toEqual(experience);
    const updated = { ...response, answers: { ...response.answers, why: "新的核验决策" }, submittedAt: "2026-09-12T11:00:00Z" };
    course.reflections = [record({ courseReflection: updated })];
    expect(mergeReflectionForCourse(course, record({ experienceSurvey: experience })).courseReflection).toEqual(updated);
    course.reflections = [record({ courseReflection: { ...response, questionSetVersion: 1 } })];
    expect(() => mergeReflectionForCourse(course, record())).toThrow("旧题集的回答须保留");
  });
});
