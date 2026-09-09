import { z } from "zod";

export const SurveyOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
});

export const SurveyQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(500),
  type: z.enum(["single-choice", "short-text"]).default("short-text"),
  required: z.boolean().default(true),
  options: z.array(SurveyOptionSchema).max(10).default([]),
}).superRefine((question, context) => {
  if (question.type === "single-choice" && question.options.length < 2) {
    context.addIssue({ code: "custom", message: "单选题至少需要两个选项", path: ["options"] });
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

export type SurveyAnalyticsRow = {
  progressData: unknown;
  completedAt?: Date | string | null;
};

export type SurveyChoiceAnalytics = SurveyQuestion & {
  type: "single-choice";
  responseCount: number;
  options: Array<SurveyOption & { count: number; percentage: number }>;
};

export type SurveyTextAnalytics = SurveyQuestion & {
  type: "short-text";
  responseCount: number;
  responses: string[];
  terms: Array<{ label: string; value: number }>;
};

export type SurveyQuestionAnalytics = SurveyChoiceAnalytics | SurveyTextAnalytics;

const STOP_WORDS = new Set([
  "一个", "一些", "这个", "那个", "这些", "那些", "我们", "你们", "他们", "自己", "以及", "因为", "所以", "但是", "然后", "可以", "能够", "觉得", "认为", "希望", "需要", "比较", "非常", "还是", "就是", "进行", "通过", "对于", "关于", "没有", "不是", "有点", "课程", "课堂", "学习", "学生", "老师", "问题", "回答",
  "the", "and", "that", "this", "with", "from", "have", "would", "could", "very", "about", "into", "your", "our",
]);

function responseAnswers(progressData: unknown): Record<string, string> {
  if (!progressData || typeof progressData !== "object" || Array.isArray(progressData)) return {};
  const data = progressData as Record<string, unknown>;
  const source = data.submission && typeof data.submission === "object" && !Array.isArray(data.submission)
    ? data.submission as Record<string, unknown>
    : data;
  if (!source.answers || typeof source.answers !== "object" || Array.isArray(source.answers)) return {};
  return Object.fromEntries(Object.entries(source.answers as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key, value.trim()]));
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
  const answers = rows.map((row) => responseAnswers(row.progressData));
  const questions: SurveyQuestionAnalytics[] = config.questions.map((question) => {
    if (question.type === "single-choice") {
      const responseCount = answers.reduce((count, answer) => count + (answer[question.id] ? 1 : 0), 0);
      return {
        ...question,
        type: "single-choice" as const,
        responseCount,
        options: question.options.map((option) => {
          const count = answers.reduce((total, answer) => total + (answer[question.id] === option.id ? 1 : 0), 0);
          return { ...option, count, percentage: responseCount ? Math.round((count / responseCount) * 1000) / 10 : 0 };
        }),
      };
    }
    const responses = answers.map((answer) => answer[question.id]).filter((answer): answer is string => Boolean(answer));
    return { ...question, type: "short-text" as const, responseCount: responses.length, responses, terms: extractSurveyTerms(responses) };
  });
  const submittedCount = rows.length;
  return {
    submittedCount,
    totalStudents,
    completionRate: totalStudents ? Math.round((submittedCount / totalStudents) * 1000) / 10 : 0,
    questions,
  };
}
