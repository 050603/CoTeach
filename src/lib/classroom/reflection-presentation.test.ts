import { describe, expect, it } from "vitest";
import { REFLECTION_SURVEY_QUESTIONS, REFLECTION_SURVEY_SCALE } from "@/lib/reflection-survey";
import type { Course, ReflectionClassSummaryV1, ReflectionRecord, ReflectionSurveyResponseV1 } from "@/lib/session/types";
import { buildReflectionPresentation } from "./reflection-presentation";

const now = "2026-09-12T10:00:00.000Z";
function response(studentId: string, overrides: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return {
    id: `reflection-${studentId}`, courseId: "course", studentId, studentName: `历史姓名-${studentId}`,
    content: "旧版文本不用于统计", createdAt: now, updatedAt: now,
    survey: { schemaVersion: 1, learningReflection: `学习回答-${studentId}`, systemReflection: `系统回答-${studentId}`, aiHelpfulness: 4, systemUsability: 5, reuseIntention: 3 },
    ...overrides,
  };
}
function makeCourse(reflections: ReflectionRecord[] = [], ids = ["s1", "s2", "s3"]): Course {
  return { id: "course", content: {}, students: ids.map((id) => ({ id, name: `学生-${id}` })), reflections } as Course;
}
function makeSummary(reflections: ReflectionRecord[], overrides: Partial<ReflectionClassSummaryV1> = {}): ReflectionClassSummaryV1 {
  return {
    schemaVersion: 1, generatedAt: now, coveragePercent: 100, coverageBucket: 100, trigger: "manual",
    responseCount: reflections.length, totalStudentCount: reflections.length, sourceRevision: "revision",
    sourceRefs: reflections.map((record) => ({ reflectionId: record.id, studentId: record.studentId, updatedAt: record.updatedAt })),
    courseSummary: "班级总结", teachingRecommendations: [], categories: [], studentSummaries: [], ...overrides,
  };
}

describe("buildReflectionPresentation", () => {
  it("grounds custom course-question clouds in the exact current answer instead of the combined class summary", () => {
    const questions = [{ id: "gain", prompt: "你学到了什么？", required: true }, { id: "next", prompt: "下一步怎样改进？", required: true }];
    const record = response("s1", { courseReflection: { schemaVersion: 1, questionSetId: "custom", questionSetVersion: 1, questions, answers: { gain: "学会了证据比较，使用ＡＩ校验。", next: "通过小组讨论改进方案。" }, submittedAt: now } });
    const course = makeCourse([record], ["s1"]);
    course.content = { stagePlan: { reflectionQuestionSet: { id: "custom", version: 1, questions } } } as Course["content"];
    const summary = makeSummary([record], { categories: [{ key: "learning-gains", title: "收获", summary: "", terms: [
      { label: "证据比较", sources: [{ studentId: "s1", fields: ["learningReflection"] }] },
      { label: "ai", sources: [{ studentId: "s1", fields: ["learningReflection"] }] },
      { label: "小组讨论", sources: [{ studentId: "s1", fields: ["learningReflection"] }] },
      { label: "未经原文核对的总结", sources: [{ studentId: "s1", fields: ["learningReflection"] }] },
    ] }] });
    const result = buildReflectionPresentation(course, summary);
    expect(result).toHaveLength(2);
    if (result[0].type !== "text" || result[1].type !== "text") throw new Error("Expected text");
    expect(result[0].terms.map((term) => term.label).sort()).toEqual(["ai", "证据比较"]);
    expect(result[1].terms).toEqual([{ label: "小组讨论", count: 1, students: [{ id: "s1", name: "学生-s1" }] }]);
    record.updatedAt = "2026-09-12T11:00:00.000Z";
    const changed = buildReflectionPresentation(course, summary)[0];
    if (changed.type !== "text") throw new Error("Expected text");
    expect(changed.terms).toEqual([]);
    expect(changed.analysis).toMatchObject({ status: "waiting", pendingCount: 1 });
  });
  it("keeps the five original questions in order and calculates scales from valid current respondents", () => {
    const reflections = ([1, 2, 3] as const).map((score, index) => {
      const record = response(`s${index + 1}`);
      return { ...record, survey: { ...record.survey!, aiHelpfulness: score } };
    });
    const questions = buildReflectionPresentation(makeCourse(reflections, ["s1", "s2", "s3", "not-submitted"]));
    expect(questions.map((question) => question.key)).toEqual(["learningReflection", "systemReflection", "aiHelpfulness", "systemUsability", "reuseIntention"]);
    expect(questions.map((question) => question.title)).toEqual(Object.values(REFLECTION_SURVEY_QUESTIONS));
    expect(questions.map((question) => question.responseCount)).toEqual([3, 3, 3, 3, 3]);
    const question = questions[2];
    if (question.type !== "scale") throw new Error("Expected scale");
    expect(question.average).toBe(2);
    expect(question.options.map(({ value, label }) => ({ value, label }))).toEqual(REFLECTION_SURVEY_SCALE);
    expect(question.options.map((option) => option.count)).toEqual([1, 1, 1, 0, 0]);
    expect(question.options.map((option) => option.percent)).toEqual([34, 33, 33, 0, 0]);
    expect(question.options.reduce((sum, option) => sum + option.percent, 0)).toBe(100);
    expect(question.options[0].students).toEqual([{ id: "s1", name: "学生-s1" }]);
    expect(question.answers[0]).toMatchObject({ student: { id: "s1", name: "学生-s1" }, reflectionId: "reflection-s1", updatedAt: now, value: 1 });
  });

  it("ignores external students and courses, and never revives an old response after an invalid latest survey", () => {
    const old = response("s1");
    const newer = response("s1", { id: "s1-new", updatedAt: "2026-09-12T11:00:00.000Z", survey: undefined });
    const own = response("s2", { survey: { ...response("s2").survey!, learningReflection: "  当前回答  " } });
    const externalCourse = response("s2", { courseId: "other-course", updatedAt: "2026-09-12T12:00:00.000Z" });
    const partial = response("s3", { survey: { ...response("s3").survey!, reuseIntention: 99 } as unknown as ReflectionSurveyResponseV1 });
    const questions = buildReflectionPresentation(makeCourse([old, newer, own, externalCourse, partial, response("outsider")]));
    expect(questions.every((question) => question.responseCount === 1)).toBe(true);
    expect(questions[0].answers).toEqual([{ student: { id: "s2", name: "学生-s2" }, reflectionId: own.id, updatedAt: now, value: "当前回答" }]);
  });

  it("separates subjective fields, merges repeated themes and deduplicates students across categories", () => {
    const reflections = [response("s1"), response("s2"), response("outsider")];
    const summary = makeSummary(reflections, { categories: [
      { key: "learning-gains", title: "收获", summary: "", terms: [
        { label: "证据比较", sources: [{ studentId: "s1", fields: ["learningReflection"] }, { studentId: "outsider", fields: ["learningReflection"] }] },
        { label: "系统导航", sources: [{ studentId: "s1", fields: ["systemReflection"] }] },
      ] },
      { key: "common-difficulties", title: "困难", summary: "", terms: [
        { label: "证据比较", sources: [{ studentId: "s1", fields: ["learningReflection"] }, { studentId: "s2", fields: ["learningReflection", "systemReflection"] }] },
      ] },
    ] });
    const questions = buildReflectionPresentation(makeCourse(reflections, ["s1", "s2"]), summary);
    const [learning, system] = questions;
    if (learning.type !== "text" || system.type !== "text") throw new Error("Expected text questions");
    expect(learning.terms).toEqual([{ label: "证据比较", count: 2, students: [{ id: "s1", name: "学生-s1" }, { id: "s2", name: "学生-s2" }] }]);
    expect(system.terms.find((term) => term.label === "证据比较")).toEqual({ label: "证据比较", count: 1, students: [{ id: "s2", name: "学生-s2" }] });
    expect(system.terms.find((term) => term.label === "系统导航")?.count).toBe(1);
    expect(learning.analysis).toMatchObject({ status: "ready", analyzedCount: 2, pendingCount: 0 });
  });

  it("excludes obsolete summary sources by reflection id and revision while retaining current answers", () => {
    const oldS1 = response("s1");
    const s2 = response("s2");
    const oldS3 = response("s3");
    const currentS1 = { ...oldS1, updatedAt: "2026-09-12T11:00:00.000Z" };
    const currentS3 = { ...oldS3, id: "replacement-s3" };
    const summary = makeSummary([oldS1, s2, oldS3], { categories: [{ key: "learning-gains", title: "收获", summary: "", terms: [
      { label: "旧主题", sources: [{ studentId: "s1", fields: ["learningReflection"] }, { studentId: "s3", fields: ["learningReflection"] }] },
      { label: "仍有效的主题", sources: [{ studentId: "s2", fields: ["learningReflection"] }] },
    ] }] });
    const question = buildReflectionPresentation(makeCourse([currentS1, s2, currentS3]), summary)[0];
    if (question.type !== "text") throw new Error("Expected text");
    expect(question.answers).toHaveLength(3);
    expect(question.terms.map((term) => term.label)).toEqual(["仍有效的主题"]);
    expect(question.analysis).toMatchObject({ status: "partial", analyzedCount: 1, pendingCount: 2 });
    expect(question.analysis.message).toContain("2 份待更新");
  });

  it("does not fabricate themes for missing or unversioned analysis and retains zero scale options", () => {
    const record = response("s1");
    const withoutSummary = buildReflectionPresentation(makeCourse([record]));
    const learning = withoutSummary[0];
    if (learning.type !== "text") throw new Error("Expected text");
    expect(learning.terms).toEqual([]);
    expect(learning.analysis).toMatchObject({ status: "waiting", analyzedCount: 0, pendingCount: 1, message: "等待班级反思分析。" });
    const unversioned = buildReflectionPresentation(makeCourse([record]), makeSummary([record], { sourceRefs: undefined, categories: [{ key: "learning-gains", title: "收获", summary: "", terms: [{ label: "无版本来源", sources: [{ studentId: "s1", fields: ["learningReflection"] }] }] }] }))[0];
    if (unversioned.type !== "text") throw new Error("Expected text");
    expect(unversioned.terms).toEqual([]);
    expect(unversioned.analysis.pendingCount).toBe(1);
    const empty = buildReflectionPresentation(makeCourse());
    for (const question of empty) {
      expect(question.responseCount).toBe(0);
      expect(question.answers).toEqual([]);
      if (question.type === "scale") {
        expect(question.average).toBeNull();
        expect(question.options).toHaveLength(5);
        expect(question.options.every((option) => option.count === 0 && option.percent === 0 && !option.students.length)).toBe(true);
      } else expect(question.analysis.message).toBe("等待学生提交反思回答。");
    }
  });
});
