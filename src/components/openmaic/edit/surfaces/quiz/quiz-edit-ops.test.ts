import { describe, expect, it } from 'vitest';
import type { QuizContent } from '@openmaic/lib/types/stage';
import { createBlankQuestion, setQuestionType } from './quiz-edit-ops';

describe('quiz matching editor operations', () => {
  it('creates a complete two-pair matching structure', () => {
    expect(createBlankQuestion('matching', 'matching-1')).toMatchObject({
      id: 'matching-1',
      type: 'matching',
      format: 'matching',
      answer: ['L1:R1', 'L2:R2'],
      matchingPairs: [
        { leftId: 'L1', rightId: 'R1' },
        { leftId: 'L2', rightId: 'R2' },
      ],
    });
  });

  it('removes matching-only data when the teacher changes the item to a choice question', () => {
    const content: QuizContent = { type: 'quiz', questions: [createBlankQuestion('matching', 'matching-1')] };
    const changed = setQuestionType(content, 'matching-1', 'single').questions[0];

    expect(changed).toMatchObject({ type: 'single', format: 'single_choice', answer: [], hasAnswer: true });
    expect(changed?.matchingPairs).toBeUndefined();
    expect(changed?.options).toHaveLength(2);
  });
});
