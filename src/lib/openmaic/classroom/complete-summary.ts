import type { Scene, SceneType } from '@openmaic/lib/types/stage';
import { calculateQuizScore } from '@openmaic/lib/quiz/grading';
import type { SubmittedState } from '@openmaic/lib/quiz/persistence';
import { roundQuizPoints } from '@openmaic/lib/quiz/rubric';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  quiz: { score: number; total: number; pct?: number; pendingCount: number } | null;
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
  for (const scene of scenes) {
    if (scene.content?.type !== 'quiz') continue;
    const submission = readSubmission(scene.id);
    const summary = calculateQuizScore(scene.content.questions,
      submission?.kind === 'reviewing' ? submission.results : []);
    score += summary.earned;
    total += summary.possible;
    pendingCount += summary.pendingCount;
  }

  score = roundQuizPoints(score);
  total = roundQuizPoints(total);
  const quiz = total > 0 ? { score, total, pendingCount,
    pct: pendingCount ? undefined : Math.round(score / total * 100) } : null;

  return { countsByType, quiz };
}
