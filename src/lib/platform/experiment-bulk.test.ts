import { describe, expect, it } from "vitest";
import { ExperimentConfigSchema, ExperimentQuestionSchema } from "./experiment";
import {
  EXPERIMENT_BULK_EXAMPLE,
  exportExperimentConfigJson,
  importExperimentConfigJson,
  parseExperimentQuestionRows,
} from "./experiment-bulk";

function ids() {
  let number = 0;
  return () => `new-${++number}`;
}

describe("experiment question spreadsheet import", () => {
  it("accepts a pasted header, ungraded choices, answer keys, scales, and research dimensions", () => {
    const result = parseExperimentQuestionRows([
      "题型\t题干\t选项或量表范围\t参考答案（可空）\t研究维度",
      "单选题\t我更愿意如何学习？\t独立|协作\t\t学习信心",
      "multiple-choice\t哪些是证据？\t访谈|测试|猜测\tA|2\t知识理解",
      "判断题\t我愿意尝试新的方法\t\t\t协作体验",
      "short-answer\t描述你的设计\t\t教师参考\tmicro-design",
      "量表题\t我有信心完成任务\t1-5|完全没有|非常有\t\t任务信心",
    ].join("\n"), ids());
    expect(result).toEqual({
      ok: true,
      errors: [],
      questions: [
        { id: "new-1", type: "single-choice", prompt: "我更愿意如何学习？", options: ["独立", "协作"], category: "confidence" },
        { id: "new-2", type: "multiple-choice", prompt: "哪些是证据？", options: ["访谈", "测试", "猜测"], correctAnswer: ["访谈", "测试"], category: "knowledge" },
        { id: "new-3", type: "true-false", prompt: "我愿意尝试新的方法", category: "collaboration" },
        { id: "new-4", type: "short-answer", prompt: "描述你的设计", correctAnswer: "教师参考", category: "micro-design" },
        { id: "new-5", type: "scale", prompt: "我有信心完成任务", scale: { min: 1, max: 5, minLabel: "完全没有", maxLabel: "非常有" }, category: "confidence" },
      ],
    });
    if (result.ok) expect(result.questions.every((question) => ExperimentQuestionSchema.safeParse(question).success)).toBe(true);
  });

  it("supports English types, a quoted multiline spreadsheet cell, blank rows, and a default scale", () => {
    const result = parseExperimentQuestionRows('single\t"What changed?\nExplain why."\tred|blue\tblue\tother\n\nscale\tConfidence\t\t\t', ids());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questions[0]).toMatchObject({ prompt: "What changed?\nExplain why.", correctAnswer: "blue" });
    expect(result.questions[1]).toMatchObject({ type: "scale", scale: { min: 1, max: 5 } });
  });

  it("rejects bad rows with their spreadsheet line numbers and no partial import", () => {
    const result = parseExperimentQuestionRows([
      "题型\t题干\t选项\t答案\t维度",
      "单选题\t重复选项\t甲|甲\t\t知识理解",
      "简答题\t\t\t\t",
      "量表题\t量表范围\t6-3\t\t学习信心",
      "单选题\t有效题\t甲|乙\t\t未知维度",
    ].join("\n"), ids());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.questions).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining("第 2 行：选项不能重复"),
      expect.stringContaining("第 3 行：题干不能为空"),
      expect.stringContaining("第 4 行：量表范围"),
      expect.stringContaining("第 5 行：不支持研究维度"),
    ]);
  });

  it("rejects too many questions, blank input, duplicate generated IDs, and malformed answers", () => {
    expect(parseExperimentQuestionRows("  ").ok).toBe(false);
    const tooMany = Array.from({ length: 31 }, (_, index) => `简答题\t问题 ${index + 1}`).join("\n");
    const overflow = parseExperimentQuestionRows(tooMany, ids());
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.errors[0]).toContain("第 31 行");
    const duplicated = parseExperimentQuestionRows("简答题\t问题 1\n简答题\t问题 2", () => "same");
    expect(duplicated.ok).toBe(false);
    const badAnswer = parseExperimentQuestionRows("多选题\t问题\t甲|乙\tA|C", ids());
    expect(badAnswer.ok).toBe(false);
    if (!badAnswer.ok) expect(badAnswer.errors[0]).toContain("第 1 行：参考答案");
  });

  it("ships a pasteable example", () => {
    expect(parseExperimentQuestionRows(EXPERIMENT_BULK_EXAMPLE, ids()).ok).toBe(true);
  });

  it("groups pasted scale rows under one title and inherits the first shared instruction", () => {
    const result = parseExperimentQuestionRows([
      "题型\t题干\t选项或量表范围\t参考答案\t维度\t题组标题\t统一作答说明",
      "量表题\t我能完成任务\t1-5\t\t学习信心\t任务信心\t根据当前感受选择",
      "量表题\t我能解决问题\t1-5\t\t学习信心\t任务信心",
    ].join("\n"), ids());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questions[0].group).toEqual({ id: "new-3", title: "任务信心", instruction: "根据当前感受选择" });
    expect(result.questions[1].group).toEqual(result.questions[0].group);
    expect(parseExperimentQuestionRows("量表题\t题一\t1-5\t\t\t同组\t说明甲\n量表题\t题二\t1-5\t\t\t同组\t说明乙", ids()).ok).toBe(false);
  });
});

describe("experiment configuration backup", () => {
  const config = ExperimentConfigSchema.parse({
    enabled: true,
    sharedQuestions: [{ id: "shared", type: "single-choice", prompt: "知识", options: ["甲", "乙"], correctAnswer: "乙" }],
    pretest: [{ id: "pre", type: "scale", prompt: "信心", scale: { min: 1, max: 5 } }],
    posttest: [{ id: "post", type: "short-answer", prompt: "反思" }],
    scenarioPair: {
      a: { id: "a", type: "short-answer", prompt: "情境 A" },
      b: { id: "b", type: "short-answer", prompt: "情境 B" },
    },
    randomizeQuestionOrder: false,
    randomizeOptionOrder: true,
  });

  it("preserves content and answer keys while assigning fresh IDs in another lesson", () => {
    const result = importExperimentConfigJson(exportExperimentConfigJson(config), ids());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = result.config;
    expect(restored.sharedQuestions[0]).toMatchObject({ id: "new-1", prompt: "知识", correctAnswer: "乙" });
    expect(restored.pretest[0].id).toBe("new-2");
    expect(restored.posttest[0].id).toBe("new-3");
    expect(restored.scenarioPair?.a.id).toBe("new-4");
    expect(restored.scenarioPair?.b.id).toBe("new-5");
    expect(restored.randomizeQuestionOrder).toBe(false);
    expect(restored.randomizeOptionOrder).toBe(true);
    expect(ExperimentConfigSchema.safeParse(restored).success).toBe(true);
    expect(config.sharedQuestions[0].id).toBe("shared");
  });

  it("backs up opinion choices with no answer key", () => {
    const opinionConfig = ExperimentConfigSchema.parse({
      ...config,
      sharedQuestions: [{ id: "opinion", type: "single-choice", prompt: "你更喜欢哪种方式？", options: ["甲", "乙"] }],
      pretest: [{ id: "judgement", type: "true-false", prompt: "我愿意继续参与" }],
    });
    const result = importExperimentConfigJson(exportExperimentConfigJson(opinionConfig), ids());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.sharedQuestions[0].correctAnswer).toBeUndefined();
      expect(result.config.pretest[0].correctAnswer).toBeUndefined();
    }
  });

  it("assigns one new group ID to every copied member while preserving its title and instruction", () => {
    const group = { id: "original-group", title: "任务信心", instruction: "请选择最符合的一项" };
    const grouped = ExperimentConfigSchema.parse({ ...config, pretest: [
      { id: "first", type: "scale", prompt: "题一", scale: { min: 1, max: 5 }, group },
      { id: "second", type: "scale", prompt: "题二", scale: { min: 1, max: 5 }, group },
    ] });
    const result = importExperimentConfigJson(exportExperimentConfigJson(grouped), ids());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copied = result.config.pretest;
    expect(copied[0].group?.id).not.toBe(group.id);
    expect(copied[0].group).toEqual(copied[1].group);
    expect(copied[0].group).toMatchObject({ title: "任务信心", instruction: "请选择最符合的一项" });
  });

  it("rejects invalid, unsupported, and malformed backups", () => {
    expect(importExperimentConfigJson("{", ids())).toMatchObject({ ok: false, errors: [expect.stringContaining("不是有效的 JSON")] });
    expect(importExperimentConfigJson(JSON.stringify({ format: "coteach-experiment", version: 2, config }), ids())).toMatchObject({ ok: false, errors: [expect.stringContaining("不支持")] });
    expect(importExperimentConfigJson(JSON.stringify({ format: "coteach-experiment", version: 1, config: {} }), ids())).toMatchObject({ ok: false, errors: [expect.stringContaining("内容无效")] });
    expect(importExperimentConfigJson(exportExperimentConfigJson(config), () => "duplicate")).toMatchObject({ ok: false, errors: [expect.stringContaining("题目编号有重复")] });
  });
});
