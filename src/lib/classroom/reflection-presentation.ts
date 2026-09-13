import { courseQuestionSet, latestCourseReflection } from "@/lib/course-reflection";
import {
  latestReflectionByStudent,
  normalizeReflectionSurvey,
  REFLECTION_SURVEY_QUESTIONS,
  REFLECTION_SURVEY_SCALE,
  reflectionSurveyAverage,
  reflectionSurveyDistribution,
} from "@/lib/reflection-survey";
import type {
  Course,
  ReflectionClassSummaryV1,
  ReflectionRecord,
  ReflectionSummaryAnswerField,
  ReflectionSurveyResponseV1,
  ReflectionSurveyScore,
} from "@/lib/session/types";

export type ReflectionPresentationStudent = { id: string; name: string };
export type ReflectionPresentationAnswer = {
  student: ReflectionPresentationStudent;
  reflectionId: string;
  updatedAt: string;
  value: string | ReflectionSurveyScore;
};
export type ReflectionPresentationTerm = {
  label: string;
  count: number;
  students: ReflectionPresentationStudent[];
};
export type ReflectionPresentationAnalysis = {
  status: "waiting" | "partial" | "ready";
  analyzedCount: number;
  pendingCount: number;
  message: string;
};
export type ReflectionPresentationOption = {
  value: ReflectionSurveyScore;
  label: string;
  count: number;
  percent: number;
  students: ReflectionPresentationStudent[];
};
type ScoreKey = "aiHelpfulness" | "systemUsability" | "reuseIntention";
type QuestionBase = {
  title: string;
  responseCount: number;
  answers: ReflectionPresentationAnswer[];
};
export type ReflectionPresentationQuestion = QuestionBase & (
  | { type: "text"; key: string; terms: ReflectionPresentationTerm[]; analysis: ReflectionPresentationAnalysis }
  | { type: "scale"; key: ScoreKey; average: number | null; options: ReflectionPresentationOption[] }
);

type ValidResponse = {
  student: ReflectionPresentationStudent;
  reflection: ReflectionRecord;
  survey: ReflectionSurveyResponseV1;
};

/** Allocate integer percentages while preserving a 100% total for nonempty results. */
function percentages(counts: number[], total: number): number[] {
  if (!total) return counts.map(() => 0);
  const exact = counts.map((count) => count * 100 / total);
  const result = exact.map(Math.floor);
  const remaining = 100 - result.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) result[order[index].index] += 1;
  return result;
}

function answersFor(responses: ValidResponse[], key: ReflectionSummaryAnswerField | ScoreKey): ReflectionPresentationAnswer[] {
  return responses.map(({ student, reflection, survey }) => ({
    student,
    reflectionId: reflection.id,
    updatedAt: reflection.updatedAt,
    value: survey[key],
  }));
}

function textQuestion(
  key: ReflectionSummaryAnswerField,
  responses: ValidResponse[],
  analyzed: Map<string, ValidResponse>,
  summary?: ReflectionClassSummaryV1,
): ReflectionPresentationQuestion {
  const themes = new Map<string, Map<string, ReflectionPresentationStudent>>();
  for (const category of summary?.categories ?? []) {
    for (const term of category.terms) {
      const label = term.label.trim();
      if (!label) continue;
      for (const source of term.sources) {
        const response = analyzed.get(source.studentId);
        if (!response || !source.fields.includes(key)) continue;
        const students = themes.get(label) ?? new Map<string, ReflectionPresentationStudent>();
        students.set(response.student.id, response.student);
        themes.set(label, students);
      }
    }
  }
  const terms = [...themes].map(([label, students]) => ({ label, count: students.size, students: [...students.values()] }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
  const responseCount = responses.length;
  const analyzedCount = analyzed.size;
  const pendingCount = responseCount - analyzedCount;
  const status = !responseCount || !summary || !analyzedCount ? "waiting" : pendingCount ? "partial" : "ready";
  const message = !responseCount
    ? "等待学生提交反思回答。"
    : !summary
      ? "等待班级反思分析。"
      : pendingCount
        ? `已分析 ${analyzedCount} / ${responseCount} 份当前回答，${pendingCount} 份待更新。`
        : terms.length
          ? `已分析全部 ${responseCount} 份当前回答。`
          : `已分析全部 ${responseCount} 份当前回答，暂未形成共同主题。`;
  return {
    type: "text", key, title: REFLECTION_SURVEY_QUESTIONS[key], responseCount,
    answers: answersFor(responses, key), terms,
    analysis: { status, analyzedCount, pendingCount, message },
  };
}

/** Question projection data, grounded in each roster student's current valid response. */
export function buildReflectionPresentation(course: Course, summary?: ReflectionClassSummaryV1): ReflectionPresentationQuestion[] {
  const set = courseQuestionSet(course);
  if (set?.questions.length) return set.questions.map((question): ReflectionPresentationQuestion => {
    const answers = course.students.flatMap((student) => {
      const record = latestCourseReflection(course, student.id);
      const answer = record?.courseReflection?.answers[question.id];
      return record && answer?.trim() ? [{ student: { id: student.id, name: student.name }, reflectionId: record.id, updatedAt: record.updatedAt, value: answer }] : [];
    });
    const analyzed = answers.filter((answer) => summary?.sourceRefs?.some((source) =>
      source.studentId === answer.student.id && source.reflectionId === answer.reflectionId && source.updatedAt === answer.updatedAt,
    ));
    const termsByLabel = new Map<string, Map<string, ReflectionPresentationStudent>>();
    // Course summaries reference the combined learningReflection text. As in
    // survey keyword analytics, require the term to occur in this exact answer
    // before using it in an individual question's cloud.
    for (const category of summary?.categories ?? []) for (const term of category.terms) {
      const label = term.label.trim();
      if (!label) continue;
      const normalized = label.normalize("NFKC").toLocaleLowerCase("zh-CN");
      for (const source of term.sources) {
        if (!source.fields.includes("learningReflection")) continue;
        const answer = analyzed.find((item) => item.student.id === source.studentId);
        if (!answer || !answer.value.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(normalized)) continue;
        const students = termsByLabel.get(label) ?? new Map<string, ReflectionPresentationStudent>();
        students.set(answer.student.id, answer.student);
        termsByLabel.set(label, students);
      }
    }
    const terms = [...termsByLabel].map(([label, students]) => ({ label, count: students.size, students: [...students.values()] }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
    const pendingCount = answers.length - analyzed.length;
    return { type: "text", key: question.id, title: question.prompt, responseCount: answers.length, answers, terms,
      analysis: { status: !analyzed.length ? "waiting" : pendingCount ? "partial" : "ready", analyzedCount: analyzed.length, pendingCount,
        message: !answers.length ? "等待本题回答。" : pendingCount
          ? `已分析 ${analyzed.length} / ${answers.length} 份当前回答，${pendingCount} 份待更新。`
          : terms.length ? `已分析全部 ${answers.length} 份当前回答，关键词均可在本题原文中核对。`
            : "本题暂无可核对的关键词，可查看真实回答。" } };
  });
  const latest = latestReflectionByStudent((course.reflections ?? []).filter((record) => record.courseId === course.id));
  const roster = new Map(course.students.map((student) => [student.id, student]));
  const responses: ValidResponse[] = [];
  for (const student of roster.values()) {
    const reflection = latest.get(student.id);
    const survey = normalizeReflectionSurvey(reflection?.survey);
    // Never fall back to an older survey if the student's latest record is invalid.
    if (reflection && survey) responses.push({ student: { id: student.id, name: student.name }, reflection, survey });
  }
  const analyzed = new Map(responses.filter(({ student, reflection }) => summary?.sourceRefs?.some((source) =>
    source.studentId === student.id && source.reflectionId === reflection.id && source.updatedAt === reflection.updatedAt,
  )).map((response) => [response.student.id, response]));
  const records = responses.map(({ reflection, survey }) => ({ ...reflection, survey }));
  const scaleQuestions = (["aiHelpfulness", "systemUsability", "reuseIntention"] as const).map((key): ReflectionPresentationQuestion => {
    const distribution = reflectionSurveyDistribution(records, key);
    const percents = percentages(REFLECTION_SURVEY_SCALE.map(({ value }) => distribution[value]), responses.length);
    return {
      type: "scale", key, title: REFLECTION_SURVEY_QUESTIONS[key], responseCount: responses.length,
      answers: answersFor(responses, key), average: reflectionSurveyAverage(records, key),
      options: REFLECTION_SURVEY_SCALE.map(({ value, label }, index) => ({
        value, label, count: distribution[value], percent: percents[index],
        students: responses.filter(({ survey }) => survey[key] === value).map(({ student }) => student),
      })),
    };
  });
  return [textQuestion("learningReflection", responses, analyzed, summary), textQuestion("systemReflection", responses, analyzed, summary), ...scaleQuestions];
}
