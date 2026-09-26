import type { QuizQuestion } from '@openmaic/lib/types/stage';
import type { QuestionResult } from '@openmaic/lib/quiz/grading';
import { getCurrentModelConfig } from '@openmaic/lib/utils/model-config';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('QuizView');
export const QUIZ_GRADE_API_PATH = '/api/openmaic/quiz-grade';

export async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
): Promise<QuestionResult> {
  const pts = q.points ?? 1;
  try {
    const modelConfig = getCurrentModelConfig();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
    };
    if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
    if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

    const res = await fetch(QUIZ_GRADE_API_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        question: q.question,
        userAnswer,
        points: pts,
        commentPrompt: q.commentPrompt,
        language,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as { score: number; comment: string };
    if (typeof data.score !== 'number' || !Number.isFinite(data.score)
      || data.score < 0 || data.score > pts) throw new Error('Invalid quiz grade response');
    const earned = data.score;
    return {
      questionId: q.id,
      correct: null,
      status: 'graded',
      earned,
      aiComment: data.comment,
    };
  } catch (err) {
    log.error('[quiz-view] AI grading failed for', q.id, err);
    return {
      questionId: q.id,
      correct: null,
      status: 'pending',
      earned: 0,
      aiComment: language === 'zh-CN'
        ? '答案已提交，评分服务暂时不可用，请稍后重试批阅。'
        : 'Answer submitted. Grading is unavailable; please retry later.',
    };
  }
}
