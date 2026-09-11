import { describe, expect, it } from "vitest";
import { planSurveyCloud } from "./survey-cloud-layout";

describe("survey cloud sizing", () => {
  it("keeps equal frequencies equal and never fabricates or repeats terms", () => {
    const terms = ["教育公平", "机器人", "育人", "启发", "治理", "伦理边界"].map((label) => ({ label, value: 1 }));
    const layout = planSurveyCloud(terms, 1000, 500, true);
    expect(new Set(layout.map((word) => word.size)).size).toBe(1);
    expect(layout.map(({ text, value }) => ({ label: text, value }))).toEqual(expect.arrayContaining(terms));
    expect(layout).toHaveLength(terms.length);
    expect(layout.every((word) => word.rotate === 0)).toBe(true);
  });

  it("gives genuine frequency differences a visible hierarchy while keeping the leading concept horizontal", () => {
    const layout = planSurveyCloud([{ label: "学习分析", value: 2 }, { label: "教育公平", value: 1 }, { label: "机器人", value: 1 }], 1000, 500, true);
    expect(layout[0]).toMatchObject({ text: "学习分析", value: 2, rotate: 0 });
    expect(layout[0].size).toBeGreaterThan(layout[1].size * 2);
    expect(layout[1].size).toBe(layout[2].size);
  });

  it("adapts to dense and narrow canvases and keeps long phrases horizontal", () => {
    const terms = Array.from({ length: 48 }, (_, index) => ({ label: `完整概念词条${index}`, value: 1 }));
    const compact = planSurveyCloud(terms, 240, 140, false);
    const spacious = planSurveyCloud(terms, 1200, 500, true);
    expect(compact[0].size).toBeLessThan(spacious[0].size);
    expect(compact.every((word) => word.size > 0 && word.rotate === 0)).toBe(true);
    const long = planSurveyCloud([{ label: "人工智能支持跨学科课程设计与学生个性化学习反馈", value: 2 }], 240, 140, false);
    expect(long[0].size * [...long[0].text].length).toBeLessThan(240);
  });

  it("keeps layout decisions stable when polling returns the same terms in a different order", () => {
    const terms = [{ label: "治理", value: 1 }, { label: "学习分析", value: 2 }, { label: "教育公平", value: 1 }];
    expect(planSurveyCloud(terms, 1000, 500, true)).toEqual(planSurveyCloud([...terms].reverse(), 1000, 500, true));
  });
});
