import { describe, expect, it } from "vitest";
import { estimateSurveyMinutes, SurveyConfigSchema } from "./survey";
import { buildSurveyAnalytics } from "./survey-analytics";

const config = {
  schemaVersion: 1,
  content: "课后反馈",
  questions: [
    { id: "choice", title: "今天的节奏如何？", type: "single-choice", required: true, options: [{ id: "fast", label: "偏快" }, { id: "good", label: "合适" }, { id: "slow", label: "偏慢" }] },
    { id: "text", title: "印象最深的内容？", type: "short-text", required: false, options: [] },
  ],
};

describe("survey configuration and analytics", () => {
  it("estimates student completion time by question type and reading load", () => {
    const choiceQuestions = Array.from({ length: 3 }, (_, index) => ({
      id: `choice-${index}`,
      title: "请选择最符合实际情况的一项",
      type: "single-choice" as const,
      chartType: "donut" as const,
      required: true,
      options: [{ id: "yes", label: "符合" }, { id: "no", label: "不符合" }],
    }));
    const textQuestions = choiceQuestions.map((question) => ({ ...question, type: "short-text" as const, options: [] }));

    expect(estimateSurveyMinutes([])).toBe(1);
    expect(estimateSurveyMinutes(choiceQuestions)).toBeLessThan(estimateSurveyMinutes(textQuestions));
    expect(estimateSurveyMinutes(choiceQuestions, "请结合本节课的实际体验认真阅读并完成以下问题。".repeat(20)))
      .toBeGreaterThan(estimateSurveyMinutes(choiceQuestions));
  });

  it("accepts mixed question types and rejects incomplete choices", () => {
    expect(SurveyConfigSchema.parse(config).questions).toHaveLength(2);
    expect(SurveyConfigSchema.safeParse({ ...config, questions: [{ id: "q", title: "选择", type: "single-choice", options: [{ id: "a", label: "A" }] }] }).success).toBe(false);
    expect(SurveyConfigSchema.safeParse({ ...config, questions: [{ id: "q", title: "多选", type: "multiple-choice", chartType: "bar", maxSelections: 3, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }).success).toBe(false);
  });

  it("uses the latest progress projection to calculate ratios and text terms", () => {
    const result = buildSurveyAnalytics(config, [
      { respondent: { studentId: "student-1", displayName: "林晓" }, progressData: { answers: { choice: "good", text: "小组合作很有启发，合作讨论很有趣" } } },
      { respondent: { studentId: "student-2", displayName: "陈舟" }, progressData: { answers: { choice: "good", text: "合作讨论帮助我理解设计思维" } } },
      { respondent: { studentId: "student-3", displayName: "周宁" }, progressData: { answers: { choice: "fast", text: "设计思维很有启发" } } },
    ], 4);
    expect(result).toMatchObject({ submittedCount: 3, totalStudents: 4, completionRate: 75 });
    expect(result.questions[0]).toMatchObject({ responseCount: 3, options: [{ count: 1 }, { count: 2 }, { count: 0 }] });
    expect(result.questions[1]).toMatchObject({ responseCount: 3 });
    expect(result.questions[1]).toMatchObject({ terms: [], keywordStatus: "processing" });
    expect(result.questions[0].type === "single-choice" && result.questions[0].options[1].respondents).toEqual([
      { studentId: "student-1", displayName: "林晓" },
      { studentId: "student-2", displayName: "陈舟" },
    ]);
    expect(result.questions[1].type === "short-text" && result.questions[1].responses[0]).toEqual({
      studentId: "student-1",
      displayName: "林晓",
      content: "小组合作很有启发，合作讨论很有趣",
    });
  });

  it("counts every selected option in a multi-choice response as a share of total selections", () => {
    const multiConfig = { schemaVersion: 2, content: "", questions: [{ id: "skills", title: "你练习了哪些能力？", type: "multiple-choice", chartType: "bar", required: true, options: [{ id: "research", label: "调研" }, { id: "teamwork", label: "协作" }, { id: "present", label: "表达" }] }] };
    const result = buildSurveyAnalytics(multiConfig, [
      { respondent: { studentId: "s1", displayName: "林晓" }, progressData: { answers: { skills: ["research", "teamwork"] } } },
      { respondent: { studentId: "s2", displayName: "陈舟" }, progressData: { answers: { skills: ["teamwork", "present"] } } },
    ], 2);
    const question = result.questions[0];
    expect(question).toMatchObject({ type: "multiple-choice", chartType: "bar", responseCount: 2, options: [{ count: 1, percentage: 25 }, { count: 2, percentage: 50 }, { count: 1, percentage: 25 }] });
    expect(question.type !== "short-text" && question.options[1].respondents.map((student) => student.displayName)).toEqual(["林晓", "陈舟"]);
    expect(SurveyConfigSchema.safeParse({ ...multiConfig, questions: [{ ...multiConfig.questions[0], chartType: "donut" }] }).success).toBe(false);
  });

  it("keeps supplemental option text attached to the named respondent", () => {
    const otherConfig = { schemaVersion: 2, content: "", questions: [{ id: "pace", title: "课堂节奏如何？", type: "single-choice", chartType: "bar", required: true, options: [{ id: "good", label: "合适" }, { id: "other", label: "其他", allowTextInput: true }] }] };
    const result = buildSurveyAnalytics(otherConfig, [
      { respondent: { studentId: "s1", displayName: "林晓" }, progressData: { answers: { pace: { selected: "other", optionText: { other: "讨论环节偏快" } } } } },
      { respondent: { studentId: "s2", displayName: "陈舟" }, progressData: { answers: { pace: "good" } } },
    ], 2);
    const question = result.questions[0];

    expect(question.type !== "short-text" && question.options[1].respondents).toEqual([
      { studentId: "s1", displayName: "林晓", detail: "讨论环节偏快" },
    ]);
  });

  it.each(["single-choice", "multiple-choice"])("apportions rounded %s percentages to exactly 100 percent", (type) => {
    const survey = { questions: [{ id: "q", title: "选择", type, chartType: "column", options: ["a", "b", "c", "d"].map((id) => ({ id, label: id })) }] };
    const rows = ["a", "b", "c"].map((selected, index) => ({
      respondent: { studentId: `s${index}`, displayName: `学生${index}` },
      progressData: { submission: { answers: { q: { selected: [selected, selected, "removed"] } } } },
    }));
    rows.push({ respondent: { studentId: "empty", displayName: "未答" }, progressData: { submission: { answers: { q: { selected: ["removed"] } } } } });
    const question = buildSurveyAnalytics(survey, rows, rows.length).questions[0];
    expect(question).toMatchObject({ responseCount: 3, options: [
      { count: 1, percentage: 33.4 }, { count: 1, percentage: 33.3 },
      { count: 1, percentage: 33.3 }, { count: 0, percentage: 0 },
    ] });
    const empty = buildSurveyAnalytics(survey, [], 4).questions[0];
    expect(empty).toMatchObject({ responseCount: 0, options: Array.from({ length: 4 }, () => ({ count: 0, percentage: 0 })) });
  });
});
