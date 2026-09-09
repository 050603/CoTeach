import { describe, expect, it } from "vitest";
import { buildSurveyAnalytics, extractSurveyTerms, SurveyConfigSchema } from "./survey";

const config = {
  schemaVersion: 1,
  content: "课后反馈",
  questions: [
    { id: "choice", title: "今天的节奏如何？", type: "single-choice", required: true, options: [{ id: "fast", label: "偏快" }, { id: "good", label: "合适" }, { id: "slow", label: "偏慢" }] },
    { id: "text", title: "印象最深的内容？", type: "short-text", required: false, options: [] },
  ],
};

describe("survey configuration and analytics", () => {
  it("accepts mixed question types and rejects incomplete choices", () => {
    expect(SurveyConfigSchema.parse(config).questions).toHaveLength(2);
    expect(SurveyConfigSchema.safeParse({ ...config, questions: [{ id: "q", title: "选择", type: "single-choice", options: [{ id: "a", label: "A" }] }] }).success).toBe(false);
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
    expect(result.questions[1].type === "short-text" && result.questions[1].terms.some((term) => term.label === "合作" && term.value === 2)).toBe(true);
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

  it("counts a term once per response so repeated words represent students, not repetition", () => {
    expect(extractSurveyTerms(["协作 协作 协作", "协作让项目更清晰"]).find((term) => term.label === "协作")?.value).toBe(2);
  });

  it("counts every selected option in a multi-choice response while keeping respondent-based percentages", () => {
    const multiConfig = { schemaVersion: 2, content: "", questions: [{ id: "skills", title: "你练习了哪些能力？", type: "multiple-choice", chartType: "bar", required: true, options: [{ id: "research", label: "调研" }, { id: "teamwork", label: "协作" }, { id: "present", label: "表达" }] }] };
    const result = buildSurveyAnalytics(multiConfig, [
      { respondent: { studentId: "s1", displayName: "林晓" }, progressData: { answers: { skills: ["research", "teamwork"] } } },
      { respondent: { studentId: "s2", displayName: "陈舟" }, progressData: { answers: { skills: ["teamwork", "present"] } } },
    ], 2);
    const question = result.questions[0];
    expect(question).toMatchObject({ type: "multiple-choice", chartType: "bar", responseCount: 2, options: [{ count: 1, percentage: 50 }, { count: 2, percentage: 100 }, { count: 1, percentage: 50 }] });
    expect(question.type !== "short-text" && question.options[1].respondents.map((student) => student.displayName)).toEqual(["林晓", "陈舟"]);
    expect(SurveyConfigSchema.safeParse({ ...multiConfig, questions: [{ ...multiConfig.questions[0], chartType: "donut" }] }).success).toBe(false);
  });
});
