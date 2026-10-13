import type { Scene, QuizQuestion, QuizContent } from '@openmaic/lib/types/stage';
import { ensureScoringRubric } from './rubric';

export const COURSE_QUIZ_SCORING_POLICY = 'course-100-v1' as const;
export type QuizSectionWeight = { outlineId: string; knowledgePointIds?: readonly string[] };

/** Largest-remainder allocation keeps the exact budget and stable question order. */
function allocate(total: number, weights: number[], minimum = 0): number[] {
  const remaining = total - weights.length * minimum;
  if (remaining < 0) throw new Error('QUIZ_SCORE_BUDGET_TOO_SMALL');
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => remaining * weight / sum);
  const values = exact.map((value) => minimum + Math.floor(value));
  let residual = total - values.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, fraction: value % 1 }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const row of order) { if (residual <= 0) break; values[row.index] += 1; residual -= 1; }
  return values;
}

function responseWeight(question: QuizQuestion): number {
  if (question.type === 'matching') return Math.max(1, question.matchingPairs?.length ?? 1);
  if (question.type === 'multiple') return Math.max(1, question.answer?.length ?? 1);
  if (question.type === 'short_answer') return Math.max(1, question.scoringRubric?.criteria.length ?? ensureScoringRubric(question).criteria.length);
  return 1;
}

/** Editing a question changes its share within the existing section budget. */
export function rebalanceSectionQuiz(content: QuizContent): QuizContent {
  if (content.scoring?.policy !== COURSE_QUIZ_SCORING_POLICY || !content.questions.length) return content;
  const budget = content.scoring.sectionPoints;
  const scale = Number.isInteger(budget) && budget >= content.questions.length ? 1 : 100;
  const points = allocate(Math.round(budget * scale), content.questions.map(responseWeight), 1);
  return { ...content, questions: content.questions.map((question, index) => ({ ...question,
    points: points[index] / scale, scoringPolicy: COURSE_QUIZ_SCORING_POLICY,
    ...(question.type === 'short_answer' ? { scoringRubric: question.scoringRubric ?? ensureScoringRubric(question) } : {}),
  })) };
}

/** Sections own their confirmed knowledge coverage; adding a question cannot
 * increase a section's share. Question budgets reflect independently graded decisions. */
export function assignCourseQuizPoints(scenes: readonly Scene[], planned?: readonly QuizSectionWeight[]): Scene[] {
  const quizzes = scenes.filter((scene) => scene.content.type === 'quiz');
  if (!quizzes.length) return [...scenes];
  const sections = planned?.length ? [...planned] : quizzes.map((scene) => ({
    outlineId: scene.outlineId || scene.id,
    knowledgePointIds: scene.knowledgePointIds?.length ? scene.knowledgePointIds
      : scene.content.type === 'quiz' ? scene.content.questions.flatMap((question) => question.knowledgePointIds ?? []) : [],
  }));
  const weights = sections.map((section) => Math.max(1, new Set(section.knowledgePointIds ?? []).size));
  const counts = sections.map((section) => {
    const scene = quizzes.find((scene) => (scene.outlineId || scene.id) === section.outlineId);
    return scene?.content.type === 'quiz' ? scene.content.questions.length : 1;
  });
  let scale = 1;
  let budgets = allocate(100, weights);
  if (budgets.some((budget, index) => budget < counts[index])) {
    scale = 100;
    budgets = allocate(10000, weights);
  }
  return scenes.map((scene) => {
    if (scene.type !== 'quiz' || scene.content.type !== 'quiz') return scene;
    const index = sections.findIndex((section) => section.outlineId === (scene.outlineId || scene.id));
    if (index < 0 || !scene.content.questions.length) return scene;
    const points = allocate(budgets[index], scene.content.questions.map(responseWeight), 1);
    return { ...scene, content: { ...scene.content,
      scoring: { policy: COURSE_QUIZ_SCORING_POLICY, courseTotal: 100, sectionPoints: budgets[index] / scale },
      questions: scene.content.questions.map((question, questionIndex) => ({ ...question,
        points: points[questionIndex] / scale, scoringPolicy: COURSE_QUIZ_SCORING_POLICY,
        ...(question.type === 'short_answer' ? { scoringRubric: ensureScoringRubric(question) } : {}),
      })),
    } };
  });
}
