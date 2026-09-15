import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { generateSceneContent } from './scene-generator';

const outline: SceneOutline = {
  id: 'section-check',
  type: 'quiz',
  title: '第一节 · 节末小测',
  description: '检查学生能否解释抽样偏差',
  keyPoints: ['随机抽样减少选择偏差'],
  knowledgePointIds: ['kp-sampling'],
  order: 1,
  quizConfig: {
    difficulty: 'medium',
    questionCount: 2,
    questionTypes: ['short_answer'],
  },
};

describe('section short-answer quiz contract', () => {
  it('prompts for short answers only and repairs a provider type violation', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1',
        type: 'single',
        question: '哪一种方法能减少选择偏差？',
        options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }],
        answer: ['A'],
        analysis: '随机抽样使总体成员有公平的入样机会。',
        knowledgePointIds: ['kp-sampling'],
        points: 10,
      },
      {
        id: 'q2',
        type: 'short_answer',
        question: '解释为什么随机抽样能减少选择偏差。',
        analysis: '应说明公平入样与总体代表性。',
        commentPrompt: '按结论与理由评分。',
        knowledgePointIds: ['kp-sampling'],
        points: 10,
      },
    ]));

    const result = await generateSceneContent(outline, ai);
    expect(ai.mock.calls[0][1]).toContain('every generated question must use type="short_answer"');
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(2);
    expect(result && 'questions' in result ? result.questions.every((question) =>
      question.type === 'short_answer' && !question.options && !question.answer && question.hasAnswer === false,
    ) : false).toBe(true);
    expect(result && 'questions' in result ? result.questions[0]?.knowledgePointIds : []).toEqual(['kp-sampling']);
  });
});
