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
  terms: Array<{ label: string; value: number }>;
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

const STOP_WORDS = new Set([
  "一个", "一些", "这个", "那个", "这些", "那些", "我们", "你们", "他们", "自己", "以及", "因为", "所以", "但是", "然后", "可以", "能够", "觉得", "认为", "希望", "需要", "比较", "非常", "还是", "就是", "进行", "通过", "对于", "关于", "没有", "不是", "有点", "课程", "课堂", "学习", "学生", "老师", "问题", "回答",
  "the", "and", "that", "this", "with", "from", "have", "would", "could", "very", "about", "into", "your", "our",
]);

function normalizeChoiceAnswer(value: Record<string, unknown>): SurveyChoiceAnswer | null {
  const selected = value.selected;
  if (typeof selected !== "string" && !Array.isArray(selected)) return null;
  const normalizedSelected = typeof selected === "string"
    ? selected.trim()
    : [...new Set(selected.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  const rawOptionText = value.optionText;
  const optionText = rawOptionText && typeof rawOptionText === "object" && !Array.isArray(rawOptionText)
    ? Object.entries(rawOptionText as Record<string, unknown>).reduce<Record<string, string>>((details, [optionId, detail]) => {
      if (typeof detail === "string" && detail.trim()) details[optionId] = detail.trim();
      return details;
    }, {})
    : {};
  return { selected: normalizedSelected, ...(Object.keys(optionText).length ? { optionText } : {}) };
}

function responseAnswers(progressData: unknown): Record<string, SurveyAnswer> {
  if (!progressData || typeof progressData !== "object" || Array.isArray(progressData)) return {};
  const data = progressData as Record<string, unknown>;
  const source = data.submission && typeof data.submission === "object" && !Array.isArray(data.submission)
    ? data.submission as Record<string, unknown>
    : data;
  if (!source.answers || typeof source.answers !== "object" || Array.isArray(source.answers)) return {};
  return Object.entries(source.answers as Record<string, unknown>).reduce<Record<string, SurveyAnswer>>((answers, [key, value]) => {
    if (typeof value === "string") answers[key] = value.trim();
    if (Array.isArray(value)) {
      const selections = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
      answers[key] = selections;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const choiceAnswer = normalizeChoiceAnswer(value as Record<string, unknown>);
      if (choiceAnswer) answers[key] = choiceAnswer;
    }
    return answers;
  }, {});
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

function optionDetail(answer: SurveyAnswer | undefined, optionId: string): string | undefined {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  return answer.optionText?.[optionId]?.trim() || undefined;
}

export function extractSurveyTerms(responses: string[], limit = 48): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh-CN", { granularity: "word" })
    : null;

  for (const response of responses) {
    const words = segmenter
      ? [...segmenter.segment(response)].filter((part) => part.isWordLike).map((part) => part.segment)
      : response.match(/[\p{Script=Han}]{1,8}|[\p{Letter}\p{Number}]{2,}/gu) ?? [];
    const unique = new Set(words.map((word) => word.normalize("NFKC").trim().toLocaleLowerCase("zh-CN"))
      .filter((word) => word.length > 0 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)));
    unique.forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1));
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export function buildSurveyAnalytics(configInput: unknown, rows: SurveyAnalyticsRow[], totalStudents: number) {
  const config = SurveyConfigSchema.parse(configInput);
  const respondentAnswers = rows.map((row) => ({ answers: responseAnswers(row.progressData), respondent: row.respondent }));
  const questions: SurveyQuestionAnalytics[] = config.questions.map((question) => {
    if (question.type !== "short-text") {
      const responseCount = respondentAnswers.reduce((count, row) => count + (selectedSurveyOptionIds(row.answers[question.id]).length ? 1 : 0), 0);
      return {
        ...question,
        type: question.type,
        responseCount,
        options: question.options.map((option) => {
          const respondents = respondentAnswers.flatMap((row) => {
            const answer = row.answers[question.id];
            if (!selectedSurveyOptionIds(answer).includes(option.id)) return [];
            const detail = option.allowTextInput ? optionDetail(answer, option.id) : undefined;
            return [{ ...row.respondent, ...(detail ? { detail } : {}) }];
          });
          return { ...option, count: respondents.length, percentage: responseCount ? Math.round((respondents.length / responseCount) * 1000) / 10 : 0, respondents };
        }),
      };
    }
    const responses = respondentAnswers.flatMap((row) => {
      const content = row.answers[question.id];
      return typeof content === "string" && content ? [{ ...row.respondent, content }] : [];
    });
    return { ...question, type: "short-text" as const, responseCount: responses.length, responses, terms: extractSurveyTerms(responses.map((response) => response.content)) };
  });
  const submittedCount = rows.length;
  return {
    submittedCount,
    totalStudents,
    completionRate: totalStudents ? Math.round((submittedCount / totalStudents) * 1000) / 10 : 0,
    questions,
  };
}
