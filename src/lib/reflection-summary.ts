import { courseQuestionSet, latestCourseReflection, latestExperienceSurvey, courseReflectionText } from "@/lib/course-reflection";
import type {
  Course,
  ReflectionClassSummaryV1,
  ReflectionRecord,
  ReflectionSummaryAnswerField,
  ReflectionSummaryCategory,
  ReflectionSummaryCategoryKey,
  ReflectionSummarySource,
  ReflectionSummarySourceRef,
  ReflectionSummaryTerm,
} from "@/lib/session/types";
import { latestReflectionByStudent, normalizeReflectionSurvey } from "@/lib/reflection-survey";

export const REFLECTION_SUMMARY_SCHEMA_VERSION = 1 as const;

export const REFLECTION_SUMMARY_THRESHOLDS = [20, 40, 60, 80, 100] as const;

export const REFLECTION_SUMMARY_CATEGORY_DEFINITIONS = [
  { key: "learning-gains", title: "主要收获", fields: ["learningReflection"] },
  { key: "common-difficulties", title: "常见困难", fields: ["learningReflection", "systemReflection"] },
  { key: "ai-collaboration", title: "AI 协作看法", fields: ["systemReflection"] },
  { key: "course-improvements", title: "课程改进建议", fields: ["systemReflection", "learningReflection"] },
] as const satisfies ReadonlyArray<{
  key: ReflectionSummaryCategoryKey;
  title: string;
  fields: readonly ReflectionSummaryAnswerField[];
}>;

export type ReflectionSummaryTrigger = "threshold" | "course-finished" | "manual";

export type ReflectionSurveyEntry = {
  reflection: ReflectionRecord;
  studentId: string;
  survey: Pick<NonNullable<ReturnType<typeof normalizeReflectionSurvey>>, "learningReflection" | "systemReflection"> & Partial<Pick<NonNullable<ReturnType<typeof normalizeReflectionSurvey>>, "aiHelpfulness" | "systemUsability" | "reuseIntention">>;
};

export type ReflectionSummaryDraft = {
  courseSummary: string;
  teachingRecommendations: string[];
  categories: ReflectionSummaryCategory[];
  studentSummaries: Array<{ studentId: string; summary: string }>;
};

const EMPTY_CATEGORY_SUMMARY = "当前反思中尚未形成明确共识";
const MAX_TERM_COUNT = 16;
const MAX_SOURCE_COUNT_PER_TERM = 1000;
const MAX_STUDENT_SUMMARY_LENGTH = 140;
const MAX_CATEGORY_SUMMARY_LENGTH = 260;
const MAX_COURSE_SUMMARY_LENGTH = 500;
const MAX_RECOMMENDATION_LENGTH = 160;

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isAnswerField(value: unknown): value is ReflectionSummaryAnswerField {
  return value === "learningReflection" || value === "systemReflection";
}

function normalizeSources(value: unknown, allowedStudentIds?: ReadonlySet<string>): ReflectionSummarySource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: ReflectionSummarySource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const studentId = text(candidate.studentId, 120);
    if (!studentId || (allowedStudentIds && !allowedStudentIds.has(studentId))) continue;
    const fields = uniqueStrings(
      (Array.isArray(candidate.fields) ? candidate.fields : [])
        .filter(isAnswerField),
    ) as ReflectionSummaryAnswerField[];
    if (!fields.length || seen.has(studentId)) continue;
    seen.add(studentId);
    sources.push({ studentId, fields });
    if (sources.length >= MAX_SOURCE_COUNT_PER_TERM) break;
  }
  return sources;
}

function normalizeTerms(value: unknown, allowedStudentIds?: ReadonlySet<string>): ReflectionSummaryTerm[] {
  if (!Array.isArray(value)) return [];
  const seenLabels = new Set<string>();
  const terms: ReflectionSummaryTerm[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    const label = text(candidate.label, 32);
    if (!label || seenLabels.has(label)) continue;
    const sources = normalizeSources(candidate.sources, allowedStudentIds);
    if (!sources.length) continue;
    seenLabels.add(label);
    terms.push({ label, sources });
    if (terms.length >= MAX_TERM_COUNT) break;
  }
  return terms;
}

function normalizeCategories(value: unknown, allowedStudentIds?: ReadonlySet<string>): ReflectionSummaryCategory[] {
  const input = Array.isArray(value) ? value : [];
  return REFLECTION_SUMMARY_CATEGORY_DEFINITIONS.map((definition) => {
    const candidate = input.find(
      (item) => item && typeof item === "object" && !Array.isArray(item)
        && (item as Record<string, unknown>).key === definition.key,
    ) as Record<string, unknown> | undefined;
    return {
      key: definition.key,
      title: definition.title,
      summary: text(candidate?.summary, MAX_CATEGORY_SUMMARY_LENGTH) || EMPTY_CATEGORY_SUMMARY,
      terms: normalizeTerms(candidate?.terms, allowedStudentIds),
    };
  });
}

export function latestReflectionSurveyEntries(course: Course): ReflectionSurveyEntry[] {
  if (courseQuestionSet(course)) return course.students.flatMap((student) => {
    const reflection = latestCourseReflection(course, student.id);
    if (!reflection?.courseReflection) return [];
    const experience = latestExperienceSurvey(course, student.id);
    return [{ reflection, studentId: student.id, survey: { learningReflection: courseReflectionText(reflection.courseReflection),
      systemReflection: experience?.systemReflection ?? "", aiHelpfulness: experience?.aiHelpfulness,
      systemUsability: experience?.systemUsability, reuseIntention: experience?.reuseIntention } }];
  });
  const latest = latestReflectionByStudent(course.reflections);
  return course.students.flatMap((student) => {
    const reflection = latest.get(student.id);
    const survey = normalizeReflectionSurvey(reflection?.survey);
    return reflection && survey ? [{ reflection, studentId: student.id, survey }] : [];
  });
}

export function reflectionSummaryMinimumSampleSize(totalStudentCount: number): number {
  return Math.min(3, Math.max(0, totalStudentCount));
}

export function reflectionSummaryCoverage(course: Course): {
  responseCount: number;
  totalStudentCount: number;
  coveragePercent: number;
  coverageBucket: ReflectionClassSummaryV1["coverageBucket"];
} {
  const totalStudentCount = course.students.length;
  const responseCount = latestReflectionSurveyEntries(course).length;
  const coveragePercent = totalStudentCount
    ? Math.min(100, Math.round((responseCount / totalStudentCount) * 100))
    : 0;
  let coverageBucket: ReflectionClassSummaryV1["coverageBucket"] = 0;
  for (const threshold of REFLECTION_SUMMARY_THRESHOLDS) {
    if (coveragePercent >= threshold) coverageBucket = threshold as ReflectionClassSummaryV1["coverageBucket"];
  }
  return { responseCount, totalStudentCount, coveragePercent, coverageBucket };
}

export function reflectionSummarySourceRefs(course: Course): ReflectionSummarySourceRef[] {
  return latestReflectionSurveyEntries(course)
    .map(({ reflection, studentId }) => ({
      reflectionId: reflection.id,
      studentId,
      updatedAt: reflection.updatedAt,
    }))
    .sort((left, right) => left.studentId.localeCompare(right.studentId));
}

export function reflectionSummarySourceRevision(course: Course): string {
  return reflectionSummarySourceRefs(course)
    .map((source) => `${source.studentId}:${source.reflectionId}:${source.updatedAt}`)
    .join("|");
}

export function reflectionClassSummaryIsStale(
  summary: ReflectionClassSummaryV1 | undefined,
  course: Course,
): boolean {
  if (!summary) return true;
  const current = reflectionSummarySourceRefs(course);
  if (current.length !== summary.sourceRefs.length) return true;
  return current.some((source, index) => {
    const previous = summary.sourceRefs[index];
    return previous?.reflectionId !== source.reflectionId
      || previous.studentId !== source.studentId
      || previous.updatedAt !== source.updatedAt;
  });
}

export function reflectionSummaryAutoTrigger(
  course: Course,
  summary: ReflectionClassSummaryV1 | undefined,
): ReflectionSummaryTrigger | undefined {
  const coverage = reflectionSummaryCoverage(course);
  if (coverage.responseCount < reflectionSummaryMinimumSampleSize(course.students.length)) return undefined;
  if (
    course.status === "finished"
    && (!summary || reflectionClassSummaryIsStale(summary, course) || summary.coverageBucket !== 100 || summary.trigger !== "course-finished")
  ) {
    return "course-finished";
  }
  if (coverage.coverageBucket > (summary?.coverageBucket ?? 0)) return "threshold";
  return undefined;
}

export function normalizeReflectionSummaryDraft(
  value: unknown,
  allowedStudentIds: ReadonlySet<string>,
): ReflectionSummaryDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const courseSummary = text(candidate.courseSummary, MAX_COURSE_SUMMARY_LENGTH);
  const teachingRecommendations = uniqueStrings(
    (Array.isArray(candidate.teachingRecommendations) ? candidate.teachingRecommendations : [])
      .map((item) => text(item, MAX_RECOMMENDATION_LENGTH))
      .filter(Boolean),
  ).slice(0, 20);
  if (!courseSummary) return undefined;

  const studentSummaries = uniqueStrings(
    (Array.isArray(candidate.studentSummaries) ? candidate.studentSummaries : [])
      .flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const studentId = text(row.studentId, 120);
        const summary = text(row.summary, MAX_STUDENT_SUMMARY_LENGTH);
        return studentId && summary && allowedStudentIds.has(studentId) ? [`${studentId}\u0000${summary}`] : [];
      }),
  ).map((item) => {
    const separator = item.indexOf("\u0000");
    return { studentId: item.slice(0, separator), summary: item.slice(separator + 1) };
  });

  return {
    courseSummary,
    teachingRecommendations,
    categories: normalizeCategories(candidate.categories, allowedStudentIds),
    studentSummaries,
  };
}

export function normalizeReflectionClassSummary(
  value: unknown,
  allowedStudentIds?: ReadonlySet<string>,
): ReflectionClassSummaryV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== REFLECTION_SUMMARY_SCHEMA_VERSION) return undefined;
  const trigger = candidate.trigger;
  if (trigger !== "threshold" && trigger !== "course-finished" && trigger !== "manual") return undefined;
  const courseSummary = text(candidate.courseSummary, MAX_COURSE_SUMMARY_LENGTH);
  const generatedAt = text(candidate.generatedAt, 80);
  const rawSourceRefs = Array.isArray(candidate.sourceRefs)
    ? candidate.sourceRefs.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const reflectionId = text(row.reflectionId, 160);
        const studentId = text(row.studentId, 120);
        const updatedAt = text(row.updatedAt, 80);
        return reflectionId && studentId && updatedAt && (!allowedStudentIds || allowedStudentIds.has(studentId))
          ? [{ reflectionId, studentId, updatedAt }]
          : [];
      })
    : [];
  const seenSourceStudents = new Set<string>();
  const sourceRefs = rawSourceRefs
    .filter((source) => {
      if (seenSourceStudents.has(source.studentId)) return false;
      seenSourceStudents.add(source.studentId);
      return true;
    })
    .sort((left, right) => left.studentId.localeCompare(right.studentId));
  const responseCount = Math.max(0, Math.floor(Number(candidate.responseCount) || 0));
  const totalStudentCount = Math.max(0, Math.floor(Number(candidate.totalStudentCount) || 0));
  const sourceRevision = text(candidate.sourceRevision, 4_000)
    || sourceRefs.map((source) => `${source.studentId}:${source.reflectionId}:${source.updatedAt}`).join("|");
  const coveragePercent = Math.min(100, Math.max(0, Math.round(Number(candidate.coveragePercent) || 0)));
  const coverageBucket = REFLECTION_SUMMARY_THRESHOLDS.includes(candidate.coverageBucket as typeof REFLECTION_SUMMARY_THRESHOLDS[number])
    ? candidate.coverageBucket as ReflectionClassSummaryV1["coverageBucket"]
    : 0;
  const teachingRecommendations = uniqueStrings(
    (Array.isArray(candidate.teachingRecommendations) ? candidate.teachingRecommendations : [])
      .map((item) => text(item, MAX_RECOMMENDATION_LENGTH))
      .filter(Boolean),
  ).slice(0, 20);
  if (!courseSummary || !generatedAt) return undefined;

  return {
    schemaVersion: 1,
    generatedAt,
    coveragePercent,
    coverageBucket,
    trigger,
    responseCount,
    totalStudentCount,
    sourceRevision,
    sourceRefs,
    courseSummary,
    teachingRecommendations,
    categories: normalizeCategories(candidate.categories, allowedStudentIds),
    studentSummaries: Array.isArray(candidate.studentSummaries)
      ? candidate.studentSummaries.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const row = item as Record<string, unknown>;
          const studentId = text(row.studentId, 120);
          const summary = text(row.summary, MAX_STUDENT_SUMMARY_LENGTH);
          return studentId && summary && (!allowedStudentIds || allowedStudentIds.has(studentId))
            ? [{ studentId, summary }]
            : [];
        })
      : [],
  };
}
