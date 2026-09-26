import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuizQuestion } from '@openmaic/lib/types/stage';

vi.mock('@openmaic/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({
    modelString: 'test-model',
    apiKey: 'test-key',
  }),
}));

import { gradeShortAnswerQuestion, QUIZ_GRADE_API_PATH } from './quiz-grade-client';

describe('quiz grade client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts short answers to the existing namespaced route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ score: 4, comment: '回答准确' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await gradeShortAnswerQuestion({
      id: 'q4',
      type: 'short_answer',
      question: '为什么？',
      points: 5,
    } as QuizQuestion, '因为有证据', 'zh-CN');

    expect(QUIZ_GRADE_API_PATH).toBe('/api/openmaic/quiz-grade');
    expect(fetchMock).toHaveBeenCalledWith('/api/openmaic/quiz-grade', expect.objectContaining({ method: 'POST' }));
    expect(result).toMatchObject({ questionId: 'q4', earned: 4, correct: null, status: 'graded' });
  });

  it('keeps a failed grading request pending without inventing partial credit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await gradeShortAnswerQuestion({
      id: 'q4', type: 'short_answer', question: '为什么？', points: 5,
    } as QuizQuestion, '因为有证据', 'zh-CN');
    expect(result).toMatchObject({ questionId: 'q4', earned: 0, correct: null, status: 'pending' });
  });
});
