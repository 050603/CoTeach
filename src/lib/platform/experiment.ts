import { z } from "zod";

export const ExperimentPhaseSchema = z.enum(["pretest", "posttest"]);
export type ExperimentPhase = z.infer<typeof ExperimentPhaseSchema>;

export const ExperimentQuestionGroupSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().max(1000).optional(),
}).strict();
export type ExperimentQuestionGroup = z.infer<typeof ExperimentQuestionGroupSchema>;

function hasValidObjectiveAnswer(question: { type: string; options?: string[]; correctAnswer?: string | string[] }): boolean {
  const answer = question.correctAnswer;
  if (question.type === "single-choice") {
    return typeof answer === "string" && answer.trim().length > 0 && (question.options ?? []).includes(answer);
  }
  if (question.type === "multiple-choice") {
    return Array.isArray(answer) && answer.length > 0 && new Set(answer).size === answer.length
      && answer.every((item) => item.trim().length > 0 && (question.options ?? []).includes(item));
  }
  return question.type === "true-false" && (answer === "true" || answer === "false");
}

export const ExperimentQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.enum(["single-choice", "multiple-choice", "true-false", "short-answer", "scale"]),
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
  correctAnswer: z.union([z.string(), z.array(z.string())]).optional(),
  scale: z.object({ min: z.number().int().min(0).max(9), max: z.number().int().min(1).max(10), minLabel: z.string().max(100).optional(), maxLabel: z.string().max(100).optional() }).strict().optional(),
  category: z.enum(["knowledge", "micro-design", "confidence", "collaboration", "other"]).optional(),
  group: ExperimentQuestionGroupSchema.optional(),
  optional: z.boolean().optional(),
  skipReasonRequired: z.boolean().optional(),
}).strict().superRefine((question, context) => {
  if (question.type === "single-choice" || question.type === "multiple-choice") {
    const options = question.options ?? [];
    if (options.length < 2 || new Set(options).size !== options.length) {
      context.addIssue({ code: "custom", message: "选择题需设置至少两个不同选项", path: ["options"] });
    }
    if (question.correctAnswer !== undefined && !hasValidObjectiveAnswer(question)) {
      context.addIssue({ code: "custom", message: "正确答案必须是题目选项中的有效值", path: ["correctAnswer"] });
    }
  } else if (question.type === "true-false" && question.correctAnswer !== undefined && !hasValidObjectiveAnswer(question)) {
    context.addIssue({ code: "custom", message: "判断题正确答案必须为正确或错误", path: ["correctAnswer"] });
  } else if (question.type === "scale" && (!question.scale || question.scale.max <= question.scale.min)) {
    context.addIssue({ code: "custom", message: "量表题需设置有效的最小值和最大值", path: ["scale"] });
  }
  if (question.type === "short-answer" && question.correctAnswer !== undefined && (typeof question.correctAnswer !== "string" || !question.correctAnswer.trim())) {
    context.addIssue({ code: "custom", message: "简答题参考答案不能为空", path: ["correctAnswer"] });
  }
  if (question.type === "scale" && question.correctAnswer !== undefined) {
    context.addIssue({ code: "custom", message: "量表题不设置正确答案", path: ["correctAnswer"] });
  }
});

export const ExperimentConfigSchema = z.object({
  enabled: z.boolean(),
  pretest: z.array(ExperimentQuestionSchema).max(30),
  posttest: z.array(ExperimentQuestionSchema).max(30),
  sharedQuestions: z.array(ExperimentQuestionSchema).max(30).default([]),
  scenarioPair: z.object({ a: ExperimentQuestionSchema, b: ExperimentQuestionSchema }).strict().optional(),
  pretestOrder: z.array(z.string()).optional(),
  posttestOrder: z.array(z.string()).optional(),
  pretestIntroduction: z.string().max(1000).optional(),
  posttestIntroduction: z.string().max(1000).optional(),
  pretestMinutes: z.number().int().min(1).max(120).optional(),
  posttestMinutes: z.number().int().min(1).max(120).optional(),
  skipReasonPrompt: z.string().max(300).optional(),
  randomizeQuestionOrder: z.boolean().default(true),
  randomizeOptionOrder: z.boolean().default(true),
}).strict().superRefine((config, context) => {
  if (config.enabled && (!config.pretest.length && !config.sharedQuestions.length && !config.scenarioPair || !config.posttest.length && !config.sharedQuestions.length && !config.scenarioPair)) {
    context.addIssue({ code: "custom", message: "实验模式需分别配置前测和后测" });
  }
  if (config.scenarioPair && (config.scenarioPair.a.type !== "short-answer" || config.scenarioPair.b.type !== "short-answer" || config.scenarioPair.a.id === config.scenarioPair.b.id)) {
    context.addIssue({ code: "custom", message: "A/B 情境题须为两道不同的简答题", path: ["scenarioPair"] });
  }
  for (const phase of ["pretest", "posttest"] as const) {
    const ids = [...config.sharedQuestions, ...config[phase], ...(config.scenarioPair ? [config.scenarioPair.a, config.scenarioPair.b] : [])].map((question) => question.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: `${phase}题目编号不能重复`, path: [phase] });
  }
  const groups = new Map<string, ExperimentQuestionGroup>();
  for (const question of [...config.sharedQuestions, ...config.pretest, ...config.posttest]) {
    if (!question.group) continue;
    const previous = groups.get(question.group.id);
    if (previous && (previous.title !== question.group.title || (previous.instruction ?? "") !== (question.group.instruction ?? ""))) {
      context.addIssue({ code: "custom", message: "同一题组的标题和作答说明必须一致", path: ["pretest"] });
    }
    groups.set(question.group.id, question.group);
  }
});

export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;
export type ExperimentQuestion = ExperimentConfig["pretest"][number];
export type ExperimentAnswer = string | string[];
export type ExperimentVariant = "none" | "A_PRE_B_POST" | "B_PRE_A_POST";

/** Keep each titled group together while retaining the order of its first question. */
export function groupExperimentQuestions<T extends { group?: ExperimentQuestionGroup }>(questions: T[]) {
  const sections: Array<{ group?: ExperimentQuestionGroup; questions: T[] }> = [];
  const grouped = new Map<string, T[]>();
  for (const question of questions) {
    if (!question.group) {
      sections.push({ questions: [question] });
      continue;
    }
    const existing = grouped.get(question.group.id);
    if (existing) existing.push(question);
    else {
      const members = [question];
      grouped.set(question.group.id, members);
      sections.push({ group: question.group, questions: members });
    }
  }
  return sections;
}

export function composeExperimentForms(config: ExperimentConfig, variant: ExperimentVariant, randomIndex: (upperBound: number) => number) {
  const shuffle = <T>(input: T[]): T[] => {
    const result = [...input];
    for (let index = result.length - 1; index > 0; index--) {
      const selected = randomIndex(index + 1);
      [result[index], result[selected]] = [result[selected], result[index]];
    }
    return result;
  };
  const prepare = (questions: ExperimentQuestion[]) => {
    const items = questions.map((question) => ({
      ...question,
      ...(question.options ? { options: config.randomizeOptionOrder ? shuffle(question.options) : [...question.options] } : {}),
    }));
    const sections = groupExperimentQuestions(items);
    return (config.randomizeQuestionOrder ? shuffle(sections) : sections)
      .flatMap((section) => config.randomizeQuestionOrder ? shuffle(section.questions) : section.questions);
  };
  const scenario = config.scenarioPair;
  const order = (questions: ExperimentQuestion[], ids?: string[]) => {
    if (!ids) return questions;
    const positions = new Map(ids.map((id, index) => [id, index]));
    return [...questions].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  };
  return {
    pretest: order(prepare([...config.sharedQuestions, ...config.pretest, ...(scenario ? [variant === "B_PRE_A_POST" ? scenario.b : scenario.a] : [])]), config.pretestOrder),
    posttest: order(prepare([...config.sharedQuestions, ...config.posttest, ...(scenario ? [variant === "B_PRE_A_POST" ? scenario.a : scenario.b] : [])]), config.posttestOrder),
  };
}

export function experimentConfigFromActivity(config: unknown): ExperimentConfig | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const parsed = ExperimentConfigSchema.safeParse((config as Record<string, unknown>).experiment);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

export function publicExperimentConfig(config: ExperimentConfig | null) {
  if (!config) return null;
  return { enabled: config.enabled, pretest: publicExperimentQuestions(config.pretest), posttest: publicExperimentQuestions(config.posttest), pretestIntroduction: config.pretestIntroduction, posttestIntroduction: config.posttestIntroduction, pretestMinutes: config.pretestMinutes, posttestMinutes: config.posttestMinutes, skipReasonPrompt: config.skipReasonPrompt };
}

export function publicExperimentQuestions(questions: ExperimentQuestion[]) {
  return questions.map(({ id, type, prompt, options, scale, category, group, optional, skipReasonRequired }) => ({
    id, type, prompt, ...(options ? { options } : {}), ...(scale ? { scale } : {}), ...(category ? { category } : {}), ...(group ? { group } : {}), ...(optional ? { optional } : {}), ...(skipReasonRequired ? { skipReasonRequired } : {}),
  }));
}

export function posttestOpenedAt(runtimeConfig: unknown): string | null {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) return null;
  const value = (runtimeConfig as Record<string, unknown>).posttestOpenedAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function isPosttestOpen(status: string, runtimeConfig: unknown): boolean {
  if (posttestOpenedAt(runtimeConfig)) return true;
  // Older finished lessons have no release timestamp. Their final stage still
  // indicates that the teacher reached the posttest before ending the lesson.
  return status.toLowerCase() === "finished"
    && Boolean(runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      && Number((runtimeConfig as Record<string, unknown>).currentStageIndex) >= 4);
}

/** A draft may be incomplete, but every saved value must match its assigned question. */
export function normalizeExperimentDraftAnswers(questions: ExperimentQuestion[], input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const supplied = input as Record<string, unknown>;
  const allowed = new Map(questions.map((question) => [question.id, question]));
  if (Object.keys(supplied).some((id) => !allowed.has(id) && id !== "__skipReason")) return null;
  const answers: Record<string, ExperimentAnswer> = {};
  for (const [id, value] of Object.entries(supplied)) {
    if (id === "__skipReason") {
      if (typeof value !== "string" || value.length > 1000) return null;
      answers[id] = value;
      continue;
    }
    const question = allowed.get(id)!;
    if (question.type === "multiple-choice") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !question.options?.includes(item)) || new Set(value).size !== value.length) return null;
      answers[id] = value;
    } else if (typeof value === "string" && value.length <= 10_000) {
      if (question.type === "single-choice" && value && !question.options?.includes(value)) return null;
      if (question.type === "true-false" && value && value !== "true" && value !== "false") return null;
      if (question.type === "scale" && value && (!/^\d{1,2}$/.test(value) || !question.scale || Number(value) < question.scale.min || Number(value) > question.scale.max)) return null;
      answers[id] = value;
    } else return null;
  }
  return answers;
}

export function publicActivityConfig(config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const { experiment: _experiment, ...safe } = config as Record<string, unknown>;
  void _experiment;
  return safe;
}

export function gradeExperimentAnswers(questions: ExperimentQuestion[], input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const supplied = input as Record<string, unknown>;
  if (Object.keys(supplied).some((id) => id !== "__skipReason" && !questions.some((question) => question.id === id))) return null;
  if (questions.some((question) => question.skipReasonRequired && (supplied[question.id] === undefined || supplied[question.id] === "")) && (typeof supplied.__skipReason !== "string" || !supplied.__skipReason.trim())) return null;
  const answers: Record<string, ExperimentAnswer> = {};
  if (supplied.__skipReason !== undefined) {
    if (typeof supplied.__skipReason !== "string" || supplied.__skipReason.length > 1000) return null;
    answers.__skipReason = supplied.__skipReason.trim();
  }
  let objectiveScore = 0;
  let objectiveTotal = 0;
  for (const question of questions) {
    const answer = supplied[question.id];
    if (question.optional && (answer === undefined || answer === "" || Array.isArray(answer) && !answer.length)) continue;
    if (question.type === "multiple-choice") {
      if (!Array.isArray(answer) || !answer.length || answer.some((item) => typeof item !== "string" || !(question.options ?? []).includes(item)) || new Set(answer).size !== answer.length) return null;
      answers[question.id] = answer;
      if (hasValidObjectiveAnswer(question)) {
        objectiveTotal += 1;
        if (Array.isArray(question.correctAnswer) && answer.length === question.correctAnswer.length && answer.every((item) => (question.correctAnswer as string[]).includes(item))) objectiveScore += 1;
      }
      continue;
    }
    if (typeof answer !== "string" || !answer.trim() || answer.length > 10_000) return null;
    const normalized = answer.trim();
    if (question.type === "single-choice" && !(question.options ?? []).includes(normalized)) return null;
    if (question.type === "true-false" && !["true", "false"].includes(normalized)) return null;
    if (question.type === "scale" && (!question.scale || !/^\d{1,2}$/.test(normalized) || Number(normalized) < question.scale.min || Number(normalized) > question.scale.max)) return null;
    answers[question.id] = normalized;
    if (hasValidObjectiveAnswer(question)) {
      objectiveTotal += 1;
      if (normalized === question.correctAnswer) objectiveScore += 1;
    }
  }
  return { answers, objectiveScore, objectiveTotal };
}
