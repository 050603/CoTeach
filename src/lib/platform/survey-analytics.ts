import { SurveyConfigSchema, selectedSurveyOptionIds, type SurveyAnswer, type SurveyChoiceAnswer, type SurveyAnalyticsRow, type SurveyQuestionAnalytics } from "./survey";

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

function optionDetail(answer: SurveyAnswer | undefined, optionId: string): string | undefined {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  return answer.optionText?.[optionId]?.trim() || undefined;
}

/** Largest remainder allocation in tenths of a percent keeps displayed totals at 100%. */
function choicePercentages(counts: number[]): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return counts.map(() => 0);
  const units = counts.map((count) => Math.floor(count * 1000 / total));
  const ranked = counts.map((count, index) => ({ index, remainder: (count * 1000) % total }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  const remaining = 1000 - units.reduce((sum, count) => sum + count, 0);
  for (let index = 0; index < remaining; index++) units[ranked[index].index]++;
  return units.map((count) => count / 10);
}

export function buildSurveyAnalytics(configInput: unknown, rows: SurveyAnalyticsRow[], totalStudents: number) {
  const config = SurveyConfigSchema.parse(configInput);
  const respondentAnswers = rows.map((row) => ({ answers: responseAnswers(row.progressData), respondent: row.respondent }));
  const questions: SurveyQuestionAnalytics[] = config.questions.map((question) => {
    if (question.type !== "short-text") {
      const validOptionIds = new Set(question.options.map((option) => option.id));
      const responseCount = respondentAnswers.reduce((count, row) => count
        + (selectedSurveyOptionIds(row.answers[question.id]).some((id) => validOptionIds.has(id)) ? 1 : 0), 0);
      const options = question.options.map((option) => {
        const respondents = respondentAnswers.flatMap((row) => {
          const answer = row.answers[question.id];
          if (!selectedSurveyOptionIds(answer).includes(option.id)) return [];
          const detail = option.allowTextInput ? optionDetail(answer, option.id) : undefined;
          return [{ ...row.respondent, ...(detail ? { detail } : {}) }];
        });
        return { ...option, count: respondents.length, respondents };
      });
      const percentages = choicePercentages(options.map((option) => option.count));
      return {
        ...question,
        type: question.type,
        responseCount,
        options: options.map((option, index) => ({ ...option, percentage: percentages[index] })),
      };
    }
    const responses = respondentAnswers.flatMap((row) => {
      const content = row.answers[question.id];
      return typeof content === "string" && content ? [{ ...row.respondent, content }] : [];
    });
    return { ...question, type: "short-text" as const, responseCount: responses.length, responses, terms: [], keywordStatus: responses.length ? "processing" as const : "ready" as const };
  });
  const submittedCount = rows.length;
  return {
    submittedCount,
    totalStudents,
    completionRate: totalStudents ? Math.round((submittedCount / totalStudents) * 1000) / 10 : 0,
    questions,
  };
}
