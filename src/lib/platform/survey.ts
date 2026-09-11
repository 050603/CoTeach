import { z } from "zod";

export const SurveyOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  allowTextInput: z.boolean().optional(),
});

export const SurveyChartTypeSchema = z.enum(["donut", "bar", "column"]);

export const SurveyQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(500),
  type: z.enum(["single-choice", "multiple-choice", "short-text"]).default("short-text"),
  chartType: SurveyChartTypeSchema.default("donut"),
  required: z.boolean().default(true),
  maxSelections: z.number().int().min(1).max(10).optional(),
  options: z.array(SurveyOptionSchema).max(10).default([]),
}).superRefine((question, context) => {
  if (question.type !== "short-text" && question.options.length < 2) {
    context.addIssue({ code: "custom", message: "选择题至少需要两个选项", path: ["options"] });
  }
  if (question.type === "multiple-choice" && question.chartType === "donut") {
    context.addIssue({ code: "custom", message: "多选题请选择条形图或柱状图", path: ["chartType"] });
  }
  if (question.type !== "multiple-choice" && question.maxSelections !== undefined) {
    context.addIssue({ code: "custom", message: "只有多选题可以设置选择上限", path: ["maxSelections"] });
  }
  if (question.type === "multiple-choice" && question.maxSelections !== undefined && question.maxSelections > question.options.length) {
    context.addIssue({ code: "custom", message: "选择上限不能超过选项数量", path: ["maxSelections"] });
  }
  const optionIds = new Set<string>();
  question.options.forEach((option, index) => {
    if (optionIds.has(option.id)) context.addIssue({ code: "custom", message: "选项标识不能重复", path: ["options", index, "id"] });
    optionIds.add(option.id);
  });
});

export const SurveyConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  content: z.string().max(20_000).default(""),
  questions: z.array(SurveyQuestionSchema).min(1).max(30),
}).passthrough().superRefine((config, context) => {
  const questionIds = new Set<string>();
  config.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) context.addIssue({ code: "custom", message: "题目标识不能重复", path: ["questions", index, "id"] });
    questionIds.add(question.id);
  });
});

export type SurveyConfig = z.infer<typeof SurveyConfigSchema>;
export type SurveyQuestion = z.infer<typeof SurveyQuestionSchema>;
export type SurveyOption = z.infer<typeof SurveyOptionSchema>;
export type SurveyChartType = z.infer<typeof SurveyChartTypeSchema>;
export type SurveyChoiceAnswer = {
  selected: string | string[];
  optionText?: Record<string, string>;
};
export type SurveyAnswer = string | string[] | SurveyChoiceAnswer;

export type SurveyAnalyticsRow = {
  progressData: unknown;
  completedAt?: Date | string | null;
  respondent: SurveyRespondent;
};

export type SurveyRespondent = {
  studentId: string;
  displayName: string;
};

export type SurveyChoiceRespondent = SurveyRespondent & {
  detail?: string;
};

export type SurveyChoiceAnalytics = SurveyQuestion & {
  type: "single-choice" | "multiple-choice";
  responseCount: number;
  options: Array<SurveyOption & { count: number; percentage: number; respondents: SurveyChoiceRespondent[] }>;
};

export type SurveyTextResponse = SurveyRespondent & {
  content: string;
};

export type SurveyTextAnalytics = SurveyQuestion & {
  type: "short-text";
  responseCount: number;
  responses: SurveyTextResponse[];
  terms: Array<{ label: string; value: number; studentIds?: string[] }>;
  keywordStatus?: "processing" | "ready" | "unavailable";
  keywordAnalyzedCount?: number;
  /** Responses with at least one source-verified term in the complete term list. */
  keywordRepresentedCount?: number;
  keywordUnrepresentedResponses?: Array<{
    studentId: string;
    reason: "pending" | "analysis-unavailable" | "no-keywords";
  }>;
  keywordMode?: "local" | "llm";
};

export type SurveyQuestionAnalytics = SurveyChoiceAnalytics | SurveyTextAnalytics;

const SURVEY_ORIENTATION_AND_SUBMISSION_SECONDS = 20;

function estimateSurveyReadingSeconds(text: string): number {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) return 0;

  const hanCharacterCount = normalized.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonHanWordCount = normalized
    .replace(/\p{Script=Han}/gu, " ")
    .match(/[\p{Letter}\p{Number}]+/gu)?.length ?? 0;

  // Approximately 300 Chinese characters or 190 non-CJK words per minute.
  return Math.ceil((hanCharacterCount / 5) + (nonHanWordCount / 3.2));
}

/** Estimate completion time from what the student actually needs to read and answer. */
export function estimateSurveyMinutes(questions: SurveyQuestion[], introduction = ""): number {
  const questionSeconds = questions.reduce((total, question) => {
    const readingText = [question.title, ...question.options.map((option) => option.label)].join(" ");
    const answerSeconds = question.type === "short-text"
      ? 75
      : question.type === "multiple-choice"
        ? 20
        : 12;
    const optionalWeight = question.required === false ? 0.6 : 1;
    const supplementalTextSeconds = question.options.some((option) => option.allowTextInput) ? 12 : 0;

    return total + estimateSurveyReadingSeconds(readingText)
      + Math.ceil((answerSeconds + supplementalTextSeconds) * optionalWeight);
  }, 0);
  const totalSeconds = SURVEY_ORIENTATION_AND_SUBMISSION_SECONDS
    + estimateSurveyReadingSeconds(introduction)
    + questionSeconds;

  return Math.max(1, Math.ceil(totalSeconds / 60));
}

export function selectedSurveyOptionIds(answer: SurveyAnswer | undefined): string[] {
  if (Array.isArray(answer)) return answer;
  if (answer && typeof answer === "object") return Array.isArray(answer.selected) ? answer.selected : answer.selected ? [answer.selected] : [];
  return answer ? [answer] : [];
}

export function surveyAnswerHasValue(answer: SurveyAnswer | undefined): boolean {
  if (answer && typeof answer === "object" && !Array.isArray(answer)) return selectedSurveyOptionIds(answer).length > 0;
  return Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
}

export function surveyTextAnswer(answer: SurveyAnswer | undefined): string {
  return typeof answer === "string" ? answer : "";
}
