import type { QuizQuestion } from '@openmaic/lib/types/stage';

export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect' | 'graded' | 'pending';
  earned: number;
  /** Retained for embedded quizzes whose scene does not expose its questions. */
  points?: number;
  aiComment?: string;
}

export interface QuizScore {
  earned: number;
  possible: number;
  gradedCount: number;
  pendingCount: number;
  /** Unrounded percentage; absent until every question has a valid grade. */
  percentage?: number;
}

/** Authored points, rather than correct-answer counts, define every quiz score. */
export function calculateQuizScore(
  questions: ReadonlyArray<{ id: string; points?: number }>,
  results: ReadonlyArray<Pick<QuestionResult, 'questionId' | 'status' | 'earned'>>,
): QuizScore {
  const byId = new Map(results.map((result) => [result.questionId, result]));
  const score: QuizScore = { earned: 0, possible: 0, gradedCount: 0, pendingCount: 0 };
  for (const question of questions) {
    const points = question.points ?? 1;
    const result = byId.get(question.id);
    if (!Number.isFinite(points) || points <= 0) {
      score.pendingCount += 1;
      continue;
    }
    score.possible += points;
    if (!result || !['correct', 'incorrect', 'graded'].includes(result.status)
      || !Number.isFinite(result.earned) || result.earned < 0 || result.earned > points) {
      score.pendingCount += 1;
      continue;
    }
    score.earned += result.earned;
    score.gradedCount += 1;
  }
  if (score.possible > 0 && score.pendingCount === 0) {
    score.percentage = score.earned / score.possible * 100;
  }
  return score;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

/** Grade choice questions locally. Returns results only for non-short-answer questions. */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      const userAnswer = toArray(answers[q.id]);
      const correctAnswer = toArray(q.answer);
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ('correct' as const) : ('incorrect' as const),
        earned: correct ? pts : 0,
      };
    });
}
