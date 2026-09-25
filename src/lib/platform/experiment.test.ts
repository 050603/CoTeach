import { describe, expect, it } from "vitest";
import { ExperimentConfigSchema, composeExperimentForms, gradeExperimentAnswers, publicActivityConfig, publicExperimentConfig, publicExperimentQuestions } from "./experiment";
import assessmentBackup from "../../../scripts/data/aied-assessment-v3.2.json";

const experiment = {
  enabled: true,
  pretest: [
    { id: "single", type: "single-choice", prompt: "选择", options: ["甲", "乙"], correctAnswer: "乙" },
    { id: "multi", type: "multiple-choice", prompt: "多选", options: ["甲", "乙", "丙"], correctAnswer: ["甲", "丙"] },
    { id: "judge", type: "true-false", prompt: "判断", correctAnswer: "true" },
    { id: "text", type: "short-answer", prompt: "解释" },
  ],
  posttest: [{ id: "post", type: "short-answer", prompt: "总结" }],
} as const;

describe("classroom experiment questions", () => {
  it("keeps the v3.2 parallel forms in document order and enforces skip reasons", () => {
    const config = ExperimentConfigSchema.parse(assessmentBackup.config);
    const a = composeExperimentForms(config, "A_PRE_B_POST", () => 0);
    const b = composeExperimentForms(config, "B_PRE_A_POST", () => 0);
    expect(a.pretest).toHaveLength(12);
    expect(a.posttest).toHaveLength(18);
    expect(a.pretest.map((question) => question.id).slice(0, 3)).toEqual(["pre-background-1", "pre-background-2", "knowledge-1"]);
    expect(a.posttest.map((question) => question.id).slice(8, 11)).toEqual(["post-estimate", "design-b", "experience-11"]);
    expect(b.pretest[11].id).toBe("design-b");
    expect(b.posttest[9].id).toBe("design-a");
    const requiredAnswers = Object.fromEntries(a.posttest.filter((question) => !question.optional).map((question) => [question.id, question.type === "scale" ? "4" : question.type === "short-answer" ? "一段设计" : question.correctAnswer]));
    expect(gradeExperimentAnswers(a.posttest, requiredAnswers)).toBeNull();
    const graded = gradeExperimentAnswers(a.posttest, { ...requiredAnswers, __skipReason: "设备故障" });
    expect(graded).toMatchObject({ objectiveScore: 8, objectiveTotal: 8 });
    expect(graded?.answers).not.toHaveProperty("post-feedback");
  });
  it("requires separately configured assessments and rejects invalid answer keys", () => {
    expect(ExperimentConfigSchema.safeParse(experiment).success).toBe(true);
    expect(ExperimentConfigSchema.safeParse({ ...experiment, posttest: [] }).success).toBe(false);
    expect(ExperimentConfigSchema.safeParse({ ...experiment, pretest: [{ ...experiment.pretest[0], correctAnswer: "丙" }] }).success).toBe(false);
    expect(ExperimentConfigSchema.safeParse({ ...experiment, pretest: [experiment.pretest[0], experiment.pretest[0]] }).success).toBe(false);
  });

  it("accepts choice and judgment questions without a correct answer, but rejects empty or malformed keys", () => {
    const unkeyed = [
      { id: "single", type: "single-choice", prompt: "个人偏好", options: ["甲", "乙"] },
      { id: "multi", type: "multiple-choice", prompt: "可接受的选项", options: ["甲", "乙"] },
      { id: "judge", type: "true-false", prompt: "是否愿意", category: "confidence" },
    ];
    const configured = ExperimentConfigSchema.parse({ ...experiment, pretest: unkeyed });
    expect(configured.pretest.every((question) => question.correctAnswer === undefined)).toBe(true);

    const invalid = [
      { ...unkeyed[0], correctAnswer: "" },
      { ...unkeyed[0], correctAnswer: [] },
      { ...unkeyed[0], correctAnswer: "丙" },
      { ...unkeyed[1], correctAnswer: [] },
      { ...unkeyed[1], correctAnswer: ["甲", "甲"] },
      { ...unkeyed[1], correctAnswer: ["丙"] },
      { ...unkeyed[2], correctAnswer: "" },
      { ...unkeyed[2], correctAnswer: "yes" },
      { id: "text", type: "short-answer", prompt: "说明", correctAnswer: "" },
      { id: "rating", type: "scale", prompt: "信心", scale: { min: 1, max: 5 }, correctAnswer: "5" },
    ];
    for (const question of invalid) {
      expect(ExperimentConfigSchema.safeParse({ ...experiment, pretest: [question] }).success).toBe(false);
    }
  });

  it("keeps correct answers out of every student-facing config", () => {
    const configured = ExperimentConfigSchema.parse(experiment);
    const publicQuestions = publicExperimentConfig(configured);
    expect(publicQuestions?.pretest[0]).toEqual({ id: "single", type: "single-choice", prompt: "选择", options: ["甲", "乙"] });
    expect(JSON.stringify(publicQuestions)).not.toContain("correctAnswer");
    expect(publicActivityConfig({ schemaVersion: 1, experiment: configured, content: "lesson" })).toEqual({ schemaVersion: 1, content: "lesson" });
  });

  it("validates all four answer types and scores only objective questions", () => {
    const configured = ExperimentConfigSchema.parse(experiment);
    expect(gradeExperimentAnswers(configured.pretest, { single: "乙", multi: ["丙", "甲"], judge: "false", text: " 我的解释 " })).toEqual({
      answers: { single: "乙", multi: ["丙", "甲"], judge: "false", text: "我的解释" },
      objectiveScore: 2, objectiveTotal: 3,
    });
    expect(gradeExperimentAnswers(configured.pretest, { single: "乙", multi: ["甲", "甲"], judge: "true", text: "说明" })).toBeNull();
    expect(gradeExperimentAnswers(configured.pretest, { single: "乙", multi: ["甲"], judge: "true", text: "" })).toBeNull();
    expect(gradeExperimentAnswers(configured.pretest, { single: "乙", multi: ["甲"], judge: "true", text: "说明", extra: "注入" })).toBeNull();
  });

  it("records valid responses to unkeyed questions without counting them as objective scores", () => {
    const config = ExperimentConfigSchema.parse({
      ...experiment,
      pretest: [
        { id: "preference", type: "single-choice", prompt: "偏好", options: ["甲", "乙"] },
        { id: "reasons", type: "multiple-choice", prompt: "原因", options: ["甲", "乙", "丙"] },
        { id: "willing", type: "true-false", prompt: "愿意吗" },
        { id: "knowledge", type: "single-choice", prompt: "知识", options: ["甲", "乙"], correctAnswer: "甲" },
      ],
    });
    expect(gradeExperimentAnswers(config.pretest, { preference: "乙", reasons: ["甲", "丙"], willing: "false", knowledge: "甲" })).toEqual({
      answers: { preference: "乙", reasons: ["甲", "丙"], willing: "false", knowledge: "甲" },
      objectiveScore: 1,
      objectiveTotal: 1,
    });
    expect(gradeExperimentAnswers(config.pretest, { preference: "", reasons: ["甲"], willing: "false", knowledge: "甲" })).toBeNull();
    expect(gradeExperimentAnswers(config.pretest, { preference: "甲", reasons: [], willing: "false", knowledge: "甲" })).toBeNull();
    expect(gradeExperimentAnswers(config.pretest, { preference: "甲", reasons: ["甲"], willing: "", knowledge: "甲" })).toBeNull();
  });

  it("counterbalances two scenarios while repeating shared questions and shuffling choices", () => {
    const config = ExperimentConfigSchema.parse({
      enabled: true, pretest: [], posttest: [],
      sharedQuestions: [{ id: "knowledge", type: "single-choice", prompt: "知识题", options: ["甲", "乙", "丙"], correctAnswer: "乙" }],
      scenarioPair: { a: { id: "a", type: "short-answer", prompt: "情境 A" }, b: { id: "b", type: "short-answer", prompt: "情境 B" } },
      randomizeQuestionOrder: true, randomizeOptionOrder: true,
    });
    const a = composeExperimentForms(config, "A_PRE_B_POST", () => 0);
    const b = composeExperimentForms(config, "B_PRE_A_POST", () => 0);
    expect(a.pretest.map((question) => question.id).sort()).toEqual(["a", "knowledge"]);
    expect(a.posttest.map((question) => question.id).sort()).toEqual(["b", "knowledge"]);
    expect(b.pretest.map((question) => question.id).sort()).toEqual(["b", "knowledge"]);
    expect(b.posttest.map((question) => question.id).sort()).toEqual(["a", "knowledge"]);
    expect(a.pretest.find((question) => question.id === "knowledge")?.options).toEqual(["乙", "丙", "甲"]);
    expect(a.posttest.find((question) => question.id === "knowledge")?.correctAnswer).toBe("乙");
  });

  it("accepts a bounded rating without treating it as an objectively graded answer", () => {
    const config = ExperimentConfigSchema.parse({ enabled: true, pretest: [{ id: "confidence", type: "scale", prompt: "信心", scale: { min: 1, max: 5, minLabel: "低", maxLabel: "高" } }], posttest: [{ id: "collaboration", type: "scale", prompt: "协作", scale: { min: 1, max: 5 } }] });
    expect(gradeExperimentAnswers(config.pretest, { confidence: "4" })).toEqual({ answers: { confidence: "4" }, objectiveScore: 0, objectiveTotal: 0 });
    expect(gradeExperimentAnswers(config.pretest, { confidence: "6" })).toBeNull();
  });

  it("keeps grouped ratings together during randomization and retains each answer separately", () => {
    const group = { id: "confidence-group", title: "任务信心", instruction: "请根据现在的感受，\n选择最符合自己的一项。" };
    const config = ExperimentConfigSchema.parse({
      enabled: true,
      sharedQuestions: [
        { id: "confidence-one", type: "scale", prompt: "我能完成任务", scale: { min: 1, max: 5 }, group },
        { id: "other", type: "single-choice", prompt: "知识题", options: ["甲", "乙"] },
        { id: "confidence-two", type: "scale", prompt: "我能解决问题", scale: { min: 1, max: 5 }, group },
      ],
      pretest: [], posttest: [], randomizeQuestionOrder: true, randomizeOptionOrder: true,
    });
    const forms = composeExperimentForms(config, "none", () => 0);
    for (const questions of [forms.pretest, forms.posttest]) {
      const positions = questions.flatMap((question, index) => question.group?.id === group.id ? [index] : []);
      expect(positions[1] - positions[0]).toBe(1);
      expect(questions.find((question) => question.id === "confidence-one")?.group).toEqual(group);
      expect(gradeExperimentAnswers(questions, { "confidence-one": "4", "confidence-two": "2", other: "甲" })).toMatchObject({
        answers: { "confidence-one": "4", "confidence-two": "2", other: "甲" }, objectiveTotal: 0,
      });
    }
    expect(publicExperimentQuestions(forms.pretest).find((question) => question.id === "confidence-one")).toMatchObject({ group });
    expect(ExperimentConfigSchema.safeParse({ ...config, sharedQuestions: [
      config.sharedQuestions[0], { ...config.sharedQuestions[2], group: { ...group, title: "另一标题" } },
    ] }).success).toBe(false);
  });
});
