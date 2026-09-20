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
    questionCount: 1,
    questionTypes: ['short_answer'],
    minShortAnswerQuestions: 1,
    maxShortAnswerQuestions: 1,
    coveragePolicy: 'section-synthesis',
  },
};

describe('section short-answer quiz contract', () => {
  it('prompts for short answers only and repairs a provider type violation', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1',
      type: 'single',
      question: '哪一种方法能减少选择偏差？',
      options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }],
      answer: ['A'],
      analysis: '随机抽样使总体成员有公平的入样机会。',
      knowledgePointIds: ['kp-sampling'],
      points: 10,
    }]));

    const result = await generateSceneContent(outline, ai);
    expect(ai.mock.calls[0][1]).toContain('every generated question must use type="short_answer"');
    expect(ai.mock.calls[0][1]).toContain('single comprehensive short-answer question');
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(1);
    expect(result && 'questions' in result ? result.questions.every((question) =>
      question.type === 'short_answer' && !question.options && !question.answer && question.hasAnswer === false,
    ) : false).toBe(true);
    expect(result && 'questions' in result ? result.questions[0]?.knowledgePointIds : []).toEqual(['kp-sampling']);
    expect(result && 'questions' in result ? result.questions[0]?.teachingUnitIds : []).toEqual(['unit-sampling']);
  });

  it('keeps normal-mode checks lightweight when the short-answer allowance is zero', async () => {
    const adaptive = {
      ...outline,
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样。', analysis: '公平入样。',
        knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'single', question: '哪项属于随机抽样？',
        options: [{ label: '随机抽取学号', value: 'A' }, { label: '只问前排', value: 'B' }],
        answer: ['A'], analysis: '随机抽取学号让成员有公平机会。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ]));
    const result = await generateSceneContent(adaptive, ai);
    expect(ai.mock.calls[0][1]).toContain('use at least 0 and at most 0');
    expect(result && 'questions' in result ? result.questions[0] : undefined).toMatchObject({
      type: 'short_answer',
      format: 'fill_blank',
      teachingUnitIds: ['unit-sampling'],
    });
    expect(result && 'questions' in result
      ? result.questions.filter((question) => question.format === 'short_answer' || question.format === 'scenario_task')
      : []).toHaveLength(0);
  });

  it('requires the complete normal-mode question set to cover every section knowledge point', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '哪一组数据用于学习参数？', options: [{ label: '训练集', value: 'A' }, { label: '测试集', value: 'B' }], answer: ['A'], analysis: '训练集用于学习参数。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试数据参与调参会造成数据泄漏。', answer: true, analysis: '独立测试信息不能进入调参。', knowledgePointIds: ['kp-leak'], points: 10 },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('cover every allowed knowledgePointId at least once');
    expect(new Set(questions.flatMap((question) => question.knowledgePointIds ?? []))).toEqual(new Set(['kp-role', 'kp-leak']));
    expect(questions.filter((question) => question.format === 'short_answer' || question.format === 'scenario_task')).toHaveLength(0);
  });

  it('rejects an incomplete quiz result so the affected page can be retried', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([]));
    await expect(generateSceneContent(outline, ai)).rejects.toThrow('returned 0/1 usable questions');
  });

  it('rejects a normal-mode result that leaves a section knowledge point untested', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'true_false', 'fill_blank', 'matching'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'true_false', format: 'true_false', question: '训练集用于学习参数。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试集用于独立评估。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
    ]));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow('does not cover knowledge points: kp-leak');
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
