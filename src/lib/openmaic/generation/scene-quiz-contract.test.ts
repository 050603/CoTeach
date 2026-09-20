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
  assessmentUnitIds: ['unit-sampling'],
  assessmentUnitMap: [{ unitId: 'unit-sampling', knowledgePointIds: ['kp-sampling'] }],
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
    expect(result && 'questions' in result ? result.questions[0]?.teachingUnitIds : []).toEqual(['unit-sampling']);
  });

  it('keeps adaptive checks objective when the short-answer allowance is zero', async () => {
    const adaptive = {
      ...outline,
      quizConfig: { difficulty: 'medium' as const, questionCount: 1, questionTypes: ['single' as const, 'true_false' as const], maxShortAnswerQuestions: 0 },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样。', analysis: '公平入样。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));
    const result = await generateSceneContent(adaptive, ai);
    expect(ai.mock.calls[0][1]).toContain('single only');
    expect(result && 'questions' in result ? result.questions[0] : undefined).toMatchObject({
      type: 'short_answer',
      format: 'fill_blank',
      teachingUnitIds: ['unit-sampling'],
    });
  });

  it('repairs one adaptive item into a reasoned response when the model omits it', async () => {
    const adaptive = {
      ...outline,
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'short_answer' as const],
        minShortAnswerQuestions: 1,
        maxShortAnswerQuestions: 1,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '哪项做法能减少选择偏差？', options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }], answer: ['A'], analysis: '随机抽样提供公平入样机会。', knowledgePointIds: ['kp-sampling'], points: 10 },
      { id: 'q2', type: 'single', question: '哪项描述正确？', options: [{ label: '样本应代表总体', value: 'A' }, { label: '只选方便样本', value: 'B' }], answer: ['A'], analysis: '代表性影响推断。', knowledgePointIds: ['kp-sampling'], points: 10 },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('use at least 1 and at most 1');
    expect(questions.filter((question) => question.type === 'short_answer' && question.format === 'short_answer')).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'short_answer', hasAnswer: false });
    expect(questions[0]?.question).toContain('简短说明理由');
    expect(questions[0]).not.toHaveProperty('options');
    expect(questions[0]).not.toHaveProperty('answer');
  });

  it('rejects an incomplete quiz result so the affected page can be retried', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'short_answer', question: '解释随机抽样。', analysis: '公平入样。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));
    await expect(generateSceneContent(outline, ai)).rejects.toThrow('returned 1/2 usable questions');
  });

  it('covers each adaptive teaching-unit target once and keeps matching objective', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      assessmentTargets: [
        { unitId: 'unit-role', knowledgePointId: 'kp-role', unitTitle: '数据角色', learningOutcome: '区分训练与测试' },
        { unitId: 'unit-leak', knowledgePointId: 'kp-leak', unitTitle: '数据泄漏', learningOutcome: '识别泄漏' },
      ],
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'matching', 'true_false'],
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'each-target',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q-leak', type: 'single', format: 'true_false', question: '测试数据参与调参会造成泄漏。',
        answer: true, analysis: '测试信息进入训练会高估泛化效果。',
        teachingUnitIds: ['unit-leak'], knowledgePointIds: ['kp-leak'], points: 10,
      },
      {
        id: 'q-role', type: 'matching', format: 'matching', question: '匹配数据角色与用途。',
        pairs: [
          { left: '训练集', right: '学习参数' },
          { left: '测试集', right: '独立评估' },
        ],
        analysis: '两个集合承担不同职责。',
        teachingUnitIds: ['unit-role'], knowledgePointIds: ['kp-role'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('generate one question for each ordered assessment target');
    expect(questions.map((question) => [question.teachingUnitIds, question.knowledgePointIds])).toEqual([
      [['unit-role'], ['kp-role']],
      [['unit-leak'], ['kp-leak']],
    ]);
    expect(questions[0]).toMatchObject({ id: 'q-role', type: 'matching', format: 'matching' });
  });
});
