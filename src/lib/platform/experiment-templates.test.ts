import { describe, expect, it } from "vitest";
import { prepareExperiment, validateExperiment } from "@/components/platform/experiment-question-builder";
import { EXPERIMENT_QUESTION_LIMIT, ExperimentConfigSchema, composeExperimentForms, gradeExperimentAnswers, groupExperimentQuestions, publicExperimentQuestions } from "./experiment";
import { exportExperimentConfigJson, importExperimentConfigJson, parseExperimentQuestionRows } from "./experiment-bulk";
import { COTEACH_COMMUNITY_REFERENCE, COTEACH_SYSTEM_REFERENCE, COTEACH_TEACHER_REFERENCE, createCoTeachAssessmentTemplate } from "./experiment-templates";

describe("CoTeach knowledge, CoI and C-SUS template", () => {
  it("creates the agreed 9-question pretest and the complete 53-question posttest in document order", () => {
    const config = prepareExperiment(createCoTeachAssessmentTemplate());
    expect(validateExperiment(config)).toBeNull();
    const randomIndex = () => { throw new Error("Document order must not be randomized"); };
    const forms = composeExperimentForms(config, "none", randomIndex);
    expect(forms.pretest).toHaveLength(9);
    expect(forms.posttest).toHaveLength(53);
    expect(forms.posttest.slice(0, 9)).toEqual(forms.pretest);
    expect(groupExperimentQuestions(forms.posttest).map((section) => section.questions.length)).toEqual([9, 13, 9, 12, 10]);
    expect(forms.pretest.every((question) => question.options?.length === 5 && question.options[4] === "不知道")).toBe(true);
    expect(forms.posttest.slice(9).every((question) => question.scale?.min === 1 && question.scale.max === 5 && question.scale.minLabel === "非常不同意" && question.scale.maxLabel === "非常同意")).toBe(true);
    expect(forms.posttest.find((question) => question.id === "CoI15")?.prompt).toBe("CoI15　我能够对一些课程参与者形成清晰的印象。");
    expect(forms.posttest.find((question) => question.id === "S06")?.prompt).toBe("S06　在使用该系统的过程中，我发现很多操作结果和预想功能不一致。");
    expect(config).not.toHaveProperty("scenarioPair");
    expect(config).not.toHaveProperty("posttestMinutes");
    expect(forms.posttest.every((question) => !question.optional && question.correctAnswer === undefined)).toBe(true);
    const answers = Object.fromEntries(forms.posttest.map((question) => [question.id, question.type === "scale" ? "4" : "不知道"]));
    expect(gradeExperimentAnswers(forms.posttest, answers)).toMatchObject({ answers, objectiveTotal: 0 });
  });

  it("preserves all referents through editing preparation, public projection and JSON reuse", () => {
    const config = prepareExperiment(createCoTeachAssessmentTemplate());
    let id = 0;
    const restored = importExperimentConfigJson(exportExperimentConfigJson(config), () => `copied-${++id}`);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const publicQuestions = publicExperimentQuestions(composeExperimentForms(restored.config, "none", () => 0).posttest);
    expect(publicQuestions).toHaveLength(53);
    expect(publicQuestions[9].group?.referenceNote).toBe(COTEACH_TEACHER_REFERENCE);
    expect(publicQuestions[22].group?.referenceNote).toBe(COTEACH_COMMUNITY_REFERENCE);
    expect(publicQuestions[43].group?.referenceNote).toBe(COTEACH_SYSTEM_REFERENCE);
    expect(publicQuestions[43].group?.instruction).toContain("10.1080/10447318.2019.1700644");
    expect(publicQuestions.every((question) => !Object.hasOwn(question, "correctAnswer"))).toBe(true);
    expect(publicQuestions.map((question) => question.prompt)).toEqual([...config.sharedQuestions, ...config.posttest].map((question) => question.prompt));
    expect(publicQuestions[9].id).not.toBe(config.posttest[0].id);
  });

  it("keeps the reusable template independent from edits in an applied draft", () => {
    const draft = createCoTeachAssessmentTemplate();
    draft.sharedQuestions[0].options![0] = "changed";
    draft.posttest[0].group!.referenceNote = "changed";
    const next = createCoTeachAssessmentTemplate();
    expect(next.sharedQuestions[0].options![0]).not.toBe("changed");
    expect(next.posttest[0].group!.referenceNote).toBe(COTEACH_TEACHER_REFERENCE);
  });

  it("accepts all 44 pasted rating items while rejecting combined forms over the shared limit", () => {
    const template = createCoTeachAssessmentTemplate();
    const rows = template.posttest.map((question) => `量表题\t${question.prompt}\t1-5`).join("\n");
    const imported = parseExperimentQuestionRows(rows);
    expect(imported.ok && imported.questions.length).toBe(44);
    const overflow = { ...template, posttest: Array.from({ length: EXPERIMENT_QUESTION_LIMIT - template.sharedQuestions.length + 1 }, (_, index) => ({ id: `rating-${index}`, type: "scale", prompt: "体验", scale: { min: 1, max: 5 } })) };
    expect(ExperimentConfigSchema.safeParse(overflow).success).toBe(false);
    expect(validateExperiment(overflow as typeof template)).toContain(`合计最多 ${EXPERIMENT_QUESTION_LIMIT} 题`);
  });

  it("rejects conflicting reference explanations inside one group", () => {
    const config = createCoTeachAssessmentTemplate();
    config.posttest[1].group = { ...config.posttest[1].group!, referenceNote: "只指真人教师" };
    expect(ExperimentConfigSchema.safeParse(config).success).toBe(false);
    expect(validateExperiment(config)).toContain("指代说明必须一致");
  });
});
