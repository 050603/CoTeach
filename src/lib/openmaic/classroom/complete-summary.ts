import type { Scene, SceneType } from '@openmaic/lib/types/stage';
import { calculateQuizScore } from '@openmaic/lib/quiz/grading';
import type { SubmittedState } from '@openmaic/lib/quiz/persistence';
import { roundQuizPoints } from '@openmaic/lib/quiz/rubric';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  quiz: { score: number; total: number; pct?: number; pendingCount: number } | null;
  assessment: {
    questionCount: number;
    submittedCount: number;
    gradedCount: number;
    correctCount: number;
    pendingCount: number;
    unsubmittedCount: number;
    reviewCount: number;
    reviewSceneId: string;
  } | null;
}

export type SubmissionReader = (sceneId: string) => SubmittedState;

export function summarizeScenes(scenes: Scene[], readSubmission: SubmissionReader): CompleteSummary {
  const countsByType: Partial<Record<SceneType, number>> = {};
  for (const scene of scenes) {
    countsByType[scene.type] = (countsByType[scene.type] ?? 0) + 1;
  }

  let score = 0;
  let total = 0;
  let pendingCount = 0;
  let questionCount = 0;
  let submittedCount = 0;
  let gradedCount = 0;
  let correctCount = 0;
  let reviewCount = 0;
  let firstQuizId: string | undefined;
  let unsubmittedSceneId: string | undefined;
  let pendingSceneId: string | undefined;
  let reviewSceneId: string | undefined;
  for (const scene of scenes) {
    if (scene.content?.type !== 'quiz') continue;
    if (scene.content.questions.length === 0) continue;
    firstQuizId ??= scene.id;
    const submission = readSubmission(scene.id);
    const results = submission?.kind === 'reviewing' ? submission.results : [];
    const summary = calculateQuizScore(scene.content.questions,
      results);
    score += summary.earned;
    total += summary.possible;
    pendingCount += summary.pendingCount;
    questionCount += scene.content.questions.length;
    gradedCount += summary.gradedCount;
    if (submission) submittedCount += scene.content.questions.length;
    else unsubmittedSceneId ??= scene.id;
    if (summary.pendingCount > 0 && submission) pendingSceneId ??= scene.id;
    const resultsById = new Map(results.map((result) => [result.questionId, result]));
    for (const question of scene.content.questions) {
      const result = resultsById.get(question.id);
      const grade = calculateQuizScore([question], result ? [result] : []);
      if (grade.gradedCount === 0) continue;
      if (grade.earned === grade.possible) correctCount += 1;
      else {
        reviewCount += 1;
        reviewSceneId ??= scene.id;
      }
    }
  }

  score = roundQuizPoints(score);
  total = roundQuizPoints(total);
  const quiz = total > 0 ? { score, total, pendingCount,
    pct: pendingCount ? undefined : Math.round(score / total * 100) } : null;

  return {
    countsByType,
    quiz,
    assessment: firstQuizId ? {
      questionCount,
      submittedCount,
      gradedCount,
      correctCount,
      pendingCount: submittedCount - gradedCount,
      unsubmittedCount: questionCount - submittedCount,
      reviewCount,
      reviewSceneId: unsubmittedSceneId ?? pendingSceneId ?? reviewSceneId ?? firstQuizId,
    } : null,
  };
}
