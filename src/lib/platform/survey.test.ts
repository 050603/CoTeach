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
      { progressData: { answers: { choice: "good", text: "小组合作很有启发，合作讨论很有趣" } } },
      { progressData: { answers: { choice: "good", text: "合作讨论帮助我理解设计思维" } } },
      { progressData: { answers: { choice: "fast", text: "设计思维很有启发" } } },
    ], 4);
    expect(result).toMatchObject({ submittedCount: 3, totalStudents: 4, completionRate: 75 });
    expect(result.questions[0]).toMatchObject({ responseCount: 3, options: [{ count: 1 }, { count: 2 }, { count: 0 }] });
    expect(result.questions[1]).toMatchObject({ responseCount: 3 });
    expect(result.questions[1].type === "short-text" && result.questions[1].terms.some((term) => term.label === "合作" && term.value === 2)).toBe(true);
  });

  it("counts a term once per response so repeated words represent students, not repetition", () => {
    expect(extractSurveyTerms(["协作 协作 协作", "协作让项目更清晰"]).find((term) => term.label === "协作")?.value).toBe(2);
  });
});
