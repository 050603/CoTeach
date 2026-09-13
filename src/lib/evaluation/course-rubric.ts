import type { Course, EvaluationPlan, RubricScore } from "@/lib/session/types";
import { DEFAULT_EVALUATION_FLOWS } from "@/lib/session/types";
export class CourseRubricValidationError extends Error {}

export function confirmedCourseRubric(course: Pick<Course, "content">) {
  return course.content.stagePlan?.evaluationRubric;
}

export function courseEvaluationPlan(course: Pick<Course, "content">): EvaluationPlan {
  const rubric = confirmedCourseRubric(course);
  if (!rubric) return { ...course.content.evaluationPlan, flows: DEFAULT_EVALUATION_FLOWS.map((flow) => ({ ...flow, evidenceRequirements: [...flow.evidenceRequirements] })) };
  return { ...course.content.evaluationPlan, rubricId: rubric.id, rubricVersion: rubric.version,
    dimensions: rubric.dimensions.map((dimension) => ({ ...dimension })),
    flows: DEFAULT_EVALUATION_FLOWS.map((flow) => ({ ...flow, weight: flow.sourceRole === "teacher" ? rubric.sourceWeights.teacher : flow.sourceRole === "ai" ? rubric.sourceWeights.ai : 0, evidenceRequirements: [...flow.evidenceRequirements] })),
  };
}

export function weightedDimensionScore(dimensions: Array<{ id: string; weight: number }>, scores?: Record<string, number>): number | undefined {
  if (!scores || dimensions.length === 0 || dimensions.some((dimension) => !Number.isFinite(scores[dimension.id]) || scores[dimension.id] < 0 || scores[dimension.id] > 100)) return undefined;
  if (Math.abs(dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) - 100) > 0.000001) return undefined;
  return Math.round(dimensions.reduce((sum, dimension) => sum + scores[dimension.id] * dimension.weight, 0)) / 100;
}

export function normalizeCourseRubricScore(course: Course, score: RubricScore): RubricScore {
  const previous = course.rubricScores?.find((item) => item.id === score.id);
  // Existing records without a snapshot belong to the legacy scoring contract.
  if (previous && !previous.rubricSnapshot) return score;
  const rubric = previous?.rubricSnapshot ?? confirmedCourseRubric(course);
  if (!rubric) return score;
  const teacherTotal = weightedDimensionScore(rubric.dimensions, score.dimensionScores);
  const aiTotal = weightedDimensionScore(rubric.dimensions, score.aiDimensionScores);
  const complete = (rubric.sourceWeights.teacher === 0 || teacherTotal !== undefined)
    && (rubric.sourceWeights.ai === 0 || aiTotal !== undefined);
  const finalTotal = complete ? Math.round(((teacherTotal ?? 0) * rubric.sourceWeights.teacher + (aiTotal ?? 0) * rubric.sourceWeights.ai)) / 100 : undefined;
  if (score.status !== "draft" && finalTotal === undefined) throw new CourseRubricValidationError("请按已确认量规完成教师评分并确认 AI 建议后再提交。");
  return { ...score, rubricSnapshot: structuredClone(rubric), teacherTotal, aiTotal: aiTotal ?? null, finalTotal,
    total: finalTotal ?? teacherTotal ?? 0, createdAt: previous?.createdAt ?? score.createdAt };
}
